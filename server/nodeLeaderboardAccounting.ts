import { createHash } from 'node:crypto';
import type { NodeAccountingEvidence } from './nodeAccounting.js';
import type { NodeLeaderboardCalculationRequest } from './nodeLeaderboard.js';
import type { NodeLeaderboardSnapshot } from '../shared/nodeLeaderboard.js';
import { calculateJournalLedgerPeriod, journalDecimalMultiply, sumJournalDecimals,
  type JournalLedgerEvent, type JournalLedgerPeriodFeeEvent } from './nodeAccountingLedger.js';
import { kolProfileTokenSql } from './kolProfileToken.js';
import { TRUSTED_QUOTE_FEEDS } from './nodeMarketProtocols.js';

type Pair = { wallet_address:string; token_address:string; latest_block:string|null; latest_at:string;
  payload:NodeAccountingEvidence|null; history_revision:string|null; canonical:boolean; baseline_at:string|null;
  baseline_ledger:any; generation:string|null; registered_at:string|null; collected:string|null; decoded:string|null;
  repair:string|null; unresolved:boolean; approved_block?:string|null; approved_at?:string|Date|null; financial_revision?:string;
  baseline_block?:string|null;baseline_hash?:string|null;baseline_balance?:string|null;baseline_fingerprint?:string|null;baseline_canonical?:boolean;baseline_history_complete?:boolean };
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonicalJson=(value:unknown):unknown=>Array.isArray(value)?value.map(canonicalJson):value&&typeof value==='object'
  ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonicalJson(item)])):value;
const importedHistoryDigest=(value:unknown)=>digest(canonicalJson(value));
const asIso=(value:string|Date)=>new Date(value).toISOString();
const validBlock=(value:unknown):value is string=>typeof value==='string'&&/^\d+$/.test(value);
const negative=(value:string)=>value==='0'?'0':value.startsWith('-')?value.slice(1):'-'+value;
const financialEvidenceSql=`encode(sha256(convert_to(jsonb_build_array(h.payload->'events',h.payload->'historicalEvents',
  h.payload->'baselines',h.payload->'openingBalances',h.payload->'source',h.payload->'monitoringGeneration')::text,'UTF8')),'hex')`;

/** A period can start after a reconciled baseline, or be reconstructed from
 * its retained genuine movements. Aggregate fee differences never become
 * synthetic dated costs. */
export function publicLeaderboardPeriodInput(pair:Pair,windowStart:string,windowEnd:string){
  const prepared=pair.payload,reason=new Set<string>();
  const unavailable=(why:string)=>({events:[] as JournalLedgerEvent[],baselines:[],openingBalances:[],periodClosedBaselines:[],valuation:undefined,complete:false,reasons:[why]});
  if(!prepared)return unavailable('accounting_pending');
  if(!Array.isArray(prepared.events)||!Array.isArray(prepared.historicalEvents)||!Array.isArray(prepared.baselines)
    ||!Array.isArray(prepared.openingBalances)||!prepared.coverage
    ||[...prepared.baselines,...prepared.openingBalances].some(row=>row.walletAddress!==pair.wallet_address||row.tokenAddress!==pair.token_address)
    ||[...prepared.historicalEvents,...prepared.events].some(event=>event.walletAddress!==pair.wallet_address||event.tokenAddress!==pair.token_address
      ||!Number.isFinite(Date.parse(event.timestamp))))return unavailable('accounting_evidence_invalid');
  const usesBaseline=prepared.baselines.length>0||prepared.historyBoundary==='imported_baseline';
  const baselineInside=usesBaseline&&pair.baseline_at!=null&&Date.parse(pair.baseline_at)>=Date.parse(windowStart);
  const approvedTime=Math.min(Date.parse(windowEnd),Date.parse(asIso(pair.approved_at??windowEnd)));
  const baseline=prepared.baselines[0],{walletAddress:_wallet,tokenAddress:_token,...baselineLedger}=baseline??{};
  const wholeClosedHistory=baselineInside&&prepared.baselines.length===1&&pair.baseline_canonical===true&&pair.baseline_history_complete===true
    &&validBlock(pair.baseline_block)&&/^0x[0-9a-f]{64}$/.test(pair.baseline_hash??'')&&pair.baseline_balance==='0'&&Array.isArray(pair.baseline_ledger?.lots)&&pair.baseline_ledger.lots.length===0
    &&Date.parse(pair.baseline_at!)<=approvedTime&&prepared.historicalEvents.length>0
    &&prepared.historicalEvents.every(event=>Date.parse(event.timestamp)>=Date.parse(windowStart)&&Date.parse(event.timestamp)<=Date.parse(pair.baseline_at!))
    &&prepared.events.every(event=>validBlock(event.blockNumber)&&BigInt(event.blockNumber)>BigInt(pair.baseline_block!))
    &&/^[a-f0-9]{64}$/.test(pair.baseline_fingerprint??'')&&importedHistoryDigest(prepared.historicalEvents)===pair.baseline_fingerprint
    &&importedHistoryDigest(baselineLedger)===importedHistoryDigest(pair.baseline_ledger);
  const periodClosedBaselines=wholeClosedHistory?[{walletAddress:pair.wallet_address,tokenAddress:pair.token_address,
    checkpointTimestamp:asIso(pair.baseline_at!),checkpointBlock:pair.baseline_block!,checkpointHash:pair.baseline_hash!,balance:pair.baseline_balance!,verified:true as const,historyComplete:true as const,
    historyFingerprint:pair.baseline_fingerprint!,scope:'lifetime' as const,baseline,events:prepared.historicalEvents}]:[];
  const historical=baselineInside&&!wholeClosedHistory?prepared.historicalEvents:[];
  const events=[...historical,...prepared.events].filter(event=>Date.parse(event.timestamp)<=approvedTime);
  const baselines=baselineInside?[]:prepared.baselines;
  if(baselineInside&&!wholeClosedHistory){
    if(!historical.length)reason.add('historical_period_unavailable');
    // A proved fully closed old cycle cannot allocate any of its aggregate
    // fees to an independent new purchase after the checkpoint. Its dated
    // fees are irrelevant only when every retained movement predates this
    // entire window and the reconciled baseline holds no surviving lots.
    const oldCycleClosed=historical.length>0&&Array.isArray(pair.baseline_ledger?.lots)&&pair.baseline_ledger.lots.length===0
      &&historical.every(event=>Date.parse(event.timestamp)<Date.parse(windowStart));
    const aggregateFees=pair.baseline_ledger?.feesUsd;
    if(!oldCycleClosed&&(typeof aggregateFees!=='string'||historical.some(event=>event.feeUsd==null)))reason.add('historical_fee_allocation_unknown');
    else if(!oldCycleClosed){
      const fees=new Map<string,string>();let contradictory=false;
      for(const event of historical){const key=`${event.walletAddress}:${event.feeId??event.txHash}`,prior=fees.get(key);
        if(prior!==undefined&&prior!==event.feeUsd)contradictory=true;fees.set(key,event.feeUsd!);}
      if(contradictory||sumJournalDecimals([aggregateFees,negative(sumJournalDecimals([...fees.values()]))])!=='0')reason.add('historical_fee_allocation_unknown');
    }
  }
  if(!pair.canonical)reason.add('chain_reorganization');
  if(!prepared.monitoringGeneration||prepared.monitoringGeneration!==pair.generation)reason.add('collection_pending');
  if(!validBlock(prepared.throughBlock)||pair.latest_block!=null&&BigInt(prepared.throughBlock)<BigInt(pair.latest_block))reason.add('accounting_pending');
  if(pair.approved_block!==undefined&&(!validBlock(pair.approved_block)||!validBlock(prepared.throughBlock)
    ||BigInt(prepared.throughBlock)>BigInt(pair.approved_block)))reason.add('accounting_pending');
  if(pair.unresolved)reason.add('unsupported_execution_decoder');
  // Current spot prices and an unchanged old balance observation are not inputs
  // to realized P&L. Complete movement quantities still have to be established.
  if(!prepared.coverage.quantitiesComplete)reason.add(prepared.coverage.reason??'history_incomplete');
  const proof=prepared.proof;
  const validProof=proof?.chain==='bsc'&&proof.walletAddress===pair.wallet_address&&proof.tokenAddress===pair.token_address
    &&proof.blockNumber===prepared.throughBlock&&/^0x[0-9a-f]{64}$/.test(proof.blockHash)
    &&/^\d+(?:\.\d+)?$/.test(proof.balance)&&Date.parse(proof.blockTimestamp)<=approvedTime;
  if(!validProof)reason.add('balance_unavailable');
  return{events,baselines,openingBalances:prepared.openingBalances,periodClosedBaselines,
    valuation:validProof?{tokenAddress:pair.token_address,priceUsd:null,pricedAt:proof!.blockTimestamp,
      balances:[{walletAddress:pair.wallet_address,tokenAmount:proof!.balance}]}:undefined,
    complete:reason.size===0,reasons:[...reason].sort()};
}

/** Bounded worker-side adapter. Ordinary HTTP requests only read its committed
 * rollups. It joins existing accounting jobs instead of scanning RPC history or
 * starting a second valuation/cache implementation. */
export async function loadPublicNodeLeaderboardAccounting(request:NodeLeaderboardCalculationRequest):Promise<NodeLeaderboardSnapshot[]>{
  const {database:db,windowStart,windowEnd}=request;
  const requested=[...new Set(request.wallets)].filter(wallet=>/^0x[a-f0-9]{40}$/.test(wallet)).sort();
  if(!requested.length)return[];
  if(!Number.isFinite(Date.parse(windowStart))||!Number.isFinite(Date.parse(windowEnd))||Date.parse(windowEnd)<Date.parse(windowStart))throw Error('invalid_leaderboard_window');
  const wallets=(await db.query(`SELECT address FROM published_kols WHERE is_tracked AND address=ANY($1::text[]) ORDER BY address`,[requested])).rows.map(row=>row.address as string);
  if(!wallets.length)return[];
  let monitoring:any[]=[];
  request.beforePublish?.(async publication=>{
    if(!monitoring.length)return;
    // Match bootstrap's wallet-before-history lock order. Fee-only/empty-history
    // wallets need this proof too; ordinary forward capture remains allowed.
    let current;
    try { current=await publication.query(`SELECT m.wallet_address FROM node_monitored_wallets m
      JOIN jsonb_to_recordset($1::jsonb) wanted(wallet_address text,generation text,registration_block text,registered_at timestamptz,
        repair_from_block text,collected_through_block text,decoded_through_block text) ON m.wallet_address=wanted.wallet_address
      WHERE m.active AND m.generation::text=wanted.generation AND m.registration_block::text IS NOT DISTINCT FROM wanted.registration_block
        AND m.registered_at=wanted.registered_at AND m.repair_from_block::text IS NOT DISTINCT FROM wanted.repair_from_block
        AND COALESCE(m.collected_through_block,-1)>=COALESCE(wanted.collected_through_block::bigint,-1)
        AND COALESCE(m.decoded_through_block,-1)>=COALESCE(wanted.decoded_through_block::bigint,-1)
      ORDER BY m.wallet_address FOR SHARE OF m NOWAIT`,[JSON.stringify(monitoring)]);
    } catch(error) {
      // Forward collection updates its wallet batch in the executor's row
      // order. Never wait while holding a different wallet: the resulting
      // lock cycle can abort capture. Retry this optional publication instead.
      if((error as {code?:string}).code==='55P03')throw Error('node_leaderboard_monitoring_changed');
      throw error;
    }
    if(current.rows.length!==monitoring.length)throw Error('node_leaderboard_monitoring_changed');
  });
  const checkpoint=(await db.query(`SELECT b.block_number::text,b.block_hash,b.timestamp FROM node_evidence_blocks b
    WHERE b.block_number=(SELECT LEAST((decoded.value->>'blockNumber')::bigint,(collected.value->>'blockNumber')::bigint)
      FROM worker_state decoded CROSS JOIN worker_state collected WHERE decoded.key='node' AND collected.key='node_collection')
      AND b.timestamp<=$1::timestamptz`,[windowEnd])).rows[0];
  const rows=(await db.query(`WITH activity AS(
      SELECT e.wallet_address,f.token_address,max(e.block_number) latest_block,max(e.timestamp) latest_at
      FROM node_executions e JOIN node_execution_flows f ON f.execution_id=e.id JOIN tokens v ON v.address=f.token_address
      JOIN published_kols k ON k.address=e.wallet_address AND k.is_tracked
      WHERE e.wallet_address=ANY($1::text[]) AND e.timestamp BETWEEN $2::timestamptz AND $3::timestamptz
        AND e.block_number<=COALESCE($4::bigint,-1) AND ${kolProfileTokenSql('v')}
      GROUP BY e.wallet_address,f.token_address
      UNION ALL SELECT t.wallet_address,t.token_address,max(t.block_number),max(t.timestamp)
      FROM trades t JOIN tokens v ON v.address=t.token_address JOIN published_kols k ON k.address=t.wallet_address AND k.is_tracked
      WHERE t.wallet_address=ANY($1::text[]) AND t.block_number IS NOT NULL AND t.timestamp BETWEEN $2::timestamptz AND $3::timestamptz
        AND t.block_number<=COALESCE($4::bigint,-1) AND ${kolProfileTokenSql('v')} GROUP BY t.wallet_address,t.token_address
      UNION ALL SELECT m.wallet_address,m.token_address,NULL::bigint,max((m.event->>'timestamp')::timestamptz)
      FROM node_import_movements m JOIN node_accounting_baselines b USING(wallet_address,token_address)
      JOIN node_evidence_blocks proof ON proof.block_number=b.checkpoint_block AND proof.block_hash=b.checkpoint_hash
      JOIN tokens v ON v.address=m.token_address JOIN published_kols k ON k.address=m.wallet_address AND k.is_tracked
      WHERE m.wallet_address=ANY($1::text[]) AND b.invalidated_at IS NULL AND b.schema_version=2
        AND (m.event->>'timestamp')::timestamptz BETWEEN $2::timestamptz AND $3::timestamptz AND ${kolProfileTokenSql('v')}
      GROUP BY m.wallet_address,m.token_address
      UNION ALL SELECT p.wallet_address,item->>'tokenAddress',NULL::bigint,max((item->>'timestamp')::timestamptz)
      FROM node_import_wallet_pages p JOIN node_import_wallet_jobs j USING(wallet_address)
      JOIN published_kols k ON k.address=p.wallet_address AND k.is_tracked
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.payload->'movements','[]'::jsonb))item
      JOIN tokens v ON v.address=item->>'tokenAddress'
      WHERE p.wallet_address=ANY($1::text[]) AND j.stage='done' AND j.head_verified_fingerprint IS NOT NULL
        AND (item->>'timestamp')::timestamptz BETWEEN $2::timestamptz AND $3::timestamptz AND ${kolProfileTokenSql('v')}
      GROUP BY p.wallet_address,item->>'tokenAddress'), pairs AS(
      SELECT wallet_address,token_address,max(latest_block)::text latest_block,max(latest_at) latest_at FROM activity GROUP BY wallet_address,token_address)
    SELECT p.*,$4::bigint::text AS approved_block,$5::timestamptz AS approved_at,h.payload,h.history_revision,
      ${financialEvidenceSql} AS financial_revision,(canonical.block_hash IS NOT NULL) canonical,
      b.checkpoint_timestamp baseline_at,b.ledger baseline_ledger,b.checkpoint_block::text baseline_block,b.checkpoint_hash baseline_hash,b.balance::text baseline_balance,
      b.history_fingerprint baseline_fingerprint,EXISTS(SELECT 1 FROM node_evidence_blocks proof WHERE proof.block_number=b.checkpoint_block
        AND proof.block_hash=b.checkpoint_hash AND proof.timestamp=b.checkpoint_timestamp) baseline_canonical,
      (import_job.history_complete AND import_job.cursor IS NULL AND import_job.head_fingerprint IS NOT NULL) baseline_history_complete,
      m.generation::text,m.registered_at,
      m.collected_through_block::text collected,m.decoded_through_block::text decoded,m.repair_from_block::text repair,
      EXISTS(SELECT 1 FROM node_executions unknown JOIN node_execution_flows f ON f.execution_id=unknown.id
        WHERE unknown.wallet_address=p.wallet_address AND f.token_address=p.token_address AND unknown.status='unsupported'
          AND unknown.timestamp BETWEEN $2::timestamptz AND $3::timestamptz) unresolved
    FROM pairs p LEFT JOIN node_accounting_history h ON h.scope_key='public' AND h.wallet_address=p.wallet_address
      AND h.token_address=p.token_address AND h.invalidated_at IS NULL AND h.schema_version=2
    LEFT JOIN node_evidence_blocks canonical ON canonical.block_number=h.to_block AND canonical.block_hash=h.to_hash
      AND h.payload->>'throughBlock'=h.to_block::text AND h.payload->'proof'->>'blockNumber'=h.to_block::text
      AND h.payload->'proof'->>'blockHash'=h.to_hash
    LEFT JOIN node_accounting_baselines b ON b.wallet_address=p.wallet_address AND b.token_address=p.token_address AND b.invalidated_at IS NULL AND b.schema_version=2
    LEFT JOIN node_import_jobs import_job ON import_job.wallet_address=b.wallet_address AND import_job.token_address=b.token_address
    LEFT JOIN node_monitored_wallets m ON m.wallet_address=p.wallet_address AND m.active
    ORDER BY p.wallet_address,p.token_address LIMIT 10001`,[wallets,windowStart,windowEnd,checkpoint?.block_number??null,checkpoint?.timestamp??null])).rows as Pair[];
  if(rows.length>10000)throw Error('leaderboard_work_limit');
  const captured=rows.filter(pair=>pair.payload&&pair.history_revision&&pair.canonical).map(pair=>({wallet:pair.wallet_address,
    token:pair.token_address,revision:pair.history_revision,financial:pair.financial_revision,balance:pair.payload!.proof?.balance,
    quantities:pair.payload!.coverage.quantitiesComplete===true}));
  if(captured.length)request.beforePublish?.(async publication=>{
    // Reorgs are fenced separately. A same-chain trace or valuation correction
    // can invalidate a history too; do not publish it after that correction.
    // SHARE locks last only for publication, never for calculation or RPC.
    const current=await publication.query(`SELECT h.wallet_address,h.token_address FROM node_accounting_history h
      JOIN jsonb_to_recordset($1::jsonb) wanted(wallet text,token text,revision text,financial text,balance text,quantities boolean)
        ON h.scope_key='public' AND h.wallet_address=wanted.wallet AND h.token_address=wanted.token
      WHERE h.invalidated_at IS NULL AND h.schema_version=2 AND h.history_revision=wanted.revision AND ${financialEvidenceSql}=wanted.financial
        AND h.payload->'proof'->>'balance'=wanted.balance
        AND COALESCE((h.payload->'coverage'->>'quantitiesComplete')::boolean,false)=wanted.quantities FOR SHARE OF h`,[JSON.stringify(captured)]);
    if(current.rows.length!==captured.length)throw Error('node_leaderboard_accounting_evidence_changed');
  });
  const pending=rows.filter(pair=>{const value=publicLeaderboardPeriodInput(pair,windowStart,windowEnd);return!value.complete;});
  if(pending.length)await db.query(`INSERT INTO node_accounting_jobs(scope_key,wallet_address,token_address,scope,priority)
    SELECT 'public',j.wallet,j.token,'{"kind":"public"}'::jsonb,0 FROM jsonb_to_recordset($1::jsonb)j(wallet text,token text)
    JOIN published_kols k ON k.address=j.wallet AND k.is_tracked ON CONFLICT(scope_key,wallet_address,token_address) DO NOTHING`,
  [JSON.stringify(pending.map(pair=>({wallet:pair.wallet_address,token:pair.token_address})))]);
  // Most collection ranges share the same wallet/generation map. Merge their
  // exact intervals once per map fingerprint before testing individual wallets.
  // A later registration without verified discovery cannot cover the period;
  // rescanning its post-registration ranges cannot repair that missing history.
  monitoring=(await db.query(`WITH boundary AS(SELECT block_number FROM node_evidence_blocks
      WHERE timestamp<$2::timestamptz ORDER BY block_number DESC LIMIT 1), monitored AS MATERIALIZED(
      SELECT m.*,EXISTS(SELECT 1 FROM node_import_wallet_jobs j WHERE j.wallet_address=m.wallet_address AND j.stage='done'
        AND j.head_verified_fingerprint IS NOT NULL AND j.head_verified_at>=j.requested_at AND j.requested_at>=m.registered_at) AS discovery_complete
      FROM node_monitored_wallets m JOIN published_kols k ON k.address=m.wallet_address AND k.is_tracked
      WHERE m.active AND m.wallet_address=ANY($1::text[])), lower_bound AS(
      SELECT min(CASE WHEN registered_at<=$2::timestamptz AND (SELECT block_number FROM boundary) IS NOT NULL
        THEN (SELECT block_number FROM boundary) WHEN discovery_complete THEN registration_block+1 END) AS block_number FROM monitored
    ), cohort_ranges AS MATERIALIZED(
      SELECT any_value(r.wallets) AS wallets,range_agg(int8range(r.from_block,r.to_block+1,'[)')) AS coverage
      FROM node_evidence_ranges r WHERE (SELECT block_number FROM lower_bound) IS NOT NULL AND $3::bigint IS NOT NULL
        AND r.decoded_at IS NOT NULL AND r.to_block>=(SELECT block_number FROM lower_bound) AND r.from_block<=$3::bigint
      GROUP BY sha256(convert_to(r.wallets::text,'UTF8'))
    ), wallet_ranges AS(
      SELECT m.wallet_address,range_agg(c.coverage) AS coverage FROM monitored m JOIN cohort_ranges c
        ON c.wallets->>m.wallet_address=m.generation::text GROUP BY m.wallet_address
    ) SELECT m.wallet_address,m.generation::text,m.registration_block::text,m.registered_at::text AS registered_at,
    m.collected_through_block::text,m.decoded_through_block::text,m.repair_from_block::text,
    CASE WHEN m.registered_at<=$2::timestamptz AND (SELECT block_number FROM boundary) IS NOT NULL AND $3::bigint>=(SELECT block_number FROM boundary)
      THEN COALESCE(covered.coverage @>int8range((SELECT block_number FROM boundary),$3::bigint+1,'[)'),false) ELSE false END AS period_covered,
    CASE WHEN $3::bigint>=m.registration_block
      THEN COALESCE(covered.coverage @>int8range(m.registration_block+1,$3::bigint+1,'[)'),false) ELSE false END AS registration_covered,
    m.discovery_complete
    FROM monitored m LEFT JOIN wallet_ranges covered ON covered.wallet_address=m.wallet_address`,[wallets,windowStart,checkpoint?.block_number??null])).rows;
  // Fees without token movements (failed transactions and operations) cannot be
  // hidden by the position list. Authenticated payer fees are retained once.
  const feeRows=(await db.query(`SELECT e.id,e.wallet_address,e.tx_hash,e.operation_hash,e.timestamp,e.fee_native_wei::text,e.fee_complete,
      e.kind,e.status,e.block_hash,EXISTS(SELECT 1 FROM node_execution_flows f WHERE f.execution_id=e.id) AS has_flows,
      price.price_usd::text FROM node_executions e JOIN published_kols k ON k.address=e.wallet_address AND k.is_tracked
      LEFT JOIN LATERAL(SELECT q.price_usd FROM node_market_feed_evidence q WHERE q.quote_address='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'
        AND q.block_number=e.block_number AND q.block_hash=e.block_hash AND q.feed_address=$5 AND q.feed_description=$6
        AND q.updated_at<=e.timestamp AND q.updated_at>=e.timestamp-$7*interval '1 second'
        AND q.answer_raw>0 AND q.answered_in_round>=q.round_id AND q.feed_decimals BETWEEN 0 AND 36 LIMIT 1) price ON true
      WHERE e.wallet_address=ANY($1::text[]) AND e.timestamp BETWEEN $2::timestamptz AND $3::timestamptz
        AND e.block_number<=COALESCE($4::bigint,-1) AND e.kind IN('transaction','user_operation')
        AND (e.status='failed' OR NOT EXISTS(SELECT 1 FROM node_execution_flows f WHERE f.execution_id=e.id))`,
  [wallets,windowStart,windowEnd,checkpoint?.block_number??null,
    TRUSTED_QUOTE_FEEDS['0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'].feed,
    TRUSTED_QUOTE_FEEDS['0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'].description,
    TRUSTED_QUOTE_FEEDS['0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'].maxAgeSeconds])).rows;
  if(feeRows.length)request.beforePublish?.(async publication=>{
    const current=await publication.query(`SELECT e.id FROM node_executions e
      JOIN jsonb_to_recordset($1::jsonb) wanted(id text,wallet_address text,tx_hash text,operation_hash text,fee_native_wei text,fee_complete boolean,
        kind text,status text,block_hash text,has_flows boolean)
        ON e.id=wanted.id AND e.wallet_address=wanted.wallet_address AND e.tx_hash=wanted.tx_hash
      WHERE e.operation_hash IS NOT DISTINCT FROM wanted.operation_hash AND e.fee_complete=wanted.fee_complete
        AND e.fee_native_wei::text IS NOT DISTINCT FROM wanted.fee_native_wei AND e.kind=wanted.kind AND e.status=wanted.status
        AND e.block_hash=wanted.block_hash AND EXISTS(SELECT 1 FROM node_execution_flows f WHERE f.execution_id=e.id)=wanted.has_flows
      FOR SHARE OF e`,[JSON.stringify(feeRows)]);
    if(current.rows.length!==feeRows.length)throw Error('node_leaderboard_fee_evidence_changed');
  });
  return wallets.map(wallet=>{
    const selected=rows.filter(pair=>pair.wallet_address===wallet),reasons=new Set<string>();
    const input=selected.map(pair=>({pair,value:publicLeaderboardPeriodInput(pair,windowStart,windowEnd)}));
    const monitor=monitoring.find(row=>row.wallet_address===wallet);
    if(feeRows.some(row=>row.wallet_address===wallet&&row.status==='unsupported'))reasons.add('unsupported_execution_decoder');
    if(!checkpoint||!monitor||monitor.repair_from_block!=null
      ||!monitor.period_covered&&!(monitor.registration_covered&&monitor.discovery_complete))reasons.add('period_collection_incomplete');
    if(checkpoint&&monitor&&(BigInt(monitor.collected_through_block??'0')<BigInt(checkpoint.block_number)
      ||BigInt(monitor.decoded_through_block??'0')<BigInt(checkpoint.block_number)))reasons.add('indexing_lag');
    if(!checkpoint||Date.parse(windowEnd)-Date.parse(asIso(checkpoint.timestamp))>180_000)reasons.add('indexing_lag');
    const periodFees:JournalLedgerPeriodFeeEvent[]=feeRows.filter(row=>row.wallet_address===wallet).map(row=>({id:row.id,walletAddress:wallet,
      txHash:row.tx_hash,feeId:row.operation_hash??row.id,transactionScoped:row.kind==='transaction',timestamp:asIso(row.timestamp),
      feeUsd:row.fee_complete&&row.fee_native_wei!=null&&row.price_usd!=null?journalDecimalMultiply(row.price_usd,
        journalDecimalMultiply(row.fee_native_wei,'0.000000000000000001')!):row.fee_complete&&row.fee_native_wei==='0'?'0':null}));
    const calculated=calculateJournalLedgerPeriod({wallets:[wallet],events:input.flatMap(row=>row.value.events),
      baselines:input.flatMap(row=>row.value.baselines),openingBalances:input.flatMap(row=>row.value.openingBalances),
      periodClosedBaselines:input.flatMap(row=>row.value.periodClosedBaselines),
      valuations:input.flatMap(row=>row.value.valuation?[row.value.valuation]:[]),
      coverage:input.map(row=>({walletAddress:wallet,tokenAddress:row.pair.token_address,complete:row.value.complete,reason:row.value.reasons[0]})),
      periodFeeEvents:periodFees,period:{from:windowStart,to:windowEnd},asOf:windowEnd});
    input.forEach(row=>row.value.reasons.forEach(reason=>reasons.add(reason)));calculated.reasons.forEach(reason=>reasons.add(reason));
    const complete=reasons.size===0&&calculated.complete,sourceSet=new Set(selected.map(pair=>pair.payload?.source??'node'));
    const source=sourceSet.has('mixed')||sourceSet.size>1?'mixed':sourceSet.has('imported')?'imported':'node';
    const asOf=checkpoint?asIso(checkpoint.timestamp):windowEnd;
    const value:Omit<NodeLeaderboardSnapshot,'snapshotId'>={version:1,policy:'kollens_fifo_v1',walletAddress:wallet,windowStart,windowEnd,asOf,source,
      coveredThroughBlock:checkpoint?.block_number??null,coveredThroughHash:checkpoint?.block_hash??null,complete,reasons:[...reasons].sort(),
      realizedProfitUsd:complete?calculated.totals.realizedProfitUsd:null,knownRealizedProfitUsd:calculated.totals.knownRealizedProfitUsd,
      valuedSellCount:calculated.totals.valuedSellCount,excludedSellCount:calculated.totals.excludedSellCount,
      valuedTransferOutCount:calculated.totals.valuedTransferOutCount,excludedTransferOutCount:calculated.totals.excludedTransferOutCount,
      feeOnlyFeesUsd:calculated.totals.feeOnlyFeesUsd,valuedFeeCount:calculated.totals.valuedFeeCount,excludedFeeCount:calculated.totals.excludedFeeCount};
    return{...value,snapshotId:digest([value,input.map(row=>row.pair.history_revision)])};
  });
}
