import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';

/** Serialize complete API/worker migrations. The guard connection takes no
 * relation locks: each existing migration keeps its own atomic transaction.
 * Retrying the idempotent sequence also handles a live worker's DML locks. */
export async function runSchemaStartup(database: Pick<Pool, 'connect'>, migrate: () => Promise<void>) {
  const guard = await database.connect();
  let discard = false;
  try {
    await guard.query('BEGIN');
    await guard.query('SELECT pg_advisory_xact_lock(782344)');
    for (let attempt = 0; ; attempt++) {
      try { await migrate(); break; }
      catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
        if (attempt >= 3 || code !== '40P01' && code !== '55P03') throw error;
        await delay(75 * (attempt + 1));
      }
    }
    await guard.query('COMMIT');
  } catch (error) {
    try { await guard.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally { guard.release(discard); }
}
