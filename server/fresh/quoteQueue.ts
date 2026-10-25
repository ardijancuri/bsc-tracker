import type {Pool} from 'pg';
/** A single reusable selected-token job; the API never waits on state RPC. */
export async function selectFreshQuote(db:Pick<Pool,'query'>,token:string) {
  await db.query(`INSERT INTO fresh.jobs(id,kind,reference,priority,due_at)
    SELECT 'quote:'||address,'quote',address,100,now() FROM fresh.tokens WHERE address=$1 AND launch_status='eligible'
      AND (observed_at IS NULL OR observed_at<now()-interval '30 seconds')
    ON CONFLICT(kind,reference) DO UPDATE SET state='pending',priority=GREATEST(fresh.jobs.priority,EXCLUDED.priority),
      due_at=CASE WHEN fresh.jobs.last_error='no_liquidity' AND fresh.jobs.due_at>now() THEN fresh.jobs.due_at
        ELSE LEAST(fresh.jobs.due_at,EXCLUDED.due_at) END`,[token]);
}
