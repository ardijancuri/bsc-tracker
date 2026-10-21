import type { Pool, PoolClient } from 'pg';

/** Only tables whose production callers have been retired belong here.
 * Evidence, accounting snapshots and the old unique journal receipts do not. */
export const retirementTables = ['backfill_jobs', 'journal_history_jobs', 'journal_pair_preparations',
  'journal_provider_movements', 'launch_observations', 'liquidity_observations', 'node_import_pages'] as const;
export const retirementSchema = 'kollens_retired';
type Database = Pick<Pool, 'connect'>;
type Client = Pick<PoolClient, 'query'>;
type Relation = { name: string; schema: string; oid: string; kind: string };
export type RetirementTableStatus = {
  name: typeof retirementTables[number]; state: 'active' | 'retired' | 'absent' | 'collision';
  publicOid: string | null; retiredOid: string | null; publicRows: string | null; retiredRows: string | null;
};
export type DatabaseRetirementStatus = { archiveSchema: string; tables: RetirementTableStatus[] };
export type DatabaseRetirementResult = DatabaseRetirementStatus & { action: 'retire' | 'restore'; moved: string[] };

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
const qualified = (schema: string, name: string) => `${quote(schema)}.${quote(name)}`;
async function relations(client: Client): Promise<Relation[]> {
  return (await client.query<Relation>(`SELECT c.relname AS name,n.nspname AS schema,c.oid::text AS oid,c.relkind AS kind
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=ANY($1::text[]) AND c.relname=ANY($2::text[]) ORDER BY c.relname,n.nspname`,
  [['public', retirementSchema], [...retirementTables]])).rows;
}
async function rowCount(client: Client, relation: Relation | undefined) {
  if (!relation) return null;
  if (relation.kind !== 'r') throw new Error(`retirement_relation_kind:${relation.schema}.${relation.name}`);
  return String((await client.query(`SELECT count(*)::text AS rows FROM ${qualified(relation.schema, relation.name)}`)).rows[0].rows);
}
async function status(client: Client, found?: Relation[]): Promise<DatabaseRetirementStatus> {
  const current = found ?? await relations(client), tables: RetirementTableStatus[] = [];
  for (const name of retirementTables) {
    const active = current.find(row => row.name === name && row.schema === 'public');
    const retired = current.find(row => row.name === name && row.schema === retirementSchema);
    tables.push({ name, state: active && retired ? 'collision' : active ? 'active' : retired ? 'retired' : 'absent',
      publicOid: active?.oid ?? null, retiredOid: retired?.oid ?? null,
      publicRows: await rowCount(client, active), retiredRows: await rowCount(client, retired) });
  }
  return { archiveSchema: retirementSchema, tables };
}
/** Explicit read-only inspection. No startup path calls these maintenance APIs. */
export async function databaseRetirementStatus(database: Database): Promise<DatabaseRetirementStatus> {
  const client = await database.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout='15s'");
    const result = await status(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function assertNoDependencies(client: Client, moving: Relation[]) {
  if (!moving.length) return;
  const oids = moving.map(row => row.oid);
  const inbound = (await client.query(`SELECT n.nspname||'.'||t.relname AS relation,c.conname AS dependency
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE c.contype='f' AND c.confrelid=ANY($1::oid[]) AND NOT c.conrelid=ANY($1::oid[]) LIMIT 1`, [oids])).rows[0];
  if (inbound) throw new Error(`retirement_incoming_foreign_key:${inbound.relation}:${inbound.dependency}`);
  const view = (await client.query(`SELECT DISTINCT n.nspname||'.'||v.relname AS relation
    FROM pg_depend d JOIN pg_rewrite r ON r.oid=d.objid JOIN pg_class v ON v.oid=r.ev_class
    JOIN pg_namespace n ON n.oid=v.relnamespace
    WHERE d.refclassid='pg_class'::regclass AND d.classid='pg_rewrite'::regclass
      AND d.refobjid=ANY($1::oid[]) AND v.oid<>ALL($1::oid[]) LIMIT 1`, [oids])).rows[0];
  if (view) throw new Error(`retirement_dependent_view:${view.relation}`);
  const trigger = (await client.query(`SELECT t.tgname AS name FROM pg_trigger t
    WHERE t.tgrelid=ANY($1::oid[]) AND NOT t.tgisinternal LIMIT 1`, [oids])).rows[0];
  if (trigger) throw new Error(`retirement_custom_trigger:${trigger.name}`);
  const inheritance = (await client.query(`SELECT inhrelid::text FROM pg_inherits
    WHERE inhrelid=ANY($1::oid[]) OR inhparent=ANY($1::oid[]) LIMIT 1`, [oids])).rows[0];
  if (inheritance) throw new Error('retirement_inheritance_unsupported');
}
async function move(database: Database, action: 'retire' | 'restore'): Promise<DatabaseRetirementResult> {
  const client = await database.connect(), from = action === 'retire' ? 'public' : retirementSchema;
  const to = action === 'retire' ? retirementSchema : 'public';
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='15s'; SET LOCAL idle_in_transaction_session_timeout='20s'");
    // Coordinate with ordinary API/worker schema startup before taking table
    // locks. A second maintenance process cannot race a restore with retirement.
    await client.query('SELECT pg_advisory_xact_lock(782344)');
    await client.query('SELECT pg_advisory_xact_lock(782350)');
    const initial = await relations(client);
    for (const name of retirementTables) {
      if (initial.filter(row => row.name === name).length > 1) throw new Error(`retirement_destination_collision:${name}`);
    }
    if (initial.some(row => row.kind !== 'r')) throw new Error('retirement_relation_kind');
    const moving = initial.filter(row => row.schema === from);
    if (moving.length) {
      await assertNoDependencies(client, moving);
      await client.query(`LOCK TABLE ${moving.map(row => qualified(from, row.name)).join(',')} IN ACCESS EXCLUSIVE MODE`);
      const locked = await relations(client);
      if (JSON.stringify(locked) !== JSON.stringify(initial)) throw new Error('retirement_catalog_changed');
      // Recheck after locking: concurrent dependency DDL must not be overlooked.
      await assertNoDependencies(client, moving);
      const before = new Map<string, string>();
      for (const row of moving) before.set(row.name, (await rowCount(client, row))!);
      if (action === 'retire') await client.query(`CREATE SCHEMA IF NOT EXISTS ${quote(retirementSchema)}`);
      for (const row of moving) await client.query(`ALTER TABLE ${qualified(from, row.name)} SET SCHEMA ${quote(to)}`);
      const after = await relations(client);
      for (const row of moving) {
        const retained = after.find(value => value.name === row.name && value.schema === to);
        if (!retained || retained.oid !== row.oid || await rowCount(client, retained) !== before.get(row.name)
          || after.some(value => value.name === row.name && value.schema === from)) throw new Error(`retirement_preservation_failed:${row.name}`);
      }
    }
    const result = { ...await status(client), action, moved: moving.map(row => row.name) };
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export const retireObsoleteTables = (database: Database) => move(database, 'retire');
export const restoreRetiredTables = (database: Database) => move(database, 'restore');
