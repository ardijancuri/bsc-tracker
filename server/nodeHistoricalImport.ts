import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { pool } from './db.js';
import { gmgnRequest, GmgnHttpError } from './gmgnApi.js';
import { MarketProviderDeferred } from './geckoApi.js';
import { currentKolTokenBalance } from './kolTokenBalance.js';
import { saveNodeAccountingBaseline } from './nodeAccounting.js';
import { nodeMarketCoverageComplete, nodeMarketService } from './nodeMarket.js';
import { calculateJournalLedger, journalDecimalMultiply, journalDecimalDivide, sumJournalDecimals, type JournalLedgerEvent } from './nodeAccountingLedger.js';
import type { KolTokenBalanceProof } from '../shared/kolTokenTrades.js';
import { isKolProfileToken,kolProfileTokenSql } from './kolProfileToken.js';
import { MarketDecimal } from './nodeMarketMath.js';

const canonicalJson=(value:unknown):unknown=>Array.isArray(value)?value.map(canonicalJson):value&&typeof value==='object'
  ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonicalJson(item)])):value;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonicalJson(value))).digest('hex');
const decimal = (value: unknown) => {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  return typeof text === 'string' && /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text) && journalDecimalMultiply(text, '1') !== null ? journalDecimalMultiply(text, '1') : null;
};
const addr = /^0x[0-9a-f]{40}$/;
const txHash = /^0x[0-9a-f]{64}$/;
const signedDecimal = (value: unknown) => {const text=typeof value==='number'&&Number.isFinite(value)?String(value):value;
  return typeof text==='string'&&text.startsWith('-')?(()=>{const amount=decimal(text.slice(1));return amount===null?null:amount==='0'?'0':`-${amount}`;})():decimal(text);};
type Db = Pick<Pool, 'query' | 'connect'>;
export { ensureNodeHistoricalImportSchema } from './nodeHistoricalImportSchema.js';

/** Preserve shared provider pacing/cooldowns without discarding completed work. */
export function historicalImportRetry(error: unknown, attempts: number) {
  const fallback = Math.min(600_000, 5000 * 2 ** Math.min(Math.max(0, attempts), 6));
  if(error instanceof Error&&['TimeoutError','AbortError'].includes(error.name))return {reason:'import_provider_timeout',retryAfterMs:15000};
  const provider = error instanceof MarketProviderDeferred || error instanceof GmgnHttpError;
  const retryAfterMs = provider && Number.isFinite(error.retryAfterMs) ? error.retryAfterMs! : fallback;
  const reason = error instanceof MarketProviderDeferred ? error.reason === 'busy' ? 'import_provider_busy' : 'import_provider_cooldown'
    : error instanceof GmgnHttpError ? [401, 403].includes(error.status) ? 'import_provider_auth_blocked' : 'import_provider_unavailable'
    : error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'import_unavailable';
  return { reason, retryAfterMs: Math.min(600_000, Math.max(1000, Math.ceil(retryAfterMs))) };
}

export function normalizeImportedWalletDiscovery(rows:unknown,wallet:string,now:number) {
  if(!addr.test(wallet)||!Array.isArray(rows)||rows.length>100)throw new Error('import_discovery_response_invalid');
  const tokens=new Map<string,{address:string;symbol:string|null;name:string|null}>();
  for(const row of rows) {
    const token=String(row?.token?.address??'').toLowerCase(),timestamp=Number(row?.timestamp),kind=String(row?.event_type??row?.type).replace(/[_-]/g,'').toLowerCase();
    if(!row||typeof row!=='object'||!addr.test(token)||String(row.wallet??wallet).toLowerCase()!==wallet||(row.chain??'bsc')!=='bsc'
      ||!txHash.test(String(row.tx_hash??'').toLowerCase())||!['buy','sell','transferin','transferout'].includes(kind)
      ||!Number.isSafeInteger(timestamp)||timestamp<=0||timestamp*1000>now)throw new Error('import_discovery_movement_invalid');
    const symbol=typeof row.token.symbol==='string'?row.token.symbol.slice(0,100):null,name=typeof row.token.name==='string'?row.token.name.slice(0,200):null;
    if(isKolProfileToken({address:token,symbol,name}))tokens.set(token,{address:token,symbol,name});
  }
  return [...tokens.values()];
}

/** Historical rows carry no invented block position. Same-second rows stay atomic. */
export function normalizeImportedMovements(rows: unknown, wallet: string, token: string, now: number): { event: JournalLedgerEvent; raw: unknown }[] {
  if (!Array.isArray(rows) || rows.length > 100 || !addr.test(wallet) || !addr.test(token)) throw new Error('import_response_invalid');
  const identities = new Set<string>();
  return rows.map(raw => {
    if(!raw||typeof raw!=='object'||Array.isArray(raw)) throw new Error('import_movement_invalid');
    const kinds={ buy: 'buy', sell: 'sell', transferin: 'transfer_in', transferout: 'transfer_out' } as const;
    const kind = kinds[String(raw?.event_type ?? raw?.type).replace(/[_-]/g, '').toLowerCase() as keyof typeof kinds];
    const hash = String(raw?.tx_hash ?? '').toLowerCase(), quantity = decimal(raw?.token_amount), seconds = Number(raw?.timestamp);
    if (!kind || !txHash.test(hash) || !quantity || quantity === '0' || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds * 1000 > now
      || String(raw.wallet ?? wallet).toLowerCase() !== wallet || String(raw.token?.address ?? '').toLowerCase() !== token || (raw.chain ?? 'bsc') !== 'bsc') throw new Error('import_movement_invalid');
    const id = `gmgn:${hash}:${kind}`;
    if (identities.has(id)) throw new Error('import_execution_identity_ambiguous');
    identities.add(id);
    const gas = decimal(raw.gas_usd), dex = decimal(raw.dex_usd), priority = decimal(raw.priority_fee), tip = decimal(raw.tip_fee);
    // dex_usd may already be embedded in the reported swap cash flow. A bare
    // number is not evidence that it should be charged again. Missing fee units
    // remain unknown; an independently reconciled aggregate may cover the end.
    const fee = gas !== null && dex === '0' && priority === '0' && tip === '0' && (kind!=='transfer_in'||gas==='0') ? gas : null;
    return { raw, event: { id, walletAddress: wallet, tokenAddress: token, txHash: hash, kind, tokenAmount: quantity,
      amountUsd: decimal(raw.cost_usd), feeUsd: fee, feeId: `gmgn:${hash}`, timestamp: new Date(seconds * 1000).toISOString(), blockNumber: null,
      transactionIndex: null, logIndex: null } };
  });
}

/** Decimal-place rounding from a provider is bounded by its own least unit. */
type QuantityRepresentation = 'decimal' | 'gmgn_float_display';
function importedQuantityBounds(provider: unknown, canonical: string, decimals: number, representation: QuantityRepresentation = 'decimal') {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const a = decimal(provider), b = decimal(canonical); if (a === null || b === null) return null;
  const notation=/^\d+(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(provider));
  const precision=Math.min(36,Math.max(0,(notation?.[1]?.length??0)-Number(notation?.[2]??0)));
  const first=MarketDecimal.parse(a),second=MarketDecimal.parse(b),difference=new MarketDecimal(first.n*second.d-second.n*first.d,first.d*second.d);
  const absolute=new MarketDecimal(difference.n<0n?-difference.n:difference.n,difference.d);
  let providerUnit=new MarketDecimal(1n,2n*10n**BigInt(precision));
  const numeric=typeof provider==='number'?provider:representation==='gmgn_float_display'&&typeof provider==='string'
    &&decimal(Number(provider))===a?Number(provider):null;
  if(numeric!==null) {
    // JSON numbers have crossed an IEEE754 boundary. GMGN also returns some
    // of those display values as lossless numeric strings. Preserve a bounded
    // half-ULP only for those explicit representations; full decimal strings
    // keep their stricter precision. There is no global floating epsilon.
    const view=new DataView(new ArrayBuffer(8));view.setFloat64(0,numeric);
    const exponent=Number(view.getBigUint64(0)>>52n&2047n),power=(exponent===0?-1022:exponent-1023)-53;
    providerUnit=providerUnit.add(power>=0?new MarketDecimal(1n<<BigInt(power)):new MarketDecimal(1n,1n<<BigInt(-power)));
  }
  const tokenUnit=new MarketDecimal(1n,10n**BigInt(decimals));
  const relative=(first.compare(second)>0?first:second).mul(MarketDecimal.parse('0.000000000001'));
  const maximum=relative.compare(tokenUnit)>0?relative:tokenUnit;
  const tolerance=providerUnit.compare(maximum)<0?providerUnit:maximum;
  return {absolute,tolerance,maximum,zeroAgrees:(a==='0')===(b==='0')};
}
export function importedQuantityMatches(provider: unknown, canonical: string, decimals: number, representation: QuantityRepresentation = 'decimal') {
  const bounds=importedQuantityBounds(provider,canonical,decimals,representation);
  return !!bounds&&bounds.zeroAgrees&&bounds.absolute.compare(bounds.tolerance)<=0;
}
export function importedQuantitySumMatches(providerSum:string,canonical:string,decimals:number,unmatchedSources:unknown[],representation:QuantityRepresentation='decimal') {
  const bounds=importedQuantityBounds(providerSum,canonical,decimals);if(!bounds||!bounds.zeroAgrees)return false;
  let uncertainty=new MarketDecimal(0n);
  for(const raw of unmatchedSources){const value=decimal(raw),source=value===null?null:importedQuantityBounds(raw,value,decimals,representation);
    if(!source)return false;uncertainty=uncertainty.add(source.tolerance);}
  const tolerance=uncertainty.compare(bounds.maximum)<0?uncertainty:bounds.maximum;
  return bounds.absolute.compare(tolerance)<=0;
}

/** A captured trade can precede USD/metadata decoding. Reconcile its inventory
 * from authenticated raw executions rather than treating a missing quantity as
 * zero or requiring the legacy presentation row to have been repaired first. */
export function importedCanonicalQuantity(trades:{token_amount:string|null;execution_id?:string|null}[],
  executions:{id:string;delta_raw:string}[],decimals:number) {
  if(trades.every(trade=>decimal(trade.token_amount)!==null))return sumJournalDecimals(trades.map(trade=>trade.token_amount!));
  if(!Number.isInteger(decimals)||decimals<0||decimals>36||!executions.length
    ||trades.some(trade=>trade.execution_id&&!executions.some(execution=>execution.id===trade.execution_id)))throw new Error('import_overlap_quantity_unavailable');
  const unique=new Map<string,string>();
  for(const execution of executions){
    if(!/^-?\d+$/.test(execution.delta_raw)||BigInt(execution.delta_raw)===0n)throw new Error('import_overlap_quantity_unavailable');
    if(unique.has(execution.id)&&unique.get(execution.id)!==execution.delta_raw)throw new Error('import_overlap_quantity_unavailable');
    unique.set(execution.id,execution.delta_raw);
  }
  const amounts=[...unique.values()],positive=BigInt(amounts[0])>0n;
  if(amounts.some(amount=>(BigInt(amount)>0n)!==positive))throw new Error('import_overlap_quantity_unavailable');
  const raw=amounts.reduce((sum,amount)=>sum+BigInt(amount),0n);
  return MarketDecimal.raw(raw<0n?-raw:raw,decimals).text();
}

/** Bounded provider FX rounding; never tolerate a missing purchase or sale. */
function importedMoneyMatches(left:string,right:string) {
  const a=MarketDecimal.parse(left),b=MarketDecimal.parse(right),delta=new MarketDecimal(a.n*b.d-b.n*a.d,a.d*b.d);
  const difference=new MarketDecimal(delta.n<0n?-delta.n:delta.n,delta.d),oneCent=MarketDecimal.parse('0.01');
  const absA=new MarketDecimal(a.n<0n?-a.n:a.n,a.d),absB=new MarketDecimal(b.n<0n?-b.n:b.n,b.d);
  const relative=(absA.compare(absB)>0?absA:absB).mul(MarketDecimal.parse('0.000001'));
  const bounded=relative.compare(oneCent)<0?relative:oneCent,minimum=MarketDecimal.parse('0.00000001');
  return difference.compare(bounded.compare(minimum)>0?bounded:minimum)<=0;
}

export function normalizeImportedChart(response:unknown,from:number,to:number,intervalSeconds:number,now:number,options:{requestLimit?:number}={}) {
  const envelope=response as any,body=envelope?.data??envelope;
  const raw=Array.isArray(body)?body:body?.list??body?.candles;
  if(!Array.isArray(raw)||raw.length>1000) throw new Error('import_chart_response_invalid');
  const bars=new Map<number,{timestamp:string;priceUsd:string;open:string;high:string;low:string;close:string;volumeUsd:string|null;intervalSeconds:number}>();
  for(const candidate of raw) {
    const row=Array.isArray(candidate)?{time:candidate[0],open:candidate[1],high:candidate[2],low:candidate[3],close:candidate[4],volume:candidate[5]}:candidate;
    const input=Number(row?.time??row?.timestamp),time=input>=1e12?input:input*1000;
    const open=decimal(row?.open),high=decimal(row?.high),low=decimal(row?.low),close=decimal(row?.close),volume=decimal(row?.volume);
    if(!Number.isSafeInteger(time)||time<from||time>to) throw new Error('import_chart_timestamp_invalid');
    // A forming close has no authenticated historical observation time. Do not
    // freeze it as a completed candle or use access time as a fresh quote.
    if(time+intervalSeconds*1000>now) continue;
    if(!open||!high||!low||!close||[open,high,low,close].includes('0')) throw new Error('import_chart_candle_invalid');
    const [o,h,l,c]=[open,high,low,close].map(MarketDecimal.parse);
    if(h.compare(o)<0||h.compare(c)<0||l.compare(o)>0||l.compare(c)>0||l.compare(h)>0) throw new Error('import_chart_candle_invalid');
    const result={timestamp:new Date(time).toISOString(),priceUsd:close,open,high,low,close,volumeUsd:volume,intervalSeconds};
    const prior=bars.get(time);if(prior&&digest(prior)!==digest(result)) throw new Error('import_chart_conflict');bars.set(time,result);
  }
  const observations=[...bars.values()].sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
  const first=observations[0],last=observations.at(-1);
  const coverageFrom=first?Date.parse(first.timestamp):null,coverageTo=last?Date.parse(last.timestamp)+intervalSeconds*1000:null;
  const complete=coverageFrom!==null&&coverageTo!==null&&coverageFrom<=from&&coverageTo>=Math.min(to,now-intervalSeconds*1000);
  // Exhaustive retrieval coverage is distinct from having prices at both
  // boundaries. An empty/sparse queried interval never manufactures a candle.
  const retrievalComplete=options.requestLimit===1000&&raw.length<1000&&to+intervalSeconds*1000<=now;
  return {observations,coverageFrom,coverageTo,complete,retrievalComplete};
}

/** Provider aggregate validation is independent from FIFO reconstruction.
 * Opaque provider cost allocation never replaces original FIFO lots. */
export function validateImportedAggregate(row:Record<string,unknown>,events:JournalLedgerEvent[],proof:KolTokenBalanceProof,decimals:number,newestCanonicalBlock='0') {
  row={...row,buy_amount_cur:row.buy_amount_cur??row.current_buy_amount,sell_amount_cur:row.sell_amount_cur??row.current_sell_amount};
  const value=(field:string)=>decimal(row[field]);
  const balance=decimal(row.balance??row.amount_cur),cost=value('total_cost'),profit=signedDecimal(row.profit),roi=signedDecimal(row.profit_change);
  const bought=value('history_bought_cost'),buyFees=value('history_bought_fee'),sold=value('history_sold_income'),sellFees=value('history_sold_fee');
  const incoming=value('history_transfer_in_cost'),outgoing=value('history_transfer_out_income'),outFees=value('history_transfer_out_fee');
  const basis=decimal(row.cost_cur??row.accu_cost??row.cost),heldValue=value('usd_value'),realized=signedDecimal(row.realized_profit),unrealized=signedDecimal(row.unrealized_profit);
  if([balance,cost,profit,roi,bought,buyFees,sold,sellFees,incoming,outgoing,outFees,basis,heldValue,realized,unrealized].some(item=>item===null)
    ||String(row.address??'').toLowerCase()!==proof.walletAddress||!importedQuantityMatches(row.balance??row.amount_cur,proof.balance,decimals,'gmgn_float_display')) throw new Error('import_aggregate_quantity_mismatch');
  const fields={buy:'buy_amount_cur',sell:'sell_amount_cur',transfer_in:'history_transfer_in_amount',transfer_out:'history_transfer_out_amount'} as const;
  const counts={buy:'buy_tx_count_cur',sell:'sell_tx_count_cur',transfer_in:'transfer_in_count',transfer_out:'transfer_out_count'} as const;
  const costs={buy:bought!,sell:sold!,transfer_in:incoming!,transfer_out:outgoing!};
  for(const kind of ['buy','sell','transfer_in','transfer_out'] as const) {
    const group=events.filter(event=>event.kind===kind),amount=decimal(row[fields[kind]]);
    if(amount===null||!importedQuantityMatches(row[fields[kind]],sumJournalDecimals(group.map(event=>event.tokenAmount)),decimals,'gmgn_float_display')
      ||decimal(row[counts[kind]])!==String(group.length)) throw new Error('import_aggregate_history_mismatch');
    if(group.every(event=>event.amountUsd!==null)&&!importedMoneyMatches(sumJournalDecimals(group.map(event=>event.amountUsd!)),costs[kind])) throw new Error('import_aggregate_cost_mismatch');
  }
  const totalFees=sumJournalDecimals([buyFees!,sellFees!,outFees!]),expectedCost=sumJournalDecimals([bought!,incoming!,totalFees]);
  const expectedProfit=sumJournalDecimals([sold!,outgoing!,heldValue!,`-${cost}`]);
  const expectedRealized=sumJournalDecimals([sold!,outgoing!,basis!,`-${cost}`]);
  const expectedUnrealized=sumJournalDecimals([heldValue!,`-${basis}`]);
  const latest=events.at(-1),lastBlock=String(row.last_block??''),lastActive=Number(row.last_active_timestamp);
  if(!/^\d+$/.test(lastBlock)||BigInt(lastBlock)<BigInt(newestCanonicalBlock)||BigInt(lastBlock)>BigInt(proof.blockNumber)
    ||!Number.isSafeInteger(lastActive)||latest&&Math.abs(lastActive*1000-Date.parse(latest.timestamp))>1000
    ||!importedMoneyMatches(cost!,expectedCost)||!importedMoneyMatches(profit!,expectedProfit)||!importedMoneyMatches(realized!,expectedRealized)
    ||!importedMoneyMatches(unrealized!,expectedUnrealized)||!importedMoneyMatches(sumJournalDecimals([realized!,unrealized!]),profit!)
    ||balance==='0'&&(basis!=='0'||heldValue!=='0'||unrealized!=='0')
    ||balance!=='0'&&heldValue==='0'
    ||cost!=='0'&&!importedMoneyMatches(journalDecimalDivide(profit!,cost!)!,roi!)
    ||cost==='0'&&roi!=='0') throw new Error('import_aggregate_inconsistent');
  return {bought:bought!,sold:sold!,incoming:incoming!,outgoing:outgoing!,buyFees:buyFees!,sellFees:sellFees!,outFees:outFees!,
    totalFees,basis:basis!,realized:realized!,capital:sumJournalDecimals([bought!,incoming!,buyFees!])};
}

export function createNodeHistoricalImporter({ db = pool, request = gmgnRequest, balance = currentKolTokenBalance,
  market = nodeMarketService, now = Date.now }: { db?: Db; request?: typeof gmgnRequest; balance?: typeof currentKolTokenBalance;
    market?: Pick<typeof nodeMarketService, 'importObservations'>; now?: () => number } = {}) {
  async function queuePublicKols() {
    // This is worker discovery, never a page-request fallback. Private memberships are excluded.
    await db.query(`INSERT INTO node_import_jobs(wallet_address,token_address,priority)
      SELECT p.wallet_address,p.token_address,MAX(p.priority) FROM (
        SELECT t.wallet_address,t.token_address,CASE WHEN SUM(CASE WHEN t.side='buy' THEN t.token_amount ELSE -t.token_amount END)>0 THEN 10 ELSE 0 END AS priority
        FROM trades t GROUP BY t.wallet_address,t.token_address
        UNION SELECT b.wallet_address,b.token_address,1 FROM node_accounting_baselines b
      ) p JOIN kols k ON k.address=p.wallet_address AND k.is_tracked JOIN tokens v ON v.address=p.token_address
      LEFT JOIN node_monitored_wallets n ON n.wallet_address=p.wallet_address AND n.active
      WHERE ${kolProfileTokenSql()} AND NOT EXISTS(SELECT 1 FROM node_accounting_baselines b
        WHERE b.wallet_address=p.wallet_address AND b.token_address=p.token_address AND b.invalidated_at IS NULL
          AND (n.registration_block IS NULL OR b.checkpoint_block>=n.registration_block))
      AND NOT EXISTS(SELECT 1 FROM node_accounting_snapshots s WHERE s.scope_key='public' AND s.wallet_address=p.wallet_address
        AND s.token_address=p.token_address AND s.complete AND s.invalidated_at IS NULL
        AND (n.registration_block IS NULL OR s.as_of>=n.registered_at AND s.valuation_block>=n.registration_block))
      GROUP BY p.wallet_address,p.token_address
      ON CONFLICT(wallet_address,token_address) DO UPDATE SET priority=GREATEST(node_import_jobs.priority,EXCLUDED.priority)`);
    // Re-tracking starts a new monitoring generation. An old checkpoint cannot
    // account for the unmonitored interval, even if its token balance was zero.
    // Restart the traversal without discarding any completed provider evidence.
    await db.query(`UPDATE node_import_jobs j SET stage='history',cursor=NULL,head_fingerprint=NULL,history_complete=false,
      aggregate=NULL,aggregate_checked_at=NULL,aggregate_orders='{}',chart_from=NULL,chart_to=NULL,chart_cursor=NULL,chart_gaps=false,
      pagination_cursors='{}',requested_at=now(),next_attempt_at=now(),completed_at=NULL,lease_id=NULL,lease_until=NULL,last_error=NULL
      FROM node_monitored_wallets n JOIN kols k ON k.address=n.wallet_address AND k.is_tracked
      WHERE j.wallet_address=n.wallet_address AND n.active AND j.requested_at<n.registered_at
        AND NOT EXISTS(SELECT 1 FROM node_accounting_baselines b WHERE b.wallet_address=j.wallet_address AND b.token_address=j.token_address
          AND b.invalidated_at IS NULL AND b.checkpoint_block>=n.registration_block)
        AND (j.lease_until IS NULL OR j.lease_until<now())`);
    await db.query(`INSERT INTO node_import_wallet_jobs(wallet_address) SELECT address FROM kols WHERE is_tracked ON CONFLICT DO NOTHING`);
    await db.query(`UPDATE node_import_wallet_jobs j SET stage='history',cursor=NULL,pagination_cursors='{}',
      head_fingerprint=NULL,head_verified_at=NULL,head_verified_fingerprint=NULL,requested_at=now(),next_attempt_at=now(),
      completed_at=NULL,lease_id=NULL,lease_until=NULL,last_error=NULL
      FROM node_monitored_wallets n JOIN kols k ON k.address=n.wallet_address AND k.is_tracked
      WHERE j.wallet_address=n.wallet_address AND n.active AND j.requested_at<n.registered_at
        AND (j.lease_until IS NULL OR j.lease_until<now())`);
  }
  const urlFor = (pathname: string, params: Record<string, string>) => {
    const url = new URL(`https://openapi.gmgn.ai/v1/${pathname}`);
    for (const [key, value] of Object.entries({ chain: 'bsc', timestamp: String(Math.floor(now() / 1000)), client_id: randomUUID(), ...params })) url.searchParams.set(key, value);
    return url;
  };
  async function discoverWalletTick() {
    const lease=randomUUID(),job=(await db.query(`UPDATE node_import_wallet_jobs SET lease_id=$1,lease_until=now()+interval '90 seconds',attempts=attempts+1
      WHERE wallet_address IN(SELECT j.wallet_address FROM node_import_wallet_jobs j JOIN kols k ON k.address=j.wallet_address AND k.is_tracked
        WHERE j.stage IN ('history','verify') AND j.next_attempt_at<=now() AND (j.lease_until IS NULL OR j.lease_until<now()) ORDER BY j.requested_at,j.wallet_address LIMIT 1 FOR UPDATE OF j SKIP LOCKED) RETURNING *`,[lease])).rows[0];
    if(!job)return {status:'idle'};
    const started=now();
    try {
      const verifying=job.stage==='verify',cursor=verifying?null:job.cursor;
      const url=urlFor('user/wallet_activity',{wallet_address:job.wallet_address,limit:'50',...(cursor?{cursor}:{})});
      for(const type of ['buy','sell','transferIn','transferOut'])url.searchParams.append('type',type);
      const response=await request(url,{workload:'accounting',priority:'prefetch',weight:3,timeoutMs:8000}),body=response.data??response;
      const tokens=normalizeImportedWalletDiscovery(body.activities,job.wallet_address,now()),next=body.next==null||body.next===''?null:body.next;
      if(next!==null&&(typeof next!=='string'||next.length>4096||!verifying&&(next===cursor||(job.pagination_cursors??[]).includes(next))))throw new Error('import_cursor_invalid');
      const payload={version:1,tokens,activityCount:body.activities.length,
        movements:body.activities.map((row:any)=>({tokenAddress:String(row.token.address).toLowerCase(),timestamp:new Date(Number(row.timestamp)*1000).toISOString(),
          kind:String(row.event_type??row.type).replace(/[_-]/g,'').toLowerCase(),txHash:String(row.tx_hash).toLowerCase()}))};
      if(payload.movements.some((row:any,index:number)=>index>0&&Date.parse(row.timestamp)>Date.parse(payload.movements[index-1].timestamp)))throw new Error('import_history_order_invalid');
      const client=await db.connect();
      try {await client.query('BEGIN');
        const locked=(await client.query(`SELECT j.lease_id FROM node_import_wallet_jobs j JOIN kols k ON k.address=j.wallet_address AND k.is_tracked
          WHERE j.wallet_address=$1 FOR UPDATE OF j`,[job.wallet_address])).rows[0];
        if(locked?.lease_id!==lease)throw new Error('import_lease_lost');
        if(verifying) {
          const pages=(await client.query('SELECT payload FROM node_import_wallet_pages WHERE wallet_address=$1',[job.wallet_address])).rows;
          const known=new Set(pages.flatMap(page=>(page.payload.movements??[]).map((item:any)=>digest(item))));
          const newOld=payload.movements.some((item:any)=>Date.parse(item.timestamp)<=Date.parse(job.requested_at)&&!known.has(digest(item)));
          const check={version:1,movements:payload.movements,nextCursor:next,originalHeadFingerprint:job.head_fingerprint};
          const checkFingerprint=digest(check);
          await client.query(`INSERT INTO node_import_wallet_head_checks(wallet_address,payload_hash,payload,cutoff_at) VALUES($1,$2,$3::jsonb,$4)
            ON CONFLICT(wallet_address,payload_hash) DO UPDATE SET checked_at=now()`,[job.wallet_address,checkFingerprint,JSON.stringify(check),job.requested_at]);
          if(!newOld) {
            await client.query(`UPDATE node_import_wallet_jobs SET stage='done',completed_at=now(),head_verified_at=now(),head_verified_fingerprint=$3,
              lease_id=NULL,lease_until=NULL,last_error=NULL WHERE wallet_address=$1 AND lease_id=$2`,[job.wallet_address,lease,checkFingerprint]);
            await client.query('COMMIT');return {status:'progress',stage:'wallet_discovery_verified',durationMs:now()-started};
          }
          // Newly exposed pre-cutoff evidence needs another complete traversal.
          // Retain all prior page versions and restart from this fresh head.
          await client.query(`UPDATE node_import_wallet_jobs SET cursor=$2,pagination_cursors=ARRAY['head']::text[],head_fingerprint=$3,
            stage=CASE WHEN $2::text IS NULL THEN 'verify' ELSE 'history' END,head_verified_at=NULL,head_verified_fingerprint=NULL,
            lease_id=NULL,lease_until=NULL,next_attempt_at=now() WHERE wallet_address=$1 AND lease_id=$4`,[job.wallet_address,next,digest(payload),lease]);
        }
        for(const token of tokens) {
          await client.query(`INSERT INTO tokens(address,symbol,name) VALUES($1,$2,$3) ON CONFLICT(address) DO UPDATE SET
            symbol=COALESCE(tokens.symbol,EXCLUDED.symbol),name=COALESCE(tokens.name,EXCLUDED.name)`,[token.address,token.symbol,token.name]);
          await client.query(`INSERT INTO node_import_jobs(wallet_address,token_address,priority) VALUES($1,$2,1) ON CONFLICT DO NOTHING`,[job.wallet_address,token.address]);
        }
        const cursorKey=cursor??'head';
        await client.query(`INSERT INTO node_import_wallet_pages(wallet_address,cursor_key,payload_hash,next_cursor,payload) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,
          [job.wallet_address,cursorKey,digest(payload),next,JSON.stringify(payload)]);
        if(!verifying)await client.query(`UPDATE node_import_wallet_jobs SET cursor=$2,pagination_cursors=array_append(pagination_cursors,$3),stage=CASE WHEN $2::text IS NULL THEN 'verify' ELSE stage END,
          head_fingerprint=CASE WHEN $3='head' THEN $5 ELSE head_fingerprint END,head_verified_at=NULL,head_verified_fingerprint=NULL,
          lease_id=NULL,lease_until=NULL,last_error=NULL,next_attempt_at=now() WHERE wallet_address=$1 AND lease_id=$4`,[job.wallet_address,next,cursorKey,lease,digest(payload)]);
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
      return {status:'progress',stage:'wallet_discovery',tokens:tokens.length,durationMs:now()-started};
    }catch(error){const {reason,retryAfterMs:wait}=historicalImportRetry(error,job.attempts);
      await db.query(`UPDATE node_import_wallet_jobs SET lease_id=NULL,lease_until=NULL,last_error=$3,next_attempt_at=now()+$4*interval '1 millisecond' WHERE wallet_address=$1 AND lease_id=$2`,[job.wallet_address,lease,reason,wait]);
      return {status:'retry',stage:'wallet_discovery',reason,durationMs:now()-started};}
  }
  async function page(wallet: string, token: string, cursor: string | null) {
    const url = urlFor('user/wallet_activity', { wallet_address: wallet, token_address: token, limit: '50', ...(cursor ? { cursor } : {}) });
    for (const type of ['buy', 'sell', 'transferIn', 'transferOut']) url.searchParams.append('type', type);
    const response = await request(url, { workload: 'accounting', priority: 'prefetch', weight: 3, timeoutMs: 8000 });
    const body = response.data ?? response, next = body.next == null || body.next === '' ? null : body.next;
    if (next !== null && (typeof next !== 'string' || next.length > 4096 || next === cursor)) throw new Error('import_cursor_invalid');
    const rows=normalizeImportedMovements(body.activities, wallet, token, now());
    if(rows.some((row,index)=>index>0&&Date.parse(row.event.timestamp)>Date.parse(rows[index-1].event.timestamp))) throw new Error('import_history_order_invalid');
    return { rows, next: next as string | null };
  }
  async function persistMovements(client:Pick<Pool,'query'>,wallet:string,token:string,rows:ReturnType<typeof normalizeImportedMovements>) {
    for(const row of rows) {
      const previous=(await client.query('SELECT payload_hash,event FROM node_import_movements WHERE wallet_address=$1 AND token_address=$2 AND id=$3',[wallet,token,row.event.id])).rows[0];
      if(previous&&digest(previous.event)!==digest(row.event)) throw new Error('import_movement_conflict');
      await client.query(`INSERT INTO node_import_movements(wallet_address,token_address,id,event,raw,payload_hash) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6) ON CONFLICT DO NOTHING`,
        [wallet,token,row.event.id,JSON.stringify(row.event),JSON.stringify(row.raw),digest(row.event)]);
    }
  }
  async function persistPage(client:Pick<Pool,'query'>,wallet:string,token:string,cursorKey:string,result:Awaited<ReturnType<typeof page>>) {
    const payloadHash=digest({events:result.rows.map(row=>row.event),next:result.next}),payload=JSON.stringify(result);
    await client.query(`INSERT INTO node_import_page_versions(wallet_address,token_address,cursor_key,payload_hash,payload) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,[wallet,token,cursorKey,payloadHash,payload]);
    await client.query(`INSERT INTO node_import_pages(wallet_address,token_address,cursor_key,next_cursor,payload,payload_hash) VALUES($1,$2,$3,$4,$5::jsonb,$6)
      ON CONFLICT(wallet_address,token_address,cursor_key) DO UPDATE SET next_cursor=EXCLUDED.next_cursor,payload=EXCLUDED.payload,payload_hash=EXCLUDED.payload_hash,observed_at=now()`,[wallet,token,cursorKey,result.next,payload,payloadHash]);
    return payloadHash;
  }
  async function savePage(job: any) {
    const wallet = job.wallet_address, token = job.token_address, result = await page(wallet, token, job.cursor);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const locked = (await client.query('SELECT lease_id FROM node_import_jobs WHERE wallet_address=$1 AND token_address=$2 FOR UPDATE', [wallet, token])).rows[0];
      if (locked?.lease_id !== job.lease_id) throw new Error('import_lease_lost');
      const cursorKey = job.cursor ?? 'head';
      const seen:string[]=job.pagination_cursors??[];
      if(result.next&&seen.includes(result.next)) throw new Error('import_cursor_cycle');
      const swapped=new Set(result.rows.filter(row=>['buy','sell'].includes(row.event.kind)).map(row=>row.event.txHash));
      if(result.rows.some(row=>row.event.kind.startsWith('transfer')&&swapped.has(row.event.txHash))) throw new Error('import_swap_transfer_ambiguous');
      await persistMovements(client,wallet,token,result.rows);
      const payloadHash=await persistPage(client,wallet,token,cursorKey,result);
      await client.query(`UPDATE node_import_jobs SET cursor=$3,head_fingerprint=COALESCE($4,head_fingerprint),history_complete=$5,
        pagination_cursors=array_append(pagination_cursors,$6),stage=CASE WHEN $5 THEN 'aggregate' ELSE stage END WHERE wallet_address=$1 AND token_address=$2`,
      [wallet, token, result.next, job.cursor ? null : payloadHash, result.next === null,cursorKey]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async function aggregate(job: any) {
    const orders=['amount_percentage','profit','buy_volume_cur'],completed:string[]=job.aggregate_orders??[];
    const order=orders.find(order=>!completed.includes(order));
    if(!order){await db.query("UPDATE node_import_jobs SET aggregate_checked_at=now(),stage='reconcile' WHERE wallet_address=$1 AND token_address=$2",[job.wallet_address,job.token_address]);return;}
    const url = urlFor('market/token_top_traders', { address: job.token_address, limit: '100', order_by: order, direction: 'desc', ...(order === 'amount_percentage' ? {} : { tag: 'renowned' }) });
    const response = await request(url, { workload: 'accounting', priority: 'prefetch', weight: 5, timeoutMs: 8000 });
    const list=(response.data??response)?.list;
    if(!Array.isArray(list)||list.length>100)throw new Error('import_aggregate_response_invalid');
    const found=list.find((row:any)=>String(row.address).toLowerCase()===job.wallet_address)??null;
    if (found) await db.query(`INSERT INTO node_import_aggregates(wallet_address,token_address,payload_hash,payload) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`, [job.wallet_address, job.token_address, digest(found), JSON.stringify(found)]);
    // One scan per lease preserves completed negative results across provider
    // pacing/cooldowns. Retrying a later order never repeats the first scan.
    await db.query(`UPDATE node_import_jobs SET aggregate=$3::jsonb,aggregate_checked_at=now(),aggregate_orders=array_append(aggregate_orders,$4),
      stage=CASE WHEN $5 THEN 'reconcile' ELSE 'aggregate' END WHERE wallet_address=$1 AND token_address=$2 AND lease_id=$6`,
      [job.wallet_address,job.token_address,JSON.stringify(found),order,!!found||orders.every(item=>item===order||completed.includes(item)),job.lease_id]);
  }
  async function reconcile(job: any) {
    const wallet = job.wallet_address, token = job.token_address;
    const checkpoint = (await db.query(`SELECT b.block_number::text,b.block_hash,b.timestamp FROM node_evidence_blocks b
      JOIN node_monitored_wallets w ON w.wallet_address=$1 AND w.decoded_through_block=b.block_number
      WHERE w.active AND w.registration_block IS NOT NULL AND b.block_number>=w.registration_block`, [wallet])).rows[0];
    if (!checkpoint) throw new Error('import_node_checkpoint_pending');
    const metadata = (await db.query(`SELECT decimals FROM node_market_token_evidence WHERE token_address=$1 AND block_number<=$2
      ORDER BY block_number DESC LIMIT 1`, [token,checkpoint.block_number])).rows[0];
    if (!Number.isInteger(metadata?.decimals)) throw new Error('import_decimals_unavailable');
    const proof: KolTokenBalanceProof = await balance({ wallet, token, decimals: metadata.decimals, blockNumber: checkpoint.block_number });
    if (proof.blockHash !== checkpoint.block_hash) throw new Error('import_balance_unavailable');
    let movements = (await db.query(`SELECT event FROM node_import_movements WHERE wallet_address=$1 AND token_address=$2 ORDER BY (event->>'timestamp')::timestamptz,id`, [wallet, token])).rows.map(row => row.event as JournalLedgerEvent);
    // Refresh the head after pagination: a changed result must not silently mix two provider snapshots.
    const head = await page(wallet, token, null), savedIds=new Set(movements.map(event=>event.id));
    const added=head.rows.some(row=>!savedIds.has(row.event.id)),bridged=head.rows.some(row=>savedIds.has(row.event.id));
    // Page data and the comparison head advance together. The old implementation
    // kept comparing against its original head forever after a new trade.
    const headClient=await db.connect();
    try {await headClient.query('BEGIN');
      const locked=(await headClient.query('SELECT lease_id FROM node_import_jobs WHERE wallet_address=$1 AND token_address=$2 FOR UPDATE',[wallet,token])).rows[0];
      if(locked?.lease_id!==job.lease_id) throw new Error('import_lease_lost');
      await persistMovements(headClient,wallet,token,head.rows);const fingerprint=await persistPage(headClient,wallet,token,'head',head);
      const needsBridge=added&&!bridged&&head.next!==null;
      await headClient.query(`UPDATE node_import_jobs SET head_fingerprint=$3,
        stage=CASE WHEN $4 THEN 'history' WHEN $5 THEN 'aggregate' ELSE stage END,
        cursor=CASE WHEN $4 THEN $6 ELSE cursor END,history_complete=CASE WHEN $4 THEN false ELSE history_complete END,
        pagination_cursors=CASE WHEN $4 THEN ARRAY['head']::text[] ELSE pagination_cursors END WHERE wallet_address=$1 AND token_address=$2`,
      [wallet,token,fingerprint,needsBridge,added,head.next]);await headClient.query('COMMIT');
      if(needsBridge||added)return;
    }catch(error){await headClient.query('ROLLBACK');throw error;}finally{headClient.release();}
    const retained=(await db.query(`SELECT event,raw->'token_amount' AS raw_quantity FROM node_import_movements WHERE wallet_address=$1 AND token_address=$2 ORDER BY (event->>'timestamp')::timestamptz,id`,[wallet,token])).rows;
    const rawQuantities=new Map(retained.map(row=>[row.event.id,row.raw_quantity]));
    movements=retained.map(row=>row.event as JournalLedgerEvent);
    const events = movements.filter(event => Date.parse(event.timestamp) <= Date.parse(proof.blockTimestamp));
    const swaps=new Set(events.filter(event=>['buy','sell'].includes(event.kind)).map(event=>event.txHash));
    if(events.some(event=>event.kind.startsWith('transfer')&&swaps.has(event.txHash)))throw new Error('import_swap_transfer_ambiguous');
    const canonical = (await db.query(`SELECT tx_hash,side,token_amount::text,block_number::text,block_hash,execution_id,timestamp FROM trades WHERE wallet_address=$1 AND token_address=$2 AND block_number IS NOT NULL AND block_number<=$3 AND side IN ('buy','sell')`, [wallet, token, proof.blockNumber])).rows;
    const grouped = new Map<string, typeof canonical>();
    const canonicalIds=new Set<string>();
    for (const trade of canonical) { const key = `${trade.tx_hash}:${trade.side}`; grouped.set(key, [...(grouped.get(key) ?? []), trade]); }
    for (const trades of grouped.values()) {
      const matches = events.filter(event => event.txHash === trades[0].tx_hash && event.kind === trades[0].side);
      const rawExecutions=trades.some(trade=>decimal(trade.token_amount)===null)?(await db.query(`SELECT e.id,f.delta_raw::text
        FROM node_executions e JOIN node_execution_flows f ON f.execution_id=e.id AND f.token_address=$2
        WHERE e.wallet_address=$1 AND e.tx_hash=$3 AND e.block_number=$4 AND e.block_hash=$5 AND e.status='success'
        AND e.kind IN('transaction','user_operation') AND CASE WHEN $6='buy' THEN f.delta_raw>0 ELSE f.delta_raw<0 END
        AND($7::boolean OR e.id=ANY($8::text[]))`,[wallet,token,trades[0].tx_hash,trades[0].block_number,trades[0].block_hash,
        trades[0].side,trades.some(trade=>!trade.execution_id),trades.map(trade=>trade.execution_id).filter(Boolean)])).rows:[];
      // Current confirmed decimals express raw token inventory in the same unit
      // as the ending balance; they do not assert a historical USD valuation.
      const canonicalQuantity=importedCanonicalQuantity(trades,rawExecutions,metadata.decimals);
      if (!matches.length || !importedQuantityMatches(matches.length===1?rawQuantities.get(matches[0].id)??matches[0].tokenAmount:sumJournalDecimals(matches.map(event => event.tokenAmount)), canonicalQuantity, metadata.decimals,'gmgn_float_display')
        ||trades.some(trade=>matches.some(event=>Math.abs(Date.parse(event.timestamp)-Date.parse(trade.timestamp))>1000))) throw new Error('import_overlap_mismatch');
      // An independently known execution quantity supersedes provider display
      // rounding. Its raw imported row and unset historical block remain intact.
      if(matches.length===1){matches[0].tokenAmount=canonicalQuantity;canonicalIds.add(matches[0].id);}
    }
    const ledger = calculateJournalLedger({ wallets: [wallet], events, coverage: [{ walletAddress: wallet, tokenAddress: token, complete: true }],
      valuations: [{ tokenAddress: token, priceUsd: '1', pricedAt: proof.blockTimestamp, balances: [{ walletAddress: wallet, tokenAmount: proof.balance, tolerance: '0' }] }], asOf: proof.blockTimestamp });
    const position = ledger.positions[0], lots = ledger.closingLots?.find(row => row.walletAddress === wallet && row.tokenAddress === token)?.lots.map(lot=>({...lot}));
    if (!position || !lots || !position.remainingTokenAmount || !importedQuantitySumMatches(position.remainingTokenAmount,proof.balance,metadata.decimals,
      events.filter(event=>!canonicalIds.has(event.id)).map(event=>rawQuantities.get(event.id)??event.tokenAmount),'gmgn_float_display')) throw new Error('import_balance_mismatch');
    if(position.remainingTokenAmount!==proof.balance&&lots.length) {
      const lot=lots.at(-1)!,adjusted=sumJournalDecimals([lot.tokenAmount,proof.balance,`-${position.remainingTokenAmount}`]);
      if(adjusted.startsWith('-'))throw new Error('import_balance_mismatch');
      if(lot.costBasisUsd!==null)lot.costBasisUsd=journalDecimalMultiply(lot.costBasisUsd,journalDecimalDivide(adjusted,lot.tokenAmount)!)!;
      lot.tokenAmount=adjusted;if(adjusted==='0')lots.pop();
    }
    let feesUsd: string | null = position.reasons.includes('fees_incomplete')?null:position.feesUsd,
      feeInclusiveCapitalUsd = position.reasons.includes('fees_incomplete')?null:position.feeInclusiveCapitalUsd,
      realizedProfitUsd = position.realizedProfitUsd;
    let investedUsd=position.investedUsd,soldUsd=position.soldUsd,incomingTransferCostUsd=position.incomingTransferCostUsd,transferOutIncomeUsd=position.transferOutIncomeUsd;
    const aggregateRow = job.aggregate;
    // Aggregate-only fees enter the baseline only. Original historical rows remain unchanged.
    if (aggregateRow) {
      const latestBlock=canonical.reduce((maximum,row)=>BigInt(row.block_number)>BigInt(maximum)?row.block_number:maximum,'0');
      const verified=validateImportedAggregate(aggregateRow,events,proof,metadata.decimals,latestBlock);
      if(MarketDecimal.parse(verified.totalFees).compare(MarketDecimal.parse(position.feesUsd))<0)throw new Error('import_aggregate_fee_mismatch');
      investedUsd=verified.bought;soldUsd=verified.sold;incomingTransferCostUsd=verified.incoming;transferOutIncomeUsd=verified.outgoing;
      feesUsd=verified.totalFees;feeInclusiveCapitalUsd=verified.capital;
      const acquisitionRows=events.filter(event=>['buy','transfer_in'].includes(event.kind)),knownBuyFees=acquisitionRows.every(event=>event.feeUsd!=null);
      const rowFees=knownBuyFees?sumJournalDecimals(acquisitionRows.map(event=>event.feeUsd!)):null;
      // Aggregate fee deltas are never assigned to original purchases or replay
      // frames. Unknown acquisition allocation leaves surviving FIFO lots unknown.
      if(verified.buyFees!=='0'&&(!knownBuyFees||!importedMoneyMatches(rowFees!,verified.buyFees)))for(const lot of lots)lot.costBasisUsd=null;
      const remainingBasis=lots.every(lot=>lot.costBasisUsd!==null)?sumJournalDecimals(lots.map(lot=>lot.costBasisUsd!)):null;
      realizedProfitUsd=remainingBasis===null?null:sumJournalDecimals([verified.sold,verified.outgoing,remainingBasis,`-${verified.bought}`,`-${verified.incoming}`,`-${verified.totalFees}`]);
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock_shared(782319)');
      const current=(await client.query('SELECT lease_id FROM node_import_jobs WHERE wallet_address=$1 AND token_address=$2 FOR UPDATE',[wallet,token])).rows[0];
      if(current?.lease_id!==job.lease_id)throw new Error('import_lease_lost');
      await saveNodeAccountingBaseline({query:client.query.bind(client)}, { wallet, token, checkpoint: proof, historyFingerprint: digest(events), overlapVerified: true, quantityVerified: true,
        ledger: { investedUsd, soldUsd, incomingTransferCostUsd,
          transferOutIncomeUsd, realizedProfitUsd, feesUsd, feeInclusiveCapitalUsd, lots }, events });
      const from = events[0]?.timestamp ?? proof.blockTimestamp;
      const ending=proof.balance==='0'?(events.at(-1)?.timestamp??proof.blockTimestamp):proof.blockTimestamp;
      await client.query(`UPDATE node_import_jobs SET stage='chart',chart_from=$3,chart_to=$4,chart_cursor=$4,
        priority=CASE WHEN priority>=100 THEN priority ELSE 0 END WHERE wallet_address=$1 AND token_address=$2`, [wallet, token, from, ending]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async function chart(job: any) {
    const tail=job.stage==='chart_tail',ending=Date.parse(job.chart_to),historyFrom=Date.parse(job.chart_from);
    const from = tail?Math.max(historyFrom,ending-6*3600_000):historyFrom, cursor = Date.parse(job.chart_cursor), duration = ending - from;
    if(!Number.isFinite(from)||!Number.isFinite(cursor)||!Number.isFinite(duration)||duration<0)throw new Error('import_chart_window_invalid');
    const seconds = tail?60:[60, 300, 3600, 14400, 86400].find(step => duration / (step * 1000) <= 3000) ?? 86400;
    const names: Record<number, string> = { 60: '1m', 300: '5m', 3600: '1h', 14400: '4h', 86400: '1d' };
    const step=seconds*1000,latest=Math.min(Math.floor((cursor-1)/step)*step,Math.floor(now()/step)*step-step);
    const pageFrom=Math.max(Math.floor(from/step)*step,latest-999*step);
    if(latest<pageFrom) {await db.query("UPDATE node_import_jobs SET stage='done',chart_gaps=true,completed_at=now() WHERE wallet_address=$1 AND token_address=$2",[job.wallet_address,job.token_address]);return;}
    let response:any=(await db.query(`SELECT payload FROM node_import_chart_pages WHERE token_address=$1 AND resolution=$2 AND from_at=$3 AND to_at=$4
      AND payload->>'requestLimit'='1000' ORDER BY observed_at DESC LIMIT 1`,
      [job.token_address,seconds,new Date(pageFrom),new Date(latest)])).rows[0]?.payload;
    if(!response) {
      const url=urlFor('market/token_kline',{address:job.token_address,resolution:names[seconds],from:String(pageFrom),to:String(latest),limit:'1000'});
      response=await request(url,{workload:'market',priority:'prefetch',weight:2,timeoutMs:8000});
    }
    const normalized=normalizeImportedChart(response,pageFrom,latest,seconds,now(),{requestLimit:1000});
    const body=response.data??response,raw=Array.isArray(body)?body:body.list??body.candles;
    const payload={data:raw,requestLimit:1000};
    await db.query(`INSERT INTO node_import_chart_pages(token_address,resolution,from_at,to_at,payload_hash,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`,
      [job.token_address,seconds,new Date(pageFrom),new Date(latest),digest(payload),JSON.stringify(payload)]);
    if(normalized.observations.length||normalized.retrievalComplete)await market.importObservations({token:job.token_address,importId:`${job.wallet_address}:${job.token_address}`,observations:normalized.observations,
      from:new Date(normalized.retrievalComplete?pageFrom:normalized.coverageFrom!).toISOString(),
      to:new Date(normalized.retrievalComplete?latest+step:normalized.coverageTo!).toISOString(),complete:true});
    // Providers may return fewer rows than the requested window (the live
    // endpoint can default to 100). Advance only past observed candles, never
    // past an unreturned left-hand interval. Completed sparse bars remain real.
    const nextCursor=normalized.retrievalComplete?pageFrom:normalized.coverageFrom??pageFrom;
    const complete=nextCursor<=Math.floor(from/step)*step;
    const needsTail=complete&&!tail&&seconds>60;
    await db.query(`UPDATE node_import_jobs SET chart_cursor=CASE WHEN $7 THEN chart_to ELSE $3::timestamptz END,chart_gaps=chart_gaps OR $5,
      stage=CASE WHEN $7 THEN 'chart_tail' WHEN $4 THEN 'done' ELSE stage END,completed_at=CASE WHEN $4 AND NOT $7 THEN now() ELSE NULL END
      WHERE wallet_address=$1 AND token_address=$2 AND lease_id=$6`,[job.wallet_address,job.token_address,new Date(nextCursor),complete,!normalized.complete,job.lease_id,needsTail]);
    if(complete&&!needsTail) {
      const ranges=(await db.query(`SELECT from_at,to_at FROM node_market_import_ranges WHERE token_address=$1 AND complete
        AND to_at>=$2::timestamptz AND from_at<=$3::timestamptz`,[job.token_address,job.chart_from,job.chart_to])).rows;
      const covered=nodeMarketCoverageComplete(new Date(job.chart_from).toISOString(),new Date(job.chart_to).toISOString(),
        ranges.map(row=>({from:new Date(row.from_at).toISOString(),to:new Date(row.to_at).toISOString(),source:'imported' as const})));
      await db.query('UPDATE node_import_jobs SET chart_gaps=$4 WHERE wallet_address=$1 AND token_address=$2 AND lease_id=$3',
        [job.wallet_address,job.token_address,job.lease_id,!covered]);
    }
  }
  async function tick() {
    // Live evidence has priority over migration traffic and enrichment.
    const lag = (await db.query(`SELECT ((SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node_collection')-
      (SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node'))::text AS lag`)).rows[0]?.lag;
    if (lag != null && BigInt(lag) > 512n) return { status: 'live_capture_priority' };
    const urgent=(await db.query(`SELECT 1 FROM node_import_jobs j JOIN kols k ON k.address=j.wallet_address AND k.is_tracked WHERE j.stage<>'done'
      AND j.priority>0 AND j.next_attempt_at<=now() AND (j.lease_until IS NULL OR j.lease_until<now()) LIMIT 1`)).rowCount;
    if(!urgent){const discovery=await discoverWalletTick();if(discovery.status!=='idle')return discovery;}
    const lease = randomUUID();
    const job = (await db.query(`UPDATE node_import_jobs SET lease_id=$1,lease_until=now()+interval '90 seconds',attempts=attempts+1 WHERE (wallet_address,token_address) IN
      (SELECT j.wallet_address,j.token_address FROM node_import_jobs j JOIN kols k ON k.address=j.wallet_address AND k.is_tracked
       WHERE stage<>'done' AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY priority DESC,requested_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED) RETURNING *`, [lease])).rows[0];
    if (!job) return { status: 'idle' };
    const started = now();
    try {
      if (job.stage === 'history') await savePage(job);
      else if (job.stage === 'aggregate') await aggregate(job);
      else if (job.stage === 'reconcile') await reconcile(job);
      else if (job.stage === 'chart'||job.stage==='chart_tail') await chart(job);
      await db.query('UPDATE node_import_jobs SET lease_id=NULL,lease_until=NULL,last_error=NULL,next_attempt_at=now() WHERE wallet_address=$1 AND token_address=$2 AND lease_id=$3', [job.wallet_address, job.token_address, lease]);
      return { status: 'progress', stage: job.stage, durationMs: now() - started };
    } catch (error) {
      const { reason, retryAfterMs: wait } = historicalImportRetry(error, job.attempts);
      await db.query(`UPDATE node_import_jobs SET lease_id=NULL,lease_until=NULL,last_error=$4,next_attempt_at=now()+$5*interval '1 millisecond' WHERE wallet_address=$1 AND token_address=$2 AND lease_id=$3`, [job.wallet_address, job.token_address, lease, reason, wait]);
      return { status: 'retry', reason, stage: job.stage, durationMs: now() - started };
    }
  }
  /** Reopen only an explicitly requested incomplete public chart, retaining all pages and cooldowns. */
  async function resumeChartGaps(wallet:string,token:string,window?:{from:string;to:string}) {
    if(!addr.test(wallet)||!addr.test(token))throw new Error('import_chart_identity_invalid');
    if(window&&(!Number.isFinite(Date.parse(window.from))||!Number.isFinite(Date.parse(window.to))||Date.parse(window.to)<Date.parse(window.from)||Date.parse(window.to)>now()+1000))throw new Error('import_chart_window_invalid');
    return (await db.query(`UPDATE node_import_jobs j SET stage='chart',chart_cursor=LEAST(GREATEST(chart_to,$4::timestamptz),b.checkpoint_timestamp),
      chart_from=LEAST(chart_from,$3::timestamptz),chart_to=LEAST(GREATEST(chart_to,$4::timestamptz),b.checkpoint_timestamp),completed_at=NULL,
      priority=GREATEST(priority,100),next_attempt_at=CASE WHEN last_error IS NULL THEN LEAST(next_attempt_at,now()) ELSE next_attempt_at END
      FROM node_accounting_baselines b WHERE j.wallet_address=$1 AND j.token_address=$2 AND j.stage='done'
      AND (chart_gaps OR LEAST($4::timestamptz,b.checkpoint_timestamp)>chart_to)
      AND EXISTS(SELECT 1 FROM kols k WHERE k.address=j.wallet_address AND k.is_tracked)
      AND b.wallet_address=j.wallet_address AND b.token_address=j.token_address AND b.invalidated_at IS NULL
      RETURNING j.wallet_address`,[wallet,token,window?.from??null,window?.to??null])).rowCount===1;
  }
  return { queuePublicKols, tick, resumeChartGaps };
}
export const nodeHistoricalImporter = createNodeHistoricalImporter();
