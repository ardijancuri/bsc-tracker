import type {PoolClient} from 'pg';
import type {FreshEventResult,FreshFinancialEvent,FreshScope} from '../../shared/freshAccounting.js';
import {FreshRational} from './accounting.js';

export const FRESH_ROLLING_WINDOW_MS=24*60*60*1000;
const qFields=['known_realized_q','capital_q','volume_q','fee_only_q','unallocated_fee_q'] as const;
const countFields=['trade_count','token_count','unknown_count','buy_count','sell_count','valued_sell_count','unknown_sell_count',
  'valued_transfer_count','unknown_transfer_count','valued_fee_count','unknown_fee_count','unallocated_fee_count','unallocated_fee_unknown_count','unattributed_fee_count'] as const;
type QField=typeof qFields[number];type CountField=typeof countFields[number];
export type FreshRollingTotals=Record<QField,string>&Record<CountField,number>&{realized_q:string|null};
type Row=Record<string,any>;
const rational=(v:string)=>FreshRational.fromStored(v);
const milliseconds=(now:string|Date|number)=>{const value=new Date(now).getTime();if(!Number.isFinite(value))throw Error('invalid_rolling_time');return value;};
export const freshRollingWindow=(now:string|Date|number)=>{const at=milliseconds(now);return{from:new Date(at-FRESH_ROLLING_WINDOW_MS).toISOString(),to:new Date(at).toISOString()};};
export function emptyFreshRollingTotals():FreshRollingTotals{
  return Object.fromEntries([...qFields.map(k=>[k,'0']),...countFields.map(k=>[k,0]),['realized_q','0']]) as FreshRollingTotals;
}
export function freshRollingTotalsFromRow(row:Row):FreshRollingTotals{
  const result=emptyFreshRollingTotals();for(const key of qFields)result[key]=row['rolling_'+key]??'0';
  for(const key of countFields)result[key]=Number(row['rolling_'+key]??0);
  result.realized_q=result.unknown_count?null:result.known_realized_q;return result;
}

/** Deltas are already FIFO/fee results. This never recalculates a purchase cost. */
export function addFreshRollingContribution(totals:FreshRollingTotals,row:Row,sign:1|-1=1):FreshRollingTotals{
  const next={...totals};const addQ=(key:QField,value:string)=>{const term=rational(value);next[key]=rational(next[key]).add(sign===1?term:new FreshRational(-term.n,term.d,true)).exact();};
  const addCount=(key:CountField,value:number)=>{next[key]+=sign*value;if(next[key]<0)throw Error('rolling_negative_counter');};
  if(row.is_excluded_fee){
    addCount('unallocated_fee_count',1);addQ('unallocated_fee_q',row.fee_usd??'0');
    addCount('unallocated_fee_unknown_count',row.fee_usd==null?1:0);addCount('unattributed_fee_count',row.fee_attribution?.status==='excluded'?0:1);
  }else{
    addQ('known_realized_q',row.known_realized_q??'0');addQ('capital_q',row.capital_q??'0');addQ('volume_q',row.volume_q??'0');
    addCount('trade_count',Number(row.trade_count??0));addCount('unknown_count',row.realized_q==null?1:0);
    addCount('buy_count',row.kind==='buy'?1:0);addCount('sell_count',row.kind==='sell'?1:0);
    if(row.kind==='sell')addCount(row.realized_q==null?'unknown_sell_count':'valued_sell_count',1);
    if(row.kind==='transfer_out')addCount(row.realized_q==null?'unknown_transfer_count':'valued_transfer_count',1);
    if(row.kind==='fee'){addCount(row.realized_q==null?'unknown_fee_count':'valued_fee_count',1);addQ('fee_only_q',row.fee_q??'0');}
  }
  next.realized_q=next.unknown_count?null:next.known_realized_q;return next;
}
const resultRow=(event:FreshFinancialEvent,result:FreshEventResult):Row=>({kind:event.kind,token_address:event.tokenAddress,event_id:event.id,
  realized_q:result.realizedQ,known_realized_q:result.knownRealizedQ,capital_q:result.capitalQ,volume_q:result.volumeQ,
  fee_q:result.feeQ,trade_count:result.tradeCount,tokens_trade:result.tokensTrade,occurred_at:result.occurredAt});
const excludedFeeRow=(event:FreshFinancialEvent):Row=>({kind:event.kind,is_excluded_fee:true,fee_usd:event.feeUsd,fee_attribution:event.feeAttribution,occurred_at:event.occurredAt});

async function scopeRow(client:PoolClient,wallet:string){
  const scopes=(await client.query(`SELECT id,kind,wallet_addresses,starts_at,starts_block FROM fresh.accounting_scopes
    WHERE kind='kol' AND active AND wallet_addresses=ARRAY[$1]::text[] ORDER BY id`,[wallet])).rows;
  if(scopes.length!==1)throw Error('rolling_kol_scope_not_unique');return scopes[0];
}
const excludedPredicate=`e.kind='fee' AND (e.fee_attribution->>'status') IS DISTINCT FROM 'eligible'`;
async function rangeRows(client:PoolClient,scope:Row,from:string,to:string){
  const results=(await client.query(`SELECT r.*,e.kind FROM fresh.scope_event_results r JOIN fresh.financial_events e ON e.id=r.event_id
    WHERE r.scope_id=$1 AND r.occurred_at>$2::timestamptz AND r.occurred_at<=$3::timestamptz AND e.canonical
    ORDER BY r.occurred_at,r.event_id`,[scope.id,from,to])).rows;
  const excluded=(await client.query(`SELECT e.*,true AS is_excluded_fee FROM fresh.financial_events e
    WHERE e.wallet_address=$1 AND ${excludedPredicate} AND e.canonical AND e.block_number >= $2 AND e.occurred_at >= $3::timestamptz
      AND e.occurred_at>$4::timestamptz AND e.occurred_at<=$5::timestamptz ORDER BY e.occurred_at,e.id`,
    [scope.wallet_addresses[0],scope.starts_block,scope.starts_at,from,to])).rows;
  return[...results,...excluded];
}
async function countTokens(client:PoolClient,scope:string,from:string,to:string){return Number((await client.query(`SELECT count(DISTINCT r.token_address)::int AS n
  FROM fresh.scope_event_results r JOIN fresh.financial_events e ON e.id=r.event_id WHERE r.scope_id=$1 AND r.tokens_trade
  AND r.occurred_at>$2::timestamptz AND r.occurred_at<=$3::timestamptz AND e.canonical`,[scope,from,to])).rows[0].n);}
async function nextExpiry(client:PoolClient,scope:Row,from:string,to:string){
  const row=(await client.query(`SELECT min(due_at) AS due_at FROM(
    (SELECT r.occurred_at+interval '24 hours' AS due_at
      FROM fresh.scope_event_results r JOIN fresh.financial_events e ON e.id=r.event_id WHERE r.scope_id=$1
      AND r.occurred_at>$2::timestamptz AND r.occurred_at<=$3::timestamptz AND e.canonical ORDER BY r.occurred_at LIMIT 1)
    UNION ALL
    (SELECT r.occurred_at AS due_at FROM fresh.scope_event_results r JOIN fresh.financial_events e ON e.id=r.event_id
      WHERE r.scope_id=$1 AND r.occurred_at>$3::timestamptz AND e.canonical ORDER BY r.occurred_at LIMIT 1)
    UNION ALL
    (SELECT e.occurred_at+interval '24 hours' AS due_at
      FROM fresh.financial_events e WHERE e.wallet_address=$4 AND ${excludedPredicate} AND e.canonical
      AND e.block_number >= $5 AND e.occurred_at >= $6::timestamptz AND e.occurred_at>$2::timestamptz AND e.occurred_at<=$3::timestamptz ORDER BY e.occurred_at LIMIT 1)
    UNION ALL
    (SELECT e.occurred_at AS due_at FROM fresh.financial_events e WHERE e.wallet_address=$4 AND ${excludedPredicate} AND e.canonical
      AND e.block_number >= $5 AND e.occurred_at >= $6::timestamptz AND e.occurred_at>$3::timestamptz ORDER BY e.occurred_at LIMIT 1)
  ) due`,[scope.id,from,to,scope.wallet_addresses[0],scope.starts_block,scope.starts_at])).rows[0];
  return row?.due_at?new Date(row.due_at).toISOString():null;
}
async function persist(client:PoolClient,wallet:string,totals:FreshRollingTotals,asOf:string,next:string|null){
  const keys=['realized_q',...qFields,...countFields];
  await client.query(`UPDATE fresh.kols SET ${keys.map((key,i)=>`rolling_${key}=$${i+2}`).join(',')},
    rolling_as_of=$${keys.length+2},rolling_next_expiry_at=$${keys.length+3},rolling_metrics_updated_at=clock_timestamp(),revision=revision+1
    WHERE wallet_address=$1`,[wallet,...keys.map(key=>totals[key as keyof FreshRollingTotals]),asOf,next]);
}

/** Caller holds its scope lock; initialization reads at most the current compact
 * 24-hour result window once. Thereafter only entering/expiring deltas are read. */
export async function advanceFreshRollingKolTotals(client:PoolClient,wallet:string,now:string|Date|number=Date.now()){
  const window=freshRollingWindow(now),scope=await scopeRow(client,wallet);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`fresh-scope:${scope.id}`]);
  const saved=(await client.query('SELECT * FROM fresh.kols WHERE wallet_address=$1 FOR UPDATE',[wallet])).rows[0];
  if(!saved)throw Error('kol_scope_without_identity');
  const before=saved.rolling_as_of==null?null:milliseconds(saved.rolling_as_of),at=milliseconds(window.to);
  if(before!==null&&at<before)throw Error('rolling_clock_moved_backwards');
  if(before===at)return freshRollingTotalsFromRow(saved);
  // With no due contribution the stored total is still exact. In particular,
  // duplicate decoding/display enrichment cannot churn the KOL current row.
  if(before!==null&&(saved.rolling_next_expiry_at==null||milliseconds(saved.rolling_next_expiry_at)>at))return freshRollingTotalsFromRow(saved);
  let totals=freshRollingTotalsFromRow(saved);
  if(before===null||at-before>=FRESH_ROLLING_WINDOW_MS){
    totals=emptyFreshRollingTotals();for(const row of await rangeRows(client,scope,window.from,window.to))totals=addFreshRollingContribution(totals,row);
    totals.token_count=await countTokens(client,scope.id,window.from,window.to);
  }else{
    const oldWindow=freshRollingWindow(before),expired=await rangeRows(client,scope,oldWindow.from,window.from),entered=await rangeRows(client,scope,oldWindow.to,window.to);
    for(const row of expired)totals=addFreshRollingContribution(totals,row,-1);
    for(const row of entered)totals=addFreshRollingContribution(totals,row);
    if([...expired,...entered].some(row=>row.tokens_trade))totals.token_count=await countTokens(client,scope.id,window.from,window.to);
  }
  await persist(client,wallet,totals,window.to,await nextExpiry(client,scope,window.from,window.to));return totals;
}

/** Add only a newly inserted scope result. applyFreshFinancialEvents initialized
 * the window before insertion under the same advisory/row lock. */
export async function addFreshRollingKolResult(client:PoolClient,scope:FreshScope,event:FreshFinancialEvent,result:FreshEventResult,now:string|Date|number){
  if(scope.kind!=='kol')return;
  const window=freshRollingWindow(now),at=milliseconds(event.occurredAt),from=milliseconds(window.from),to=milliseconds(window.to),wallet=scope.walletAddresses[0];
  if(at<=from)return;
  const saved=(await client.query('SELECT * FROM fresh.kols WHERE wallet_address=$1 FOR UPDATE',[wallet])).rows[0];
  if(!saved?.rolling_as_of||milliseconds(saved.rolling_as_of)>to||saved.rolling_next_expiry_at!=null&&milliseconds(saved.rolling_next_expiry_at)<=to)throw Error('rolling_window_not_advanced');
  let totals=freshRollingTotalsFromRow(saved);
  if(at<=to){
    totals=addFreshRollingContribution(totals,resultRow(event,result));
    if(result.tokensTrade&&!(await client.query(`SELECT 1 FROM fresh.scope_event_results r JOIN fresh.financial_events e ON e.id=r.event_id
      WHERE r.scope_id=$1 AND r.token_address=$2 AND r.tokens_trade AND r.event_id<>$3 AND e.canonical
        AND r.occurred_at>$4::timestamptz AND r.occurred_at<=$5::timestamptz LIMIT 1`,[scope.id,event.tokenAddress,event.id,window.from,window.to])).rowCount)totals.token_count++;
  }
  const due=new Date(at>to?at:at+FRESH_ROLLING_WINDOW_MS).toISOString();
  const next=saved.rolling_next_expiry_at&&milliseconds(saved.rolling_next_expiry_at)<milliseconds(due)?new Date(saved.rolling_next_expiry_at).toISOString():due;
  await persist(client,wallet,totals,window.to,next);
}
export async function addFreshRollingKolExcludedFee(client:PoolClient,scope:FreshScope,event:FreshFinancialEvent,now:string|Date|number){
  if(scope.kind!=='kol')return;
  const window=freshRollingWindow(now),at=milliseconds(event.occurredAt),from=milliseconds(window.from),to=milliseconds(window.to),wallet=scope.walletAddresses[0];
  if(at<=from)return;
  const saved=(await client.query('SELECT * FROM fresh.kols WHERE wallet_address=$1 FOR UPDATE',[wallet])).rows[0];
  if(!saved?.rolling_as_of||milliseconds(saved.rolling_as_of)>to||saved.rolling_next_expiry_at!=null&&milliseconds(saved.rolling_next_expiry_at)<=to)throw Error('rolling_window_not_advanced');
  const totals=at<=to?addFreshRollingContribution(freshRollingTotalsFromRow(saved),excludedFeeRow(event)):freshRollingTotalsFromRow(saved);
  const due=new Date(at>to?at:at+FRESH_ROLLING_WINDOW_MS).toISOString(),next=saved.rolling_next_expiry_at&&milliseconds(saved.rolling_next_expiry_at)<milliseconds(due)?new Date(saved.rolling_next_expiry_at).toISOString():due;
  await persist(client,wallet,totals,window.to,next);
}

/** Correction/reorg only, after scope results have been rebuilt. */
export async function rebuildFreshRollingKolTotals(client:PoolClient,wallet:string,now:string|Date|number=Date.now()){
  const scope=await scopeRow(client,wallet);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`fresh-scope:${scope.id}`]);
  await client.query('UPDATE fresh.kols SET rolling_as_of=NULL WHERE wallet_address=$1',[wallet]);
  return advanceFreshRollingKolTotals(client,wallet,now);
}

/** Bounded idle expiry/bootstrap. Ordinary HTTP reads only consume the stored row.
 * Run inside the normal maintenance transaction, never a browser request. */
export async function refreshFreshRollingKolTotals(client:PoolClient,options:{now?:string|Date|number;limit?:number}={}){
  await client.query('SELECT pg_advisory_xact_lock(73621941)');
  const now=options.now??Date.now(),at=freshRollingWindow(now).to,limit=Math.min(256,Math.max(1,options.limit??64));
  const rows=(await client.query(`SELECT k.wallet_address FROM fresh.kols k WHERE (k.rolling_as_of IS NULL OR k.rolling_next_expiry_at<=$1::timestamptz)
    AND EXISTS(SELECT 1 FROM fresh.accounting_scopes s WHERE s.kind='kol' AND s.active AND s.wallet_addresses=ARRAY[k.wallet_address]::text[])
    ORDER BY k.rolling_as_of NULLS FIRST,k.rolling_next_expiry_at NULLS FIRST,k.wallet_address LIMIT $2`,[at,limit])).rows;
  // Match normal scope-lock ordering for callers that batch several KOLs.
  for(const row of rows.sort((a,b)=>a.wallet_address.localeCompare(b.wallet_address)))await advanceFreshRollingKolTotals(client,row.wallet_address,now);
  return{updated:rows.length,limit,asOf:at};
}
