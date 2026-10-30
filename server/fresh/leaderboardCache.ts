/** Public raw read rows only. PostgreSQL MVCC snapshot identity invalidates on
 * committed repairs/reorgs/settings changes without relying on every writer
 * remembering to emit a notification. Window and database-clock deadlines are
 * separate: neither a 24-hour expiry nor stale maintenance can stay approved.
 * Entries never contain Portfolio data and are never written to PostgreSQL. */
import{freshLeaderboardPendingReceiptsSql}from'./leaderboardQuery.js';
export type FreshLeaderboardReadVersion={key:string;at:number;databaseAt:number;databaseObservedAt?:number};
export type FreshLeaderboardCachedRows={value:Record<string,any>[];windowUntil:number;databaseUntil:number};
export function createFreshLeaderboardReadCache(options:{maxBytes?:number;maxEntries?:number;maxAgeMs?:number;clock?:()=>number}={}){
 const clock=options.clock??(()=>performance.now()),maxBytes=options.maxBytes??4*1024*1024,maxEntries=options.maxEntries??2,maxAge=options.maxAgeMs??1000;
 type Entry=FreshLeaderboardCachedRows&{version:FreshLeaderboardReadVersion;saved:number;bytes:number};
 const entries=new Map<string,Entry>(),pending=new Map<string,Promise<Entry>>();let hits=0,loads=0,coalesced=0;
 const usable=(e:Entry,v:FreshLeaderboardReadVersion)=>{const current=clock(),observed=v.databaseObservedAt;
  return observed!==undefined&&e.version.key===v.key&&v.at>=e.version.at&&v.at<e.windowUntil
   &&v.databaseAt>=e.version.databaseAt&&current>=observed&&v.databaseAt+current-observed<e.databaseUntil
   &&current>=e.saved&&current-e.saved<maxAge;};
 const trim=()=>{let bytes=0;for(const[k,e]of entries){if(clock()-e.saved>=maxAge||clock()<e.saved)entries.delete(k);else bytes+=e.bytes;}
  for(const[k,e]of entries){if(entries.size<=maxEntries&&bytes<=maxBytes)break;entries.delete(k);bytes-=e.bytes;}};
 async function read(version:FreshLeaderboardReadVersion,load:()=>Promise<FreshLeaderboardCachedRows>){
  version={...version,databaseObservedAt:version.databaseObservedAt??clock()};
  trim();const saved=entries.get(version.key);if(saved&&usable(saved,version)){hits++;return structuredClone(saved.value);}
  const active=pending.get(version.key);if(active){coalesced++;const e=await active;if(usable(e,version))return structuredClone(e.value);}
  const run=async()=>{loads++;const result=await load(),e:Entry={...result,version:{...version},saved:clock(),bytes:Buffer.byteLength(JSON.stringify(result.value))};
   if(e.bytes<=maxBytes&&Number.isFinite(e.windowUntil)&&Number.isFinite(e.databaseUntil)&&e.windowUntil>version.at&&e.databaseUntil>version.databaseAt){entries.delete(version.key);entries.set(version.key,e);trim();}return e;};
  // Bound retained owners too. A changing capture snapshot can bypass this
  // cache; it cannot grow the owner map or reuse rows from a different snapshot.
  if(pending.size>=maxEntries||pending.has(version.key))return structuredClone((await run()).value);
  const owned=run();pending.set(version.key,owned);try{return structuredClone((await owned).value);}finally{if(pending.get(version.key)===owned)pending.delete(version.key);}
 }
 return{read,stats:()=>({entries:entries.size,pending:pending.size,hits,loads,coalesced,bytes:[...entries.values()].reduce((s,e)=>s+e.bytes,0)})};
}
export type FreshLeaderboardReadCache=ReturnType<typeof createFreshLeaderboardReadCache>;

/** Conservative transition bounds, read only on a cache fill in the same
 * repeatable-read transaction as the approved rows. All public-wallet events
 * may shorten a lease, but only existing public predicates can publish a KOL.
 * Read just each wallet/scope's next indexed transition, never its full history. */
const nextTimes=(table:string,identity:string,canonical=false)=>[
 'e.occurred_at>=$1::timestamptz AND e.occurred_at<=$2::timestamptz','e.occurred_at>$2::timestamptz'
].map(window=>`SELECT n.t FROM public_windows w CROSS JOIN LATERAL(
 SELECT e.occurred_at AS t FROM ${table} e WHERE ${identity} ${canonical?'AND e.canonical':''}
 AND ${window} ORDER BY e.occurred_at LIMIT 1)n`).join(' UNION ALL ');
export const freshLeaderboardCacheBoundsSql=`WITH ${freshLeaderboardPendingReceiptsSql},public_windows AS MATERIALIZED(
 SELECT wallet_address,'kol:'||wallet_address AS scope_id FROM fresh.kols WHERE is_tracked
),times AS(
 ${nextTimes('fresh.scope_event_results','e.scope_id=w.scope_id')}
 UNION ALL ${nextTimes('fresh.financial_events','e.wallet_address=w.wallet_address',true)}
 UNION ALL ${nextTimes('fresh.pending_trades','e.wallet_address=w.wallet_address',true)}
 UNION ALL SELECT occurred_at FROM board_pending_receipts WHERE occurred_at>=$1::timestamptz
 UNION ALL SELECT b.occurred_at FROM fresh.checkpoints c CROSS JOIN LATERAL(
  SELECT h.occurred_at FROM fresh.recent_blocks h WHERE h.block_number=c.block_number AND h.block_hash=c.block_hash LIMIT 1
 )b WHERE c.key LIKE 'coverage:realized_gap:%' AND b.occurred_at>=$1::timestamptz
), deadlines AS(
 SELECT CASE WHEN t>$2::timestamptz THEN t ELSE t+interval '24 hours' END AS t FROM times
 UNION ALL SELECT rolling_next_expiry_at FROM fresh.kols WHERE is_tracked AND rolling_next_expiry_at>$2::timestamptz
), clock_deadlines AS(
 SELECT CASE WHEN updated_at>$3::timestamptz THEN updated_at
  WHEN updated_at+interval '120 seconds'>$3::timestamptz THEN updated_at+interval '120 seconds' END AS t
 FROM fresh.checkpoints WHERE key='health:maintenance'
 UNION ALL SELECT CASE WHEN pg_input_is_valid(value->>'activatedAt','timestamptz') THEN (value->>'activatedAt')::timestamptz END FROM fresh.checkpoints
 WHERE key LIKE 'coverage:realized_gap:%' AND CASE WHEN pg_input_is_valid(value->>'activatedAt','timestamptz')
  THEN (value->>'activatedAt')::timestamptz>$3::timestamptz ELSE false END
)
SELECT LEAST($2::timestamptz+interval '1 second',(SELECT min(t) FROM deadlines)) AS window_until,
 LEAST(clock_timestamp()+interval '1 second',(SELECT min(t) FROM clock_deadlines)) AS database_until`;
