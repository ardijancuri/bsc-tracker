import pg from 'pg';
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 12,
  options: '-c timezone=UTC -c idle_in_transaction_session_timeout=30000' });
/** Only the fresh schema is reachable from the application startup. */
export async function ensureSchema() {
  const { ensureFreshSchema } = await import('./fresh/schema.js');
  await ensureFreshSchema(pool);
}
export async function setState(key: string, value: unknown) {
  await pool.query(`INSERT INTO fresh.checkpoints(key,value) VALUES($1,$2::jsonb)
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,[key,JSON.stringify(value)]);
}
export async function notifyUpdate() { await pool.query("SELECT pg_notify('bscan_update','update')"); }
