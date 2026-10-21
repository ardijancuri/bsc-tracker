import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

type Database = Pick<PoolClient, 'query'>;
export interface MarketCoverageRange {
  fromBlock: string; toBlock: string; fromHash: string; toHash: string; fromAt: string; toAt: string;
  complete?:boolean;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const date = (value: string | Date) => new Date(value).toISOString();
const emptyHash = digest('');
const spanText = (range: MarketCoverageRange) => JSON.stringify([range.complete!==false,range.fromBlock,range.toBlock,range.fromHash,range.toHash,range.fromAt,range.toAt]);
const appendHash = (previous: string, range: MarketCoverageRange) => digest(previous + spanText(range));
const parseRange = (row: any): MarketCoverageRange => ({fromBlock:String(row.from_block),toBlock:String(row.to_block),
  fromHash:String(row.from_hash),toHash:String(row.to_hash),fromAt:date(row.from_at),toAt:date(row.to_at),complete:row.complete!==false});
function validateRange(range: MarketCoverageRange) {
  if (!/^\d+$/.test(range.fromBlock) || !/^\d+$/.test(range.toBlock) || BigInt(range.fromBlock)>BigInt(range.toBlock)
    || !/^0x[a-f0-9]{64}$/.test(range.fromHash) || !/^0x[a-f0-9]{64}$/.test(range.toHash)
    || !Number.isFinite(Date.parse(range.fromAt)) || Date.parse(range.toAt)<Date.parse(range.fromAt)) throw new Error('market_coverage_invalid');
}

/** Membership is immutable and captures exactly the markets queried by this
 * scan. A market discovered later cannot inherit an older cohort's proof. */
export async function persistMarketCoverageCohort(db: Database, marketIds: string[]) {
  const ids=[...new Set(marketIds)].sort();
  if(!ids.length || ids.some(id=>!id || id.length>512)) throw new Error('market_coverage_members_invalid');
  const fingerprint=digest('set:'+JSON.stringify(ids));
  const prior=(await db.query('SELECT market_count FROM node_market_collection_cohorts WHERE fingerprint=$1',[fingerprint])).rows[0];
  if(prior){if(prior.market_count!==ids.length)throw new Error('market_coverage_cohort_mismatch');return fingerprint;}
  // Stable hash buckets reuse untouched member chunks when a new market is
  // discovered. A bucket recursively splits above 64 members, bounding the
  // membership rewritten by a single discovery rather than copying the roster.
  const parts:{fingerprint:string;ids:string[]}[]=[];
  const partition=(entries:{id:string;hash:string}[],depth:number)=>{
    if(entries.length<=64){parts.push({fingerprint:digest('part:'+JSON.stringify(entries.map(row=>row.id))),ids:entries.map(row=>row.id)});return;}
    const buckets=new Map<string,typeof entries>();
    for(const entry of entries){const key=entry.hash[depth]??entry.id;const bucket=buckets.get(key)??[];bucket.push(entry);buckets.set(key,bucket);}
    for(const bucket of buckets.values())partition(bucket,depth+1);
  };
  partition(ids.map(id=>({id,hash:digest(id)})),0);parts.sort((a,b)=>a.fingerprint.localeCompare(b.fingerprint));
  const inserted=(await db.query(`INSERT INTO node_market_collection_cohorts(fingerprint,market_count,kind)
    SELECT fingerprint,member_count,'part' FROM jsonb_to_recordset($1::jsonb) part(fingerprint text,member_count integer)
    ORDER BY fingerprint ON CONFLICT DO NOTHING RETURNING fingerprint`,[JSON.stringify(parts.map(part=>({fingerprint:part.fingerprint,member_count:part.ids.length})))])).rows;
  const newParts=new Set(inserted.map(row=>row.fingerprint));
  const members=parts.filter(part=>newParts.has(part.fingerprint)).flatMap(part=>part.ids.map(id=>({fingerprint:part.fingerprint,id})));
  if(members.length)await db.query(`INSERT INTO node_market_collection_members(cohort_fingerprint,market_id)
    SELECT fingerprint,id FROM jsonb_to_recordset($1::jsonb) member(fingerprint text,id text)`,[JSON.stringify(members)]);
  await db.query(`INSERT INTO node_market_collection_cohorts(fingerprint,market_count,kind,part_fingerprints)
    VALUES($1,$2,'set',$3::text[]) ON CONFLICT DO NOTHING`,[fingerprint,ids.length,parts.map(part=>part.fingerprint)]);
  return fingerprint;
}

export async function persistMarketCoverageRange(db: Database, cohort: string, range: MarketCoverageRange,
  legacy?: {marketId:string;revision:string}) {
  validateRange(range);
  const id=digest(JSON.stringify([cohort,range.fromBlock,range.toBlock,range.complete!==false,legacy?.marketId??null,legacy?.revision??null]));
  const result=await db.query(`INSERT INTO node_market_collection_ranges(id,cohort_fingerprint,from_block,to_block,from_hash,to_hash,from_at,to_at,legacy_market_id,legacy_revision,complete)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id
    WHERE node_market_collection_ranges.cohort_fingerprint=EXCLUDED.cohort_fingerprint
      AND node_market_collection_ranges.from_hash=EXCLUDED.from_hash AND node_market_collection_ranges.to_hash=EXCLUDED.to_hash
      AND node_market_collection_ranges.from_at=EXCLUDED.from_at AND node_market_collection_ranges.to_at=EXCLUDED.to_at RETURNING id`,
  [id,cohort,range.fromBlock,range.toBlock,range.fromHash,range.toHash,range.fromAt,range.toAt,legacy?.marketId??null,legacy?.revision??null,range.complete!==false]);
  if(!result.rowCount)throw new Error('market_coverage_conflict');
  if(!legacy)await persistCoverageEndpoints(db,[{block_number:range.fromBlock,block_hash:range.fromHash,timestamp:range.fromAt},
    {block_number:range.toBlock,block_hash:range.toHash,timestamp:range.toAt}]);
}

async function persistCoverageEndpoints(db:Database,rows:{block_number:string;block_hash:string;timestamp:string}[]) {
  const unique=[...new Map(rows.map(row=>[`${row.block_number}:${row.block_hash}`,row])).values()];
  await db.query(`INSERT INTO node_market_coverage_endpoints(block_number,block_hash,timestamp)
    SELECT block_number,block_hash,timestamp FROM jsonb_to_recordset($1::jsonb) endpoint(block_number bigint,block_hash text,timestamp timestamptz)
    ON CONFLICT DO NOTHING`,[JSON.stringify(unique)]);
}

/** Additive storage. Legacy rows are retained until separately authorized
 * retirement. Triggers invalidate a migration if an older process or repair
 * changes its source; readers then fall back to the untouched legacy proof. */
export async function ensureNodeMarketCoverageSchema(db: Database) {
  await db.query(`
    SELECT pg_advisory_xact_lock(908334);
    CREATE TABLE IF NOT EXISTS node_market_collection_cohorts(
      fingerprint text PRIMARY KEY,market_count integer NOT NULL CHECK(market_count>0),kind text NOT NULL CHECK(kind IN('part','set')),
      part_fingerprints text[] NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS node_market_collection_cohort_parts ON node_market_collection_cohorts USING gin(part_fingerprints) WHERE kind='set';
    CREATE TABLE IF NOT EXISTS node_market_collection_members(
      cohort_fingerprint text NOT NULL REFERENCES node_market_collection_cohorts(fingerprint),
      market_id text NOT NULL REFERENCES node_markets(id),PRIMARY KEY(cohort_fingerprint,market_id));
    CREATE INDEX IF NOT EXISTS node_market_collection_members_market ON node_market_collection_members(market_id,cohort_fingerprint);
    CREATE TABLE IF NOT EXISTS node_market_coverage_migrations(
      market_id text PRIMARY KEY REFERENCES node_markets(id),revision bigint NOT NULL DEFAULT 0,
      state jsonb NOT NULL DEFAULT '{}',completed_at timestamptz,retired_legacy_rows bigint NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS node_market_coverage_endpoints(
      block_number bigint NOT NULL,block_hash text NOT NULL,timestamp timestamptz NOT NULL,PRIMARY KEY(block_number,block_hash));
    CREATE INDEX IF NOT EXISTS node_market_coverage_migrations_pending ON node_market_coverage_migrations(updated_at,market_id) WHERE completed_at IS NULL;
    CREATE TABLE IF NOT EXISTS node_market_collection_ranges(
      id text PRIMARY KEY,cohort_fingerprint text NOT NULL REFERENCES node_market_collection_cohorts(fingerprint),
      from_block bigint NOT NULL,to_block bigint NOT NULL,from_hash text NOT NULL,to_hash text NOT NULL,
      from_at timestamptz NOT NULL,to_at timestamptz NOT NULL,
      legacy_market_id text REFERENCES node_markets(id),legacy_revision bigint,complete boolean NOT NULL DEFAULT true,
      CHECK(from_block>=0 AND to_block>=from_block),CHECK(to_at>=from_at),
      CHECK((legacy_market_id IS NULL)=(legacy_revision IS NULL)));
    CREATE INDEX IF NOT EXISTS node_market_collection_ranges_blocks ON node_market_collection_ranges(cohort_fingerprint,from_block,to_block);
    CREATE INDEX IF NOT EXISTS node_market_collection_ranges_times ON node_market_collection_ranges(cohort_fingerprint,from_at,to_at);
    CREATE INDEX IF NOT EXISTS node_market_collection_ranges_reorg ON node_market_collection_ranges(to_block);
    CREATE INDEX IF NOT EXISTS node_market_collection_ranges_legacy ON node_market_collection_ranges(legacy_market_id,legacy_revision,from_block,to_block,id)
      WHERE legacy_market_id IS NOT NULL;
    CREATE OR REPLACE VIEW node_market_coverage AS
      SELECT m.market_id,r.from_block,r.to_block,r.from_hash,r.to_hash,r.from_at,r.to_at,r.complete
      FROM node_market_collection_members m JOIN node_market_collection_cohorts c ON c.kind='set' AND c.part_fingerprints @> ARRAY[m.cohort_fingerprint]
      JOIN node_market_collection_ranges r ON r.cohort_fingerprint=c.fingerprint
      LEFT JOIN node_market_coverage_migrations migration ON migration.market_id=r.legacy_market_id
      WHERE r.legacy_market_id IS NULL OR migration.revision=r.legacy_revision
      UNION ALL
      SELECT r.market_id,r.from_block,r.to_block,r.from_hash,r.to_hash,r.from_at,r.to_at,r.complete
      FROM node_market_ranges r LEFT JOIN node_market_coverage_migrations migration ON migration.market_id=r.market_id
      WHERE migration.completed_at IS NULL;
    CREATE OR REPLACE FUNCTION node_market_legacy_coverage_changed() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE changed_ids text[];
    BEGIN
      IF TG_OP='UPDATE' THEN
        SELECT array_agg(DISTINCT market_id) INTO changed_ids FROM(
          SELECT market_id FROM changed_market_ranges UNION SELECT market_id FROM changed_new_market_ranges) changed;
      ELSE SELECT array_agg(DISTINCT market_id) INTO changed_ids FROM changed_market_ranges; END IF;
      IF TG_OP='DELETE' AND current_setting('kollens.coverage_prune',true)='validated' THEN RETURN NULL; END IF;
      IF current_setting('kollens.coverage_canonical_repair',true) IS DISTINCT FROM 'true'
        AND EXISTS(SELECT 1 FROM node_market_coverage_migrations s WHERE s.market_id=ANY(changed_ids) AND s.retired_legacy_rows>0)
        THEN RAISE EXCEPTION 'market_legacy_coverage_retired'; END IF;
      INSERT INTO node_market_coverage_migrations(market_id,revision)
      SELECT DISTINCT c.market_id,1 FROM unnest(changed_ids)c(market_id) LEFT JOIN node_market_coverage_migrations s USING(market_id)
        WHERE current_setting('kollens.coverage_canonical_repair',true) IS DISTINCT FROM 'true' OR s.completed_at IS NULL
      ON CONFLICT(market_id) DO UPDATE SET revision=node_market_coverage_migrations.revision+1,state='{}',completed_at=NULL,updated_at=now();
      RETURN NULL;
    END $function$;
    CREATE OR REPLACE FUNCTION node_market_legacy_coverage_lock() RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN PERFORM pg_advisory_xact_lock(908335);RETURN NULL;END $function$;
    CREATE OR REPLACE FUNCTION node_market_coverage_immutable() RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
      IF TG_TABLE_NAME='node_market_collection_ranges' AND current_setting('kollens.coverage_canonical_repair',true)='true'
        THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
      IF TG_OP='INSERT' AND TG_TABLE_NAME='node_market_collection_members' THEN
        IF NOT EXISTS(SELECT 1 FROM node_market_collection_cohorts c JOIN node_market_collection_ranges r ON r.cohort_fingerprint=c.fingerprint
          WHERE c.part_fingerprints @> ARRAY[NEW.cohort_fingerprint]) THEN RETURN NEW; END IF;
      END IF;
      IF TG_OP='INSERT' AND TG_TABLE_NAME='node_market_collection_ranges' THEN
        IF NEW.legacy_market_id IS NULL OR NOT EXISTS(SELECT 1 FROM node_market_coverage_migrations s
          WHERE s.market_id=NEW.legacy_market_id AND s.completed_at IS NOT NULL) THEN RETURN NEW; END IF;
      END IF;
      RAISE EXCEPTION 'market_coverage_immutable';
    END $function$;
    DO $triggers$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='node_market_ranges'::regclass AND tgname='node_market_legacy_coverage_insert') THEN
        CREATE TRIGGER node_market_legacy_coverage_insert AFTER INSERT ON node_market_ranges
          REFERENCING NEW TABLE AS changed_market_ranges FOR EACH STATEMENT EXECUTE FUNCTION node_market_legacy_coverage_changed();
        CREATE TRIGGER node_market_legacy_coverage_delete AFTER DELETE ON node_market_ranges
          REFERENCING OLD TABLE AS changed_market_ranges FOR EACH STATEMENT EXECUTE FUNCTION node_market_legacy_coverage_changed();
      END IF;
    END $triggers$;
    DROP TRIGGER IF EXISTS node_market_legacy_coverage_lock ON node_market_ranges;
    CREATE TRIGGER node_market_legacy_coverage_lock BEFORE INSERT OR UPDATE OR DELETE ON node_market_ranges
      FOR EACH STATEMENT EXECUTE FUNCTION node_market_legacy_coverage_lock();
    DROP TRIGGER IF EXISTS node_market_legacy_coverage_update ON node_market_ranges;
    CREATE TRIGGER node_market_legacy_coverage_update AFTER UPDATE ON node_market_ranges
      REFERENCING OLD TABLE AS changed_market_ranges NEW TABLE AS changed_new_market_ranges
      FOR EACH STATEMENT EXECUTE FUNCTION node_market_legacy_coverage_changed();
    DROP TRIGGER IF EXISTS node_market_collection_ranges_immutable ON node_market_collection_ranges;
    CREATE TRIGGER node_market_collection_ranges_immutable BEFORE INSERT OR UPDATE OR DELETE ON node_market_collection_ranges
      FOR EACH ROW EXECUTE FUNCTION node_market_coverage_immutable();
    DROP TRIGGER IF EXISTS node_market_collection_members_immutable ON node_market_collection_members;
    CREATE TRIGGER node_market_collection_members_immutable BEFORE INSERT OR UPDATE OR DELETE ON node_market_collection_members
      FOR EACH ROW EXECUTE FUNCTION node_market_coverage_immutable();
    DROP TRIGGER IF EXISTS node_market_collection_cohorts_immutable ON node_market_collection_cohorts;
    CREATE TRIGGER node_market_collection_cohorts_immutable BEFORE UPDATE OR DELETE ON node_market_collection_cohorts
      FOR EACH ROW EXECUTE FUNCTION node_market_coverage_immutable();
  `);
}

interface MigrationState {
  stage?:'scan'|'verify'; cursor?:[string,string]; pending?:Partial<Record<'complete'|'incomplete',MarketCoverageRange>>;
  expectedHashes?:Partial<Record<'complete'|'incomplete',string>>;actualHashes?:Partial<Record<'complete'|'incomplete',string>>;
  expectedHash?:string; expectedCount?:number; inputRows?:number;
  maxToBlock?:string;
  verifyCursor?:[string,string,string]; actualHash?:string; actualCount?:number;
}

/** One bounded legacy page or verification page, resumable across restarts and
 * workers. A completed revision is selected only after independently reading
 * back every compacted interval and matching its ordered endpoint checksum. */
export async function backfillNodeMarketCoverage(db: Pick<Pool,'connect'>, options:{limit?:number}={}) {
  const limit=Math.max(1,Math.min(2000,Math.trunc(options.limit??500))),client=await db.connect();
  try {
    await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='5s'");
    await client.query('SELECT pg_advisory_xact_lock_shared(782319)');
    // Do not delay live capture: maintenance joins only an idle writer slot.
    if(!(await client.query('SELECT pg_try_advisory_xact_lock(908335) AS locked')).rows[0].locked){await client.query('ROLLBACK');return {processed:0,completed:false,skipped:true};}
    await client.query(`INSERT INTO node_market_coverage_migrations(market_id)
      SELECT m.id FROM node_markets m WHERE NOT EXISTS(SELECT 1 FROM node_market_coverage_migrations s WHERE s.market_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM node_market_coverage_migrations pending WHERE pending.completed_at IS NULL)
      AND EXISTS(SELECT 1 FROM node_market_ranges r WHERE r.market_id=m.id) ORDER BY m.id LIMIT 1 ON CONFLICT DO NOTHING`);
    const job=(await client.query(`SELECT * FROM node_market_coverage_migrations WHERE completed_at IS NULL
      ORDER BY updated_at,market_id LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
    if(!job){await client.query('COMMIT');return {processed:0,completed:false,idle:true};}
    const state=(job.state??{}) as MigrationState,market=String(job.market_id),revision=String(job.revision);
    let processed=0,complete=false;
    state.pending??={};state.expectedHashes??={};state.actualHashes??={};
    if(state.stage==='verify') {
      const rows=(await client.query(`SELECT * FROM node_market_collection_ranges WHERE legacy_market_id=$1 AND legacy_revision=$2
        AND ($3::bigint IS NULL OR (from_block,to_block,id)>($3::bigint,$4::bigint,$5::text))
        ORDER BY from_block,to_block,id LIMIT $6`,[market,revision,...(state.verifyCursor??[null,null,null]),limit])).rows;
      const expectedCohort=digest('set:'+JSON.stringify([market])),expectedPart=digest('part:'+JSON.stringify([market]));
      if(rows.length){const membership=(await client.query(`SELECT c.market_count,c.part_fingerprints,
        (SELECT array_agg(market_id ORDER BY market_id) FROM node_market_collection_members WHERE cohort_fingerprint=$2) AS members
        FROM node_market_collection_cohorts c WHERE c.fingerprint=$1`,[expectedCohort,expectedPart])).rows[0];
        if(membership?.market_count!==1||JSON.stringify(membership.part_fingerprints)!==JSON.stringify([expectedPart])
          ||JSON.stringify(membership.members)!==JSON.stringify([market]))throw new Error('market_coverage_migration_identity_mismatch');}
      for(const row of rows){if(row.cohort_fingerprint!==expectedCohort)throw new Error('market_coverage_migration_identity_mismatch');
        const key=row.complete?'complete':'incomplete';state.actualHashes[key]=appendHash(state.actualHashes[key]??emptyHash,parseRange(row));state.actualCount=(state.actualCount??0)+1;
        state.verifyCursor=[String(row.from_block),String(row.to_block),String(row.id)];}
      processed=rows.length;
      if(rows.length<limit){state.actualHash=digest((state.actualHashes.complete??emptyHash)+(state.actualHashes.incomplete??emptyHash));
        if(state.actualHash!==state.expectedHash||(state.actualCount??0)!==(state.expectedCount??0))throw new Error('market_coverage_migration_mismatch');
        complete=true;
      }
    } else {
      // Scan the existing primary key once. Filtering a separate incomplete
      // pass could scan millions of complete rows merely to discover zero.
      const rows=(await client.query(`SELECT from_block::text,to_block::text,from_hash,to_hash,from_at,to_at,complete FROM node_market_ranges
        WHERE market_id=$1 AND ($2::bigint IS NULL OR (from_block,to_block)>($2::bigint,$3::bigint))
        ORDER BY from_block,to_block LIMIT $4`,[market,...(state.cursor??[null,null]),limit])).rows;
      const cohort=rows.length||Object.keys(state.pending).length?await persistMarketCoverageCohort(client,[market]):null;
      const flush=async(key:'complete'|'incomplete')=>{const pending=state.pending![key];if(!pending)return;
        await persistMarketCoverageRange(client,cohort!,pending,{marketId:market,revision});
        state.expectedHashes![key]=appendHash(state.expectedHashes![key]??emptyHash,pending);state.expectedCount=(state.expectedCount??0)+1;delete state.pending![key];};
      if(rows.length)await persistCoverageEndpoints(client,rows.flatMap(row=>[
        {block_number:String(row.from_block),block_hash:row.from_hash,timestamp:date(row.from_at)},
        {block_number:String(row.to_block),block_hash:row.to_hash,timestamp:date(row.to_at)}]));
      for(const row of rows){const current=parseRange(row);validateRange(current);const key=current.complete?'complete':'incomplete';
        const previous=state.pending[key];
        if(previous&&(Date.parse(current.fromAt)<Date.parse(previous.fromAt)
          ||BigInt(current.fromBlock)<=BigInt(previous.toBlock)&&Date.parse(current.fromAt)>Date.parse(previous.toAt)
          ||BigInt(current.toBlock)<=BigInt(previous.toBlock)&&Date.parse(current.toAt)>Date.parse(previous.toAt)
          ||BigInt(current.toBlock)>=BigInt(previous.toBlock)&&Date.parse(current.toAt)<Date.parse(previous.toAt)
          ||current.fromBlock===previous.fromBlock&&current.fromAt!==previous.fromAt
          ||current.toBlock===previous.toBlock&&current.toAt!==previous.toAt))throw new Error('market_coverage_legacy_time_conflict');
        if(previous&&BigInt(current.fromBlock)<=BigInt(previous.toBlock)+1n
          &&Date.parse(current.fromAt)<=Date.parse(previous.toAt)+3000){
          if(current.fromBlock===previous.fromBlock&&current.fromHash!==previous.fromHash
            ||current.toBlock===previous.toBlock&&current.toHash!==previous.toHash
            ||current.fromBlock===previous.toBlock&&current.fromHash!==previous.toHash)throw new Error('market_coverage_legacy_conflict');
          if(BigInt(current.toBlock)>BigInt(previous.toBlock))state.pending[key]={...previous,toBlock:current.toBlock,toHash:current.toHash,toAt:current.toAt};
        } else {await flush(key);state.pending[key]=current;}
        state.cursor=[current.fromBlock,current.toBlock];state.inputRows=(state.inputRows??0)+1;
        if(state.maxToBlock===undefined||BigInt(current.toBlock)>BigInt(state.maxToBlock))state.maxToBlock=current.toBlock;
      }
      processed=rows.length;
      if(rows.length<limit){await flush('complete');await flush('incomplete');delete state.cursor;state.stage='verify';
        state.expectedHash=digest((state.expectedHashes.complete??emptyHash)+(state.expectedHashes.incomplete??emptyHash));}
    }
    await client.query(`UPDATE node_market_coverage_migrations SET state=$2::jsonb,completed_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END,
      updated_at=clock_timestamp() WHERE market_id=$1 AND revision=$4`,[market,JSON.stringify(state),complete,revision]);
    await client.query('COMMIT');return {processed,completed:complete,marketId:market,stage:state.stage??'scan'};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

/** Explicit operator maintenance after interval parity passed for this exact
 * source revision. Never touches logs, candles, movements or P&L evidence. */
export async function pruneValidatedLegacyMarketCoverage(db:Pick<Pool,'connect'>,options:{limit?:number}={}) {
  const limit=Math.max(1,Math.min(5000,Math.trunc(options.limit??500))),client=await db.connect();
  try{await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='5s'");
    if(!(await client.query('SELECT pg_try_advisory_xact_lock(908335) AS locked')).rows[0].locked){await client.query('ROLLBACK');return {removed:0,skipped:true};}
    const job=(await client.query(`SELECT s.market_id FROM node_market_coverage_migrations s WHERE s.completed_at IS NOT NULL
      AND EXISTS(SELECT 1 FROM node_market_ranges r WHERE r.market_id=s.market_id) ORDER BY s.updated_at,s.market_id
      LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
    if(!job){await client.query('COMMIT');return {removed:0,idle:true};}
    await client.query("SELECT set_config('kollens.coverage_prune','validated',true)");
    const deleted=await client.query(`WITH selected AS MATERIALIZED(SELECT market_id,from_block,to_block FROM node_market_ranges
      WHERE market_id=$1 ORDER BY from_block,to_block LIMIT $2) DELETE FROM node_market_ranges r USING selected s
      WHERE r.market_id=s.market_id AND r.from_block=s.from_block AND r.to_block=s.to_block`,[job.market_id,limit]);
    await client.query(`UPDATE node_market_coverage_migrations SET retired_legacy_rows=retired_legacy_rows+$2,updated_at=clock_timestamp()
      WHERE market_id=$1`,[job.market_id,deleted.rowCount]);await client.query('COMMIT');return {removed:deleted.rowCount??0,marketId:String(job.market_id)};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

/** Canonical interior endpoints come from permanent headers. Original range
 * endpoints also support old proofs captured before header persistence. */
/** Only a full parity-validated source scan certifies a legacy upper bound.
 * Collector scalar hints and current node checkpoints are deliberately not
 * used: targeted legacy backfills may have run ahead of those checkpoints. */
async function legacyCoverageCandidates(db:Database,from:number) {
  return (await db.query(`SELECT m.id FROM node_markets m LEFT JOIN node_market_coverage_migrations s ON s.market_id=m.id
    WHERE s.completed_at IS NULL OR NOT(s.retired_legacy_rows>=COALESCE((s.state->>'inputRows')::bigint,0)
      AND s.state ? 'inputRows') AND (s.state->>'maxToBlock' IS NULL OR (s.state->>'maxToBlock')::bigint>=$1)
    ORDER BY m.id`,[from])).rows.map(row=>String(row.id));
}

export async function affectedMarketCoverageMarkets(db:Database,from:number) {
  const candidates=await legacyCoverageCandidates(db,from);
  return (await db.query(`WITH affected_cohorts AS MATERIALIZED(SELECT DISTINCT cohort_fingerprint FROM node_market_collection_ranges WHERE to_block>=$1)
    SELECT DISTINCT member.market_id FROM affected_cohorts r JOIN node_market_collection_cohorts c ON c.fingerprint=r.cohort_fingerprint
      JOIN node_market_collection_members member ON c.part_fingerprints @> ARRAY[member.cohort_fingerprint]
    UNION SELECT market_id FROM node_market_ranges WHERE market_id=ANY($2::text[]) AND to_block>=$1`,[from,candidates])).rows.map(row=>String(row.market_id));
}

async function coverageBoundary(db:Database,height:string,direction:'before'|'after',legacyMarkets:string[]) {
  const capabilities=(await db.query(`SELECT to_regclass('node_evidence_blocks') IS NOT NULL AS headers,
    to_regclass('node_market_coverage_endpoints') IS NOT NULL AS endpoints,
    to_regclass('node_market_coverage') IS NOT NULL AS shared`)).rows[0];
  const sources=[...(capabilities.headers?['SELECT block_number,block_hash,timestamp FROM node_evidence_blocks']:[]),
    ...(capabilities.endpoints?['SELECT block_number,block_hash,timestamp FROM node_market_coverage_endpoints']:[]),
    `SELECT from_block,from_hash,from_at FROM node_market_ranges WHERE market_id=ANY($2::text[])`,
    `SELECT to_block,to_hash,to_at FROM node_market_ranges WHERE market_id=ANY($2::text[])`];
  const exactHeader=capabilities.headers?(await db.query('SELECT block_number::text,block_hash,timestamp FROM node_evidence_blocks WHERE block_number=$1',[height])).rows[0]:null;
  if(exactHeader)return {number:String(exactHeader.block_number),hash:String(exactHeader.block_hash),at:date(exactHeader.timestamp)};
  const exactEndpoint=capabilities.endpoints?(await db.query(`SELECT min(block_hash) AS hash,min(timestamp) AS at FROM node_market_coverage_endpoints
    WHERE block_number=$1 HAVING count(DISTINCT block_hash)=1 AND count(DISTINCT timestamp)=1`,[height])).rows[0]:null;
  if(exactEndpoint)return {number:height,hash:String(exactEndpoint.hash),at:date(exactEndpoint.at)};
  const row=(await db.query(`WITH candidates AS(${sources.join(' UNION ALL ')})
    SELECT block_number::text,min(block_hash) AS hash,min(timestamp) AS at FROM candidates
    WHERE block_number ${direction==='before'?'<=':'>='} $1 GROUP BY block_number
    HAVING count(DISTINCT block_hash)=1 AND count(DISTINCT timestamp)=1
    ORDER BY min(block_number) ${direction==='before'?'DESC':'ASC'} LIMIT 1`,[height,legacyMarkets])).rows[0];
  return row?{number:String(row.block_number),hash:String(row.hash),at:date(row.at)}:null;
}

/** The caller owns collection/reorg locks. Retain genuine prefixes and suffixes
 * instead of discarding an entire compacted history when its tail is orphaned. */
export async function invalidateMarketCoverage(db:Database,from:number,to?:number) {
  if(!Number.isSafeInteger(from)||from<0||to!==undefined&&(!Number.isSafeInteger(to)||to<from))throw new Error('market_coverage_gap_invalid');
  const shared=(await db.query("SELECT to_regclass('node_market_collection_ranges') IS NOT NULL AS yes")).rows[0].yes;
  if(!shared){
    // An installation not yet migrated can still contain the earlier minimal
    // prototype. Preserve its prior invalidation semantics until the full
    // current schema and authenticated endpoint storage have been initialized.
    if(to===undefined)await db.query('DELETE FROM node_market_ranges WHERE to_block>=$1',[from]);
    else await db.query('UPDATE node_market_ranges SET complete=false WHERE from_block<=$2 AND to_block>=$1',[from,to]);
    return;
  }
  const legacyMarkets=await legacyCoverageCandidates(db,from);
  const affected=`to_block >= $1 AND ($2::bigint IS NULL OR from_block <= $2)`;
  const prefixNeeded=(await db.query(`SELECT EXISTS(SELECT 1 FROM node_market_ranges WHERE market_id=ANY($3::text[]) AND ${affected} AND from_block<$1)
    OR EXISTS(SELECT 1 FROM node_market_collection_ranges WHERE ${affected} AND from_block<$1) AS yes`,[from,to??null,legacyMarkets])).rows[0].yes;
  const suffixNeeded=to!==undefined&&(await db.query(`SELECT EXISTS(SELECT 1 FROM node_market_ranges WHERE market_id=ANY($3::text[]) AND ${affected} AND to_block>$2)
    OR EXISTS(SELECT 1 FROM node_market_collection_ranges WHERE ${affected} AND to_block>$2) AS yes`,[from,to,legacyMarkets])).rows[0].yes;
  const prefix=prefixNeeded?await coverageBoundary(db,String(from-1),'before',legacyMarkets):null,suffix=suffixNeeded?await coverageBoundary(db,String(to!+1),'after',legacyMarkets):null;
  if(shared)await db.query("SELECT set_config('kollens.coverage_canonical_repair','true',true)");
  for(const table of [...(shared?['node_market_collection_ranges']:[]),'node_market_ranges']) {
    // A CTE stages deleted rows and restores only surviving canonical pieces.
    // Legacy triggers invalidate old migration revisions before readers resume.
    const columns=table==='node_market_ranges'?'market_id,complete':'id,cohort_fingerprint,legacy_market_id,legacy_revision,complete';
    const prefixColumns=table==='node_market_ranges'?'market_id,complete':"encode(sha256(convert_to(id||':prefix:'||$1::text,'UTF8')),'hex'),cohort_fingerprint,legacy_market_id,legacy_revision,complete";
    const suffixColumns=table==='node_market_ranges'?'market_id,complete':"encode(sha256(convert_to(id||':suffix:'||$2::text,'UTF8')),'hex'),cohort_fingerprint,legacy_market_id,legacy_revision,complete";
    const restored=`SELECT ${prefixColumns},from_block,$7::bigint AS to_block,from_hash,$3::text AS to_hash,from_at,$4::timestamptz AS to_at FROM removed WHERE from_block<=$7::bigint
      UNION ALL SELECT ${suffixColumns},$8::bigint,to_block,$5,to_hash,$6::timestamptz,to_at FROM removed
        WHERE $8::bigint IS NOT NULL AND to_block>=$8::bigint`;
    const result=await db.query(`WITH removed AS(DELETE FROM ${table} WHERE ${affected}${table==='node_market_ranges'?' AND market_id=ANY($9::text[])':''} RETURNING *),restored AS(${restored}),
      selected AS(SELECT ${table==='node_market_ranges'?'DISTINCT ON(market_id,from_block,to_block)':''} * FROM restored
        ${table==='node_market_ranges'?'ORDER BY market_id,from_block,to_block,complete DESC':''}),
      inserted AS(INSERT INTO ${table}(${columns},from_block,to_block,from_hash,to_hash,from_at,to_at)
        SELECT * FROM selected ON CONFLICT ${table==='node_market_ranges'?`(market_id,from_block,to_block) DO UPDATE
          SET complete=${table}.complete OR EXCLUDED.complete WHERE ${table}.from_hash=EXCLUDED.from_hash
            AND ${table}.to_hash=EXCLUDED.to_hash AND ${table}.from_at=EXCLUDED.from_at AND ${table}.to_at=EXCLUDED.to_at`:'DO NOTHING'} RETURNING 1)
      SELECT (SELECT count(*)::int FROM selected) AS expected,(SELECT count(*)::int FROM inserted) AS inserted`,
      [from,to??null,prefix?.hash??null,prefix?.at??null,suffix?.hash??null,suffix?.at??null,prefix?.number??null,suffix?.number??null,
        ...(table==='node_market_ranges'?[legacyMarkets]:[])]);
    if(result.rows[0].expected!==result.rows[0].inserted)throw new Error('market_coverage_repair_conflict');
  }
  if(shared){
    await db.query(`UPDATE node_market_coverage_migrations SET state=state||jsonb_build_object('canonicalRepair',jsonb_build_object(
      'fromBlock',$1::bigint,'toBlock',$2::bigint,'prefixBlock',$3::bigint,'prefixHash',$4::text,'suffixBlock',$5::bigint,'suffixHash',$6::text,'at',clock_timestamp()))
      WHERE completed_at IS NOT NULL`,[from,to??null,prefix?.number??null,prefix?.hash??null,suffix?.number??null,suffix?.hash??null]);
    await db.query('DELETE FROM node_market_coverage_endpoints WHERE block_number >= $1 AND ($2::bigint IS NULL OR block_number <= $2)',[from,to??null]);
  }
}
