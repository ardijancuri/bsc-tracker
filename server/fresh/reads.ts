import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { KolTokenActivity, KolTokenTrade,KolTokenProfitPosition } from '../../shared/kolTokenTrades.js';
import type { NodeAccountingSummary } from '../../shared/nodeAccounting.js';
import { applyFreshEvent, freshDecimal, freshQuantity, freshEventFromRow, freshLotFromRow, freshPositionFromRow, FreshRational, freshUtcDay, summarizeFreshPosition,freshFeeExclusions,hydrateFreshScopeTokenHistory } from './accounting.js';
import type { FreshFinancialEvent, FreshLot, FreshScope } from '../../shared/freshAccounting.js';
import { freshPositionReceiptRelevantSql,freshPendingTradeScopeSql,freshPendingTradeInScopeSql } from './positionDependencies.js';
import { freshPositionWalletGapSql } from './balanceScheduling.js';
import { freshStoredKolRollingMetrics, rankFreshStoredLeaderboard, freshRankedLeaderboardValue, freshRollingLeaderboardPendingSql, freshPublicTokenDiscoveryPendingSql } from './leaderboard.js';
import {freshTradeBnbEquivalent} from './tradeBnbDisplay.js';
import {freshTrackedTokenSql,freshTrackedEventSql,freshScopeEventSql,freshScopeTokenBoundarySql,GANG_TOKEN_ADDRESS} from './tracking.js';
import {freshPublicTokenSql,freshPublicTradeScopeSql} from './publicTokens.js';
import{freshScopeTokenCaptureSql}from'./gangTokenCoverage.js';
import{FRESH_REALIZED_POLICY,freshRealizedPolicyReadySql}from'./realizedPolicy.js';
import{freshRealizedGapIrrelevantSql}from'./realizedGapCoverage.js';
import{freshRealizedEstimateReadySql,FRESH_REALIZED_ESTIMATE_POLICY}from'./estimatedProjectionPolicy.js';
import{readFreshPositionEstimates,freshPositionEstimateValues}from'./positionEstimate.js';
import type{NodeCostEstimate}from'../../shared/nodeCostEstimate.js';
import type{Rpc}from'../rpc.js';
import{verifyFreshEstimatedMovement}from'./estimatedMovement.js';

const iso = (v: unknown) => v == null ? null : new Date(v as string).toISOString();
const fingerprint = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const q = FreshRational.parse;
const typedScope=(scope:any):FreshScope=>({id:scope.id,kind:scope.kind,walletAddresses:scope.wallet_addresses,accountId:scope.account_id??null,startsAt:iso(scope.starts_at)!,startsBlock:String(scope.starts_block),revision:String(scope.revision)});
const tokenHistory=(scope:any,token:string)=>scope.tokenHistoryStarts?.[token] as NonNullable<FreshScope['tokenHistoryStarts']>[string]|undefined;
const tokenFrom=(scope:any,token:string)=>tokenHistory(scope,token)?.startsBlock??String(scope.starts_block);
const tokenFromTime=(scope:any,token:string)=>tokenHistory(scope,token)?.startsAt??iso(scope.starts_at);
const preparationPending=(reasons:string[])=>reasons.length>0&&reasons.every(reason=>['accounting_policy_pending','balance_pending','decoding_pending','registration_pending','quote_unavailable'].includes(reason));
export const publicScope = (wallet: string) => `kol:${wallet}`;
export const tokenIdentity = (r: Record<string, any>) => {
  const day=r.utc_date??(r.today_utc instanceof Date?r.today_utc.toISOString().slice(0,10):String(r.today_utc??'').slice(0,10)),today=day===freshUtcDay();
  return { address: r.address, symbol: r.symbol, name: r.name,
  logoUrl: r.logo_data ? `/api/token-image/${r.address}` : r.logo_url ?? null, priceUsd: r.valuation_status==='no_liquidity'?null:r.price_usd ?? null,
  marketCapUsd: r.valuation_status==='no_liquidity'?null:r.market_cap_usd ?? null, valuationStatus:r.valuation_status, change24h: null, kolCount24h: today?r.today_kol_count??0:0,
  buys24h: today?r.today_buy_count??0:0, sells24h: today?r.today_sell_count??0:0, volume24hUsd: today?freshDecimal(r.today_volume_q??'0'):'0',
  lastTradeAt: iso(r.last_trade_at), trackingBoundary: r.trackingBoundary, utcDay: freshUtcDay(),
  observedAt: iso(r.observed_at), accountingStatus: r.valuation_status };
};
export const kolIdentity = (r: Record<string, any>) => ({ address: r.address ?? r.wallet_address,name: r.display_name,
  avatarUrl: r.avatar_url,twitter: r.twitter,source: r.source,lastSeenAt: iso(r.last_trade_at ?? r.last_seen_at),
  creator: { claimed: !!r.creator_claimed,walletControlVerified: !!r.creator_claimed,bio: r.creator_bio ?? null,
    websiteUrl: r.creator_website_url ?? null,xUrl: r.creator_x_url ?? null,telegramUrl: r.creator_telegram_url ?? null,updatedAt: iso(r.creator_updated_at) } });
export function tradeIdentity(r: Record<string, any>): KolTokenTrade {
  const status=r.accounting_status??(r.amount_usd==null?'pending_settlement':'ready');
  const amount = freshDecimal(r.amount_usd), quantity = status==='pending_precision'?null:freshQuantity(r.quantity ?? r.token_amount);
  const bnbEquivalent=freshTradeBnbEquivalent(r);
  return { id:r.id,txHash:r.transaction_hash ?? r.tx_hash,walletAddress:r.wallet_address,tokenAddress:r.token_address,
    kolName:r.display_name ?? null,kolAvatarUrl:r.avatar_url ?? null,kolTwitter:r.twitter ?? null,
    tokenSymbol:r.symbol ?? null,tokenName:r.name ?? null,tokenLogoUrl:r.logo_data ? `/api/token-image/${r.token_address}` : r.logo_url ?? null,
    side:r.kind ?? r.side,tokenAmount:quantity,quoteSymbol:r.quote_symbol ?? null,quoteTokenAddress:r.quote_address??null,quoteAmount:freshQuantity(r.quote_amount ?? null),
    ...(bnbEquivalent!==null?{bnbEquivalentAmount:bnbEquivalent}:{}),
    ...(r.acquisition_cost?.policy==='actual_quote_acquisition_cost_v1'?{acquisitionCost:r.acquisition_cost}:{}),
    amountUsd:amount,priceUsd:r.price_usd ?? (amount && quantity && q(quantity).n !== 0n ? q(amount).div(q(quantity)).decimal() : null),
    marketCapUsd:r.market_cap_usd??null,timestamp:iso(r.occurred_at ?? r.timestamp)!,source:r.provenance?'mixed':'node',blockNumber:String(r.block_number),transactionIndex:r.transaction_index,
    valuationStatus:amount === null ? 'unpriced' : 'valued',accountingStatus:status,...(r.accounting_reason?{accountingReason:r.accounting_reason}:{}),
    realizedProfitUsd:status==='ready'&&r.accounting_policy_ready!==false?freshDecimal(r.event_realized_q ?? null):null,cumulativeRealizedProfitUsd:status==='ready'&&r.accounting_policy_ready!==false?freshDecimal(r.cumulative_realized_q??null):null };
}

/** Read paths touch current rows and bounded pages. Financial history is replayed only for an explicitly requested export. */
export function createFreshReads(db: Pool, now = Date.now, transactional=false,options:{estimateRpc?:Rpc}={}) {
  async function hydrateReadScope(scope:any){const typed=await hydrateFreshScopeTokenHistory(db,typedScope(scope));return{...scope,tokenHistoryStarts:typed.tokenHistoryStarts};}
  async function boundary() { return (await db.query(`SELECT block_number::text,block_hash,value FROM fresh.checkpoints WHERE key='start'`)).rows[0] ?? null; }
  async function state() { const rows = (await db.query(`SELECT key,block_number::text,block_hash,updated_at,value FROM fresh.checkpoints WHERE key IN('start','capture','decode','quote','utc_day','health:token_discovery')`)).rows;
    return Object.fromEntries(rows.map(row=>[row.key,row])); }
  async function leaderboard() {
    const at=now(),states=await state(),day=freshUtcDay(at),windowStart=new Date(at-86_400_000).toISOString(),windowEnd=new Date(at).toISOString();
    const result=await db.query(`SELECT k.*,${freshRealizedPolicyReadySql()} AS accounting_policy_ready,${freshRealizedEstimateReadySql()} AS realized_estimate_policy_ready,
      EXISTS(SELECT 1 FROM fresh.checkpoints estimate_capture JOIN fresh.recent_blocks estimate_header
        ON estimate_header.block_number=estimate_capture.block_number AND estimate_header.block_hash=estimate_capture.block_hash WHERE estimate_capture.key='capture') AS estimate_capture_canonical,
      k.today_utc::text AS utc_date,p.address,p.display_name,p.avatar_url,p.twitter,p.creator_claimed,p.creator_bio,
      w.decode_gap_from_block,w.decode_gap_reason,
      (w.decode_gap_from_block IS NOT NULL AND NOT EXISTS(SELECT 1 FROM fresh.accounting_scopes gap_scope
        WHERE gap_scope.id='kol:'||w.address AND ${freshRealizedGapIrrelevantSql('gap_scope','w')})) AS rolling_decode_gap_pending,
      EXISTS(SELECT 1 FROM fresh.financial_events imported JOIN fresh.accounting_scopes imported_scope ON imported_scope.id='kol:'||k.wallet_address AND imported_scope.active
        WHERE imported.wallet_address=k.wallet_address AND imported.canonical AND imported.provenance IS NOT NULL
        AND ${freshScopeEventSql('imported','imported_scope')}) AS imported_provenance,
      ${freshRollingLeaderboardPendingSql()} AS decoding_pending,
      ${freshPublicTokenDiscoveryPendingSql()} AS token_discovery_pending,
      p.creator_website_url,p.creator_x_url,p.creator_telegram_url,p.creator_updated_at
      FROM fresh.kols k JOIN fresh.wallets w ON w.address=k.wallet_address JOIN published_kols p ON p.address=k.wallet_address WHERE k.is_tracked`,[windowStart,windowEnd]);
    const items=result.rows.map(r=>{
      const stored=freshStoredKolRollingMetrics(r,at),{current,realizedProfitUsd:realized,knownRealizedProfitUsd:known}=stored;
      const valuedSell=stored.valuedSellCount,excludedSell=stored.excludedSellCount,
        valuedTransfer=stored.valuedTransferCount,excludedTransfer=stored.excludedTransferCount,
        valuedFee=stored.valuedFeeCount,excludedFee=stored.excludedFeeCount;
      const asOf=stored.updatedAt ?? iso(states.decode?.updated_at ?? states.start?.updated_at) ?? `${day}T00:00:00.000Z`;
      const estimated=stored.estimatedRealizedProfitUsd,estimate=estimated===null?null:{version:1 as const,policy:FRESH_REALIZED_ESTIMATE_POLICY,basis:'recorded_facts' as const,
        asOf,windowStart,windowEnd,reasons:[...stored.reasons,Number(r.rolling_unknown_count)>0?'unknown_inputs_omitted':'recorded_activity_incomplete'],affectedSellCount:excludedSell,
        missingCostCount:null,missingProceedsCount:null,missingFeeCount:null,unvaluedFeeOnlyCount:excludedFee};
      const item={ ...kolIdentity(r),realizedProfitUsd:realized,estimatedRealizedProfitUsd:estimated,
        pnlQuality:stored.complete?'exact' as const:estimated!==null?'estimated' as const:'unavailable' as const,
        knownRealizedProfitUsd:known,unrealizedProfitUsd:null,updatedAt:stored.updatedAt,
        tradeCount24h:stored.tradeCount,buyCount24h:current?r.rolling_buy_count:0,sellCount24h:current?r.rolling_sell_count:0,
        unpricedSellCount24h:excludedSell,valuedSellCount:valuedSell,excludedSellCount:excludedSell,
        accounting:{version:1 as const,policy:'kollens_fifo_v1' as const,realizedPolicy:FRESH_REALIZED_POLICY,period:'24h' as const,walletAddress:r.wallet_address,windowStart,windowEnd,
          snapshotId:fingerprint([r.wallet_address,'24h',r.revision,Boolean(r.imported_provenance),'estimated_realized_v1',r.realized_estimate_policy_ready,estimated,stored.complete?'exact':estimated!==null?'estimated':'unavailable']),asOf,source:r.imported_provenance?'mixed' as const:'node' as const,coveredThroughBlock:states.decode?.block_number ?? null,
          coveredThroughHash:states.decode?.block_hash ?? null,complete:stored.complete,reasons:stored.reasons,
          ...(r.decode_gap_from_block!=null?{historicalGap:{fromBlock:String(r.decode_gap_from_block),status:'unresolved' as const,currentPeriodIsolated:r.rolling_decode_gap_pending===false}}:{}),
          realizedProfitUsd:realized,estimatedRealizedProfitUsd:estimated,estimate,knownRealizedProfitUsd:known,valuedSellCount:valuedSell,
          excludedSellCount:excludedSell,valuedTransferOutCount:valuedTransfer,excludedTransferOutCount:excludedTransfer,
          valuedFeeCount:valuedFee,excludedFeeCount:excludedFee,feeOnlyFeesUsd:current?freshDecimal(r.rolling_fee_only_q):'0',exclusions:{feeOnly:freshFeeExclusions(current?{
            unallocated_fee_count:r.rolling_unallocated_fee_count,unallocated_fee_q:r.rolling_unallocated_fee_q,
            unallocated_fee_unknown_count:r.rolling_unallocated_fee_unknown_count,unattributed_fee_count:r.rolling_unattributed_fee_count}:undefined)}},
        period:'24h' as const,windowStart,windowEnd,utcDay:day,trackingBoundary:states.start?.block_number ?? null,accountingStatus:stored.complete?'ready':estimated!==null?'estimated':r.decoding_pending?'refreshing':'pending',
        ...(r.decoding_pending?{refreshStatus:'pending' as const}:{}), };
      return{...item,rankingProfitUsd:freshRankedLeaderboardValue(item)};
    });
    return {items:rankFreshStoredLeaderboard(items),windowStart,windowEnd,period:'24h' as const,utcDay:day,trackingBoundary:states.start?.block_number ?? null,accountingPolicy:'kollens_fifo_v1',realizedPolicy:FRESH_REALIZED_POLICY};
  }
  async function positionRows(scopeId:string,tokens?:string[]) {
    const rows=await db.query(`SELECT p.*,t.*,${freshRealizedPolicyReadySql()} AS accounting_policy_ready,${freshRealizedEstimateReadySql()} AS estimate_policy_ready,p.token_address AS address,p.revision AS position_revision,last.block_number AS last_event_block,${freshScopeTokenCaptureSql('s','p.token_address')} AS effective_capture_block,
        EXISTS(SELECT 1 FROM fresh.financial_events imported WHERE imported.token_address=p.token_address AND imported.wallet_address=ANY(s.wallet_addresses)
          AND imported.canonical AND imported.provenance IS NOT NULL AND ${freshScopeEventSql('imported','s')}) AS imported_provenance,
        ${freshPositionWalletGapSql("(SELECT block_number FROM fresh.checkpoints WHERE key='capture')")} AS wallet_gap,
        EXISTS(SELECT 1 FROM fresh.jobs j WHERE j.kind='registration_capture' AND j.reference=ANY(s.wallet_addresses) AND j.state NOT IN('done','cancelled')) AS registration_pending,
        EXISTS(SELECT 1 FROM fresh.pending_trades precision WHERE precision.token_address=p.token_address
          AND ${freshPendingTradeInScopeSql('precision','s')}) AS pending_precision,
        (EXISTS(SELECT 1 FROM fresh.recent_evidence e LEFT JOIN fresh.recent_blocks h ON h.block_number=e.block_number AND h.block_hash=e.block_hash WHERE e.wallet_addresses&&s.wallet_addresses AND ${freshScopeTokenBoundarySql('s','p.token_address','e.block_number','h.occurred_at',{allowMissingTime:true})} AND e.decoder_status<>'done'
          AND ${freshPositionReceiptRelevantSql('e','p.token_address','s')}) OR ${freshPendingTradeScopeSql()}) AS decoding_pending
        FROM fresh.positions p JOIN fresh.tokens t ON t.address=p.token_address JOIN fresh.accounting_scopes s ON s.id=p.scope_id
        LEFT JOIN fresh.financial_events last ON last.id=p.last_event_id WHERE p.scope_id=$1 AND ${freshTrackedTokenSql('t')}
        AND (t.launch_status<>'preexisting' OR s.kind<>'kol' OR (${freshPublicTokenSql('t')})) ${tokens?'AND p.token_address=ANY($2::text[])':''}`,tokens?[scopeId,tokens]:[scopeId]);
    const lots=await db.query(`SELECT * FROM fresh.open_lots WHERE scope_id=$1 ${tokens?'AND token_address=ANY($2::text[])':''}`,tokens?[scopeId,tokens]:[scopeId]);
    const scopes=await db.query(`SELECT * FROM fresh.accounting_scopes WHERE id=$1 AND active`,[scopeId]),states=await state();
    let scope=scopes.rows[0]; if(!scope)return [];if(rows.rows.some(row=>row.token_address===GANG_TOKEN_ADDRESS))scope=await hydrateReadScope(scope);
    const estimateTokens=rows.rows.filter(r=>r.estimate_policy_ready&&(r.unknown_cost||r.unknown_fee||r.realized_q===null||r.decoding_pending||r.wallet_gap||r.balance_status!=='matched')).map(r=>r.token_address);
    const estimates=scope.kind==='kol'&&estimateTokens.length?await readFreshPositionEstimates(db,scopeId,estimateTokens,lots.rows.filter(l=>estimateTokens.includes(l.token_address)).map(freshLotFromRow)):new Map();
    const lotsByToken=new Map<string,FreshLot[]>();for(const row of lots.rows){const list=lotsByToken.get(row.token_address)??[];list.push(freshLotFromRow(row));lotsByToken.set(row.token_address,list);}
    return rows.rows.map(r=>{
      const owned=lotsByToken.get(r.token_address)??[];
      const position=freshPositionFromRow({...r,revision:r.position_revision});
      const priced=iso(r.observed_at),fresh=r.valuation_status==='ready'&&priced!==null&&now()-Date.parse(priced)<=120_000&&now()>=Date.parse(priced)
        &&r.last_event_block!=null&&r.observed_block!=null&&BigInt(r.observed_block)>=BigInt(r.last_event_block);
      const summary=summarizeFreshPosition(position,owned,fresh?r.price_usd:null);
      const balanceReady=r.balance_status==='matched'&&r.balance_quantity!=null&&q(r.balance_quantity).compare(q(position.quantityQ))===0&&r.balance_block!=null&&/^0x[\da-f]{64}$/.test(r.balance_hash??'')&&r.last_event_block!=null
        &&BigInt(r.balance_block)>=BigInt(r.last_event_block)&&states.capture?.block_number!=null&&BigInt(r.balance_block)<=BigInt(r.effective_capture_block??states.capture.block_number)
        &&Date.parse(r.balance_checked_at)>=Date.parse(r.last_event_at??0)&&!r.wallet_gap&&!r.decoding_pending&&!r.registration_pending;
      // Unsold lots can have unknown basis without changing already verified
      // sale results. Export still needs the remaining inventory's actual cost.
      const realizedComplete=r.accounting_policy_ready!==false&&balanceReady&&!position.unknownFee&&position.realizedQ!==null;
      const financialReasons=[...(r.accounting_policy_ready===false?['accounting_policy_pending']:[]),...(r.pending_precision?['historical_precision_unavailable']:[]),...(position.realizedQ===null&&!position.unknownFee?['unknown_costs']:[]),...(position.unknownFee?['unknown_fees']:[]),...(balanceReady?[]:[r.wallet_gap?'wallet_decode_gap':r.registration_pending?'registration_pending':r.decoding_pending?'decoding_pending':r.balance_status==='mismatch'?'balance_mismatch':'balance_pending'])];
      const endingReady=realizedComplete&&summary.status==='complete',endingReasons=[...financialReasons,...(summary.status==='unknown_costs'&&!financialReasons.includes('unknown_costs')?['unknown_costs']:[]),...(summary.status==='quote_unavailable'?['quote_unavailable']:[])];
      const history=tokenHistory(scope,r.token_address),snapshotId=fingerprint([scopeId,r.token_address,r.position_revision,r.observed_hash,r.observed_at,scope.correction_epoch,scope.revision,r.balance_block,r.balance_hash,r.balance_quantity,r.balance_status,r.wallet_gap,r.decoding_pending,r.registration_pending,Boolean(r.imported_provenance),history?.permissionDigest]);
      const snapshot:{estimate?:NodeCostEstimate}&{version:2;snapshotId:string;source:'mixed'|'node';scope:'public'|'portfolio';asOf:string;historyFingerprint:string;historyFrom:string|null;coveredThroughBlock:string|null;valuationBlock:string|null;valuationHash:string|null;complete:boolean;reasons:string[];historyBoundary:any;refreshStatus?:'pending';refreshReason?:string}={version:2 as const,snapshotId:fingerprint([snapshotId,'token_cost_estimate_v1',estimates.get(r.token_address)??null]),source:(r.imported_provenance?'mixed':'node')as'mixed'|'node',scope:(scope.kind==='kol'?'public':'portfolio') as 'public'|'portfolio',
        asOf:iso(r.balance_checked_at)??iso(states.decode?.updated_at)??new Date(now()).toISOString(),historyFingerprint:fingerprint([scopeId,r.token_address,scope.correction_epoch,r.position_revision,Boolean(r.imported_provenance),history?.permissionDigest]),
        historyFrom:tokenFromTime(scope,r.token_address),coveredThroughBlock:balanceReady?String(r.balance_block):states.decode?.block_number??null,valuationBlock:r.observed_block==null?null:String(r.observed_block),
        valuationHash:r.observed_hash??null,complete:realizedComplete,reasons:financialReasons,historyBoundary:scope.kind==='kol'?(history?'token_creation' as const:r.launch_status==='preexisting'?'wallet_discovery' as const:'token_creation' as const):'membership_added' as const,
        ...(realizedComplete&&!endingReady?{refreshStatus:'pending' as const,refreshReason:endingReasons[0]??'quote_unavailable'}:{})};
      const storedEstimate=estimates.get(r.token_address);
      if(!endingReady&&storedEstimate&&r.accounting_policy_ready&&r.estimate_policy_ready&&!r.pending_precision){snapshot.estimate={version:1,policy:'omit_unknown_costs_v1',basis:'recorded_facts',snapshotId:snapshot.snapshotId,historyFingerprint:snapshot.historyFingerprint,asOf:snapshot.asOf,reasons:endingReasons.length?endingReasons:['unknown_costs'],...freshPositionEstimateValues(position,storedEstimate,summary.valueUsd),missingCostCount:null,missingFeeCount:null,missingProceedsCount:null};}
      return {r,position,lots:owned,summary,snapshot,scope,balanceReady,realizedComplete,endingReady,endingReasons};
    });
  }
  async function pendingPositionRows(scopeId:string,tokens:string[]){
    if(!tokens.length)return[];
    const rows=(await db.query(`SELECT t.*,to_jsonb(s)||jsonb_build_object('starts_block',s.starts_block::text,'revision',s.revision::text,'correction_epoch',s.correction_epoch::text) AS pending_scope,
      CASE WHEN EXISTS(SELECT 1 FROM fresh.pending_trades precision WHERE precision.token_address=t.address
        AND ${freshPendingTradeInScopeSql('precision','s')}) THEN 'historical_precision_unavailable' ELSE 'trade_settlement_unavailable' END AS pending_reason
      FROM fresh.tokens t JOIN fresh.accounting_scopes s ON s.id=$1 AND s.active WHERE t.address=ANY($2::text[])
      AND ${freshTrackedTokenSql('t')} AND ${freshPendingTradeScopeSql('s','t.address')}
      AND(s.kind<>'kol' OR (${freshPublicTokenSql('t')}))`,[scopeId,tokens])).rows;
    for(const row of rows)if(row.address===GANG_TOKEN_ADDRESS)row.pending_scope=await hydrateReadScope(row.pending_scope);return rows;
  }
  function pendingSnapshot(scope:any,token:string,reason:string,states:Record<string,any>){
    const historyFingerprint=fingerprint([scope.id,token,scope.revision,scope.correction_epoch,reason,states.capture?.block_number,tokenHistory(scope,token)?.permissionDigest]);
    return{version:2 as const,snapshotId:fingerprint(['pending',historyFingerprint]),source:'node' as const,scope:(scope.kind==='kol'?'public':'portfolio')as'public'|'portfolio',
      asOf:new Date(now()).toISOString(),historyFingerprint,historyFrom:tokenFromTime(scope,token),coveredThroughBlock:states.capture?.block_number??null,
      valuationBlock:null,valuationHash:null,complete:false,reasons:[reason,'unknown_costs'],historyBoundary:scope.kind==='kol'?(tokenHistory(scope,token)?'token_creation' as const:'wallet_discovery' as const):'membership_added' as const};
  }
  async function summaries(wallet:string,tokens:string[],scopeId=publicScope(wallet)):Promise<Record<string,NodeAccountingSummary>> {
    const rows=await positionRows(scopeId,tokens),result:Record<string,NodeAccountingSummary>=Object.fromEntries(rows.map(({r,summary:s,snapshot,scope,realizedComplete,endingReady,endingReasons,balanceReady})=>[r.token_address,{
      tracking:{version:1,source:'fresh',fromBlock:tokenFrom(scope,r.token_address),utcDay:freshUtcDay(now())},walletAddress:wallet,quotedAt:iso(r.observed_at),
      realizedStatus:realizedComplete?'ready':snapshot.estimate?'estimated':preparationPending(snapshot.reasons)?'pending':'unavailable',
      tokenAddress:r.token_address,snapshot,status:endingReady?'ready':preparationPending(endingReasons)?'pending':'unavailable',position:s.quantity==='0'?'closed':'open',realizedProfitUsd:realizedComplete?s.realizedProfitUsd:null,
      estimatedProfitUsd:endingReady?s.estimatedProfitUsd:null,roi:endingReady?s.roi:null,remainingTokenAmount:s.quantity,valueUsd:balanceReady?s.valueUsd:null,...(endingReady?{}:{reason:endingReasons[0]}) }]));
    const missing=tokens.filter(token=>!result[token]);if(missing.length){const pending=await pendingPositionRows(scopeId,missing);if(pending.length){const states=await state();
      for(const r of pending){const scope=r.pending_scope;if(!scope.wallet_addresses.includes(wallet))continue;
        result[r.address]={tracking:{version:1,source:'fresh',fromBlock:tokenFrom(scope,r.address),utcDay:freshUtcDay(now())},walletAddress:wallet,tokenAddress:r.address,
          quotedAt:iso(r.observed_at),snapshot:pendingSnapshot(scope,r.address,r.pending_reason,states),status:'unavailable',realizedStatus:'unavailable',position:'unknown',
          realizedProfitUsd:null,estimatedProfitUsd:null,roi:null,remainingTokenAmount:null,valueUsd:null,reason:r.pending_reason};
      }
    }}return result;
  }
  async function trades(options:{wallet?:string;token?:string;limit?:number;cursor?:string;scopeId?:string;today?:boolean;window?:'24h';windowStart?:string;windowEnd?:string}={}) {
    const values:unknown[]=[],where=[`e.canonical`,`e.kind IN('buy','sell')`,freshTrackedEventSql('e','t')];
    if(options.scopeId){values.push(options.scopeId);where.push(`s.id=$${values.length}`,'s.active','e.wallet_address=ANY(s.wallet_addresses)',freshScopeEventSql('e','s'),`e.block_number<=${freshScopeTokenCaptureSql('s','e.token_address')}`,
      `(e.raw_quantity IS NULL OR ${freshPendingTradeInScopeSql('e','s')})`,`(s.kind<>'kol' OR (${freshPublicTradeScopeSql('e')}))`);}
    else where.push(freshPublicTradeScopeSql('e'));
    for(const [name,value]of [['wallet_address',options.wallet],['token_address',options.token]])if(value){values.push(value);where.push(`e.${name}=$${values.length}`);}
    const end=options.windowEnd??new Date(now()).toISOString();
    const start=options.windowStart??(options.window==='24h'?new Date(Date.parse(end)-86_400_000).toISOString():options.today?`${freshUtcDay(now())}T00:00:00.000Z`:null);
    if(start){values.push(start);where.push(`e.occurred_at${options.window==='24h'?'>' : '>='}$${values.length}::timestamptz`);}
    if(options.window==='24h'||options.windowEnd){values.push(end);where.push(`e.occurred_at<=$${values.length}::timestamptz`);}
    if(options.cursor){try{const cursor=JSON.parse(Buffer.from(options.cursor,'base64url').toString());if(typeof cursor.ts==='string'&&Number.isFinite(Date.parse(cursor.ts))&&typeof cursor.id==='string'){values.push(cursor.ts,cursor.id);where.push(`(e.occurred_at,e.id)<($${values.length-1}::timestamptz,$${values.length})`);}}catch{}}
    values.push(Math.min(options.limit??50,100)+1);
    const rows=(await db.query(`SELECT e.*,${freshRealizedPolicyReadySql()} AS accounting_policy_ready,t.name,t.symbol,t.logo_url,t.logo_data,p.display_name,p.avatar_url,p.twitter,
      r.realized_q AS event_realized_q FROM fresh.visible_trades e JOIN fresh.tokens t ON t.address=e.token_address
      ${options.scopeId?'JOIN fresh.accounting_scopes s ON s.id=$1 LEFT JOIN fresh.scope_event_results r ON r.event_id=e.id AND r.scope_id=s.id':'LEFT JOIN fresh.scope_event_results r ON r.event_id=e.id AND r.scope_id=\'kol:\'||e.wallet_address'}
      LEFT JOIN published_kols p ON p.address=e.wallet_address WHERE ${where.join(' AND ')} ORDER BY e.occurred_at DESC,e.id DESC LIMIT $${values.length}`,values)).rows;
    const limit=Math.min(options.limit??50,100),items=rows.slice(0,limit).map(tradeIdentity),last=items.at(-1);
    return {items,nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify({ts:last.timestamp,id:last.id})).toString('base64url'):null};
  }
  async function activity(wallet:string,token:string,scopeId=publicScope(wallet),replay=false):Promise<KolTokenActivity|null> {
    const [row]=await positionRows(scopeId,[token]);if(!row){
      const[r]=await pendingPositionRows(scopeId,[token]);if(!r)return null;const scope=r.pending_scope;
      if(!scope.wallet_addresses.includes(wallet)||scope.kind==='portfolio_combined')return null;
      const identity=(await db.query('SELECT * FROM published_kols WHERE address=$1',[wallet])).rows[0];if(scope.kind==='kol'&&!identity?.is_tracked)return null;
      const page=await trades({wallet,token,scopeId,limit:100});if(!page.items.length)return null;const states=await state(),snapshot=pendingSnapshot(scope,token,r.pending_reason,states);
      const buys=page.items.filter(e=>e.side==='buy'),sells=page.items.filter(e=>e.side==='sell'),valued=(items:KolTokenTrade[])=>items.filter(e=>e.amountUsd!==null).length;
      const result:KolTokenActivity={kol:{address:wallet,name:identity?.display_name??null,avatarUrl:identity?.avatar_url??null,twitter:identity?.twitter??null,source:'node',lastSeenAt:page.items[0].timestamp},
        token:{address:token,symbol:r.symbol,name:r.name,logoUrl:r.logo_data?`/api/token-image/${token}`:r.logo_url??null,priceUsd:r.valuation_status==='ready'?r.price_usd:null,
          marketCapUsd:r.valuation_status==='ready'?r.market_cap_usd:null,marketCapSupply:r.total_supply_raw!=null&&r.decimals!=null?q(String(r.total_supply_raw)).div(new FreshRational(10n**BigInt(r.decimals))).decimal(255):null,valuationStatus:r.valuation_status},
        trades:page.items,summary:{investedUsd:null,soldUsd:null,realizedProfitUsd:null,avgBoughtPriceUsd:null,avgSoldPriceUsd:null,avgBoughtMcapUsd:null,avgSoldMcapUsd:null,
          remainingTokenAmount:null,remainingCostBasisUsd:null,buyCount:buys.length,sellCount:sells.length,valuedBuyCount:valued(buys),valuedSellCount:valued(sells),excludedSellCount:sells.length-valued(sells),
          unpricedTradeCount:page.items.filter(e=>e.tokenAmount===null||e.amountUsd===null).length,firstTradeAt:page.items.at(-1)!.timestamp,lastTradeAt:page.items[0].timestamp,status:'unknown',profitBasis:'observed_fifo'},
        accountingSnapshot:snapshot,realizedAccounting:{version:2,source:'node',policy:'kollens_fifo_v1',walletAddress:wallet,tokenAddress:token,status:'unavailable',checkedAt:snapshot.asOf,
          realizedProfitUsd:null,coverage:{transactionsComplete:false,balanceMatched:false,verification:'node_history',reason:r.pending_reason}},
        coverage:{source:'indexed',indexedTradeCount:page.items.length,returnedTradeCount:page.items.length,complete:false,historyLimit:100,costsIncluded:false},generatedAt:new Date(now()).toISOString(),
        tracking:{version:1,source:'fresh',fromBlock:tokenFrom(scope,token),utcDay:freshUtcDay(now()),realizedComplete:false}};
      Object.assign(result,{__freshRevision:{scopeId,correctionEpoch:String(scope.correction_epoch),membershipRevision:String(scope.revision),...(tokenHistory(scope,token)?{historyPermissionDigest:tokenHistory(scope,token)!.permissionDigest}:{})}});
      if(replay)result.replayAccounting={version:2,source:'node',policy:'kollens_fifo_v1',walletAddress:wallet,tokenAddress:token,status:'unavailable',checkedAt:snapshot.asOf,
        inventoryBlockNumber:null,inventoryBlockHash:null,events:[],final:null,coverage:{transactionsComplete:false,balanceMatched:false,exactFinal:false,verification:'node_history',reason:'unknown_costs'}};
      return result;
    }
    if(!row.scope.wallet_addresses.includes(wallet)||row.scope.kind==='portfolio_combined')return null;
    const identity=(await db.query(`SELECT * FROM published_kols WHERE address=$1`,[wallet])).rows[0];
    if(row.scope.kind==='kol'&&!identity?.is_tracked)return null;
    const page=await trades({wallet,token,scopeId,limit:100});const s=row.summary;
    const counts=(await db.query(`SELECT count(*) FILTER(WHERE e.kind='buy')::int AS buys,count(*) FILTER(WHERE e.kind='sell')::int AS sells,
      count(*) FILTER(WHERE e.kind='buy' AND e.amount_usd IS NOT NULL)::int AS valued_buys,count(*) FILTER(WHERE e.kind='sell' AND e.amount_usd IS NOT NULL)::int AS valued_sells,
      count(*) FILTER(WHERE e.amount_usd IS NULL OR e.quantity IS NULL)::int AS unpriced,
      min(e.occurred_at) AS first_at,max(e.occurred_at) AS last_at FROM fresh.visible_trades e JOIN fresh.tokens t ON t.address=e.token_address
      JOIN fresh.accounting_scopes s ON s.id=$1 AND s.active WHERE e.token_address=$2 AND e.wallet_address=ANY(s.wallet_addresses)
      AND ${freshScopeEventSql('e','s')} AND e.canonical AND ${freshTrackedEventSql('e','t')}
      AND(e.raw_quantity IS NULL OR ${freshPendingTradeInScopeSql('e','s')})
      AND e.block_number<=${freshScopeTokenCaptureSql('s','e.token_address')}
      AND(s.kind<>'kol' OR (${freshPublicTradeScopeSql('e')}))`,[scopeId,token])).rows[0];
    const complete=row.endingReady,reason=row.endingReasons[0]??s.status,pending=preparationPending(row.endingReasons);
    const estimate=row.snapshot.estimate;
    if(replay&&estimate&&!row.balanceReady&&options.estimateRpc&&!row.r.wallet_gap&&!row.r.registration_pending&&!row.r.pending_precision&&row.r.balance_status!=='mismatch'){
      const states=await state(),capture=states.capture;
      if(capture?.block_number&&capture.block_hash){const proof=await verifyFreshEstimatedMovement(db,options.estimateRpc,{scopeId,wallet,token,decimals:row.r.decimals,quantityQ:row.position.quantityQ,block:String(capture.block_number),hash:capture.block_hash});
        if(proof){row.balanceReady=true;Object.assign(row.r,{balance_block:proof.block,balance_hash:proof.hash,balance_quantity:proof.quantity,balance_checked_at:proof.checkedAt});row.snapshot.coveredThroughBlock=proof.block;}}
    }
    const profitPosition:KolTokenProfitPosition|undefined=s.capitalUsd===null&&!estimate?undefined:{status:s.quantity==='0'?'closed':'open',estimatedProfitUsd:complete?s.estimatedProfitUsd:estimate?.totalProfitUsd??null,estimatedRoi:complete?s.roi:null,
      unrealizedProfitUsd:complete&&s.valueUsd&&s.remainingCostUsd?q(s.valueUsd).sub(q(s.remainingCostUsd)).decimal():null,remainingTokenAmount:s.quantity,remainingCostBasisUsd:s.remainingCostUsd,
      feeInclusiveCostUsd:s.capitalUsd??estimate!.knownCapitalUsd,priceUsd:row.r.valuation_status==='no_liquidity'?null:row.r.price_usd,pricedAt:iso(row.r.observed_at),valuationSource:'node',
      ...(s.investedUsd!==null&&s.soldUsd!==null&&s.transferOutIncomeUsd!==null&&s.feesUsd!==null?{cashFlow:{investedUsd:s.investedUsd,soldUsd:s.soldUsd,transferOutIncomeUsd:s.transferOutIncomeUsd,feesUsd:s.feesUsd}}:{}),...(complete?{}:{reason})};
    const result:KolTokenActivity={kol:identity?{address:wallet,name:identity.display_name,avatarUrl:identity.avatar_url,twitter:identity.twitter,source:'node',lastSeenAt:iso(row.r.last_event_at)}:
      {address:wallet,name:null,avatarUrl:null,twitter:null,source:'node',lastSeenAt:iso(row.r.last_event_at)},
      token:{address:token,symbol:row.r.symbol,name:row.r.name,logoUrl:row.r.logo_data?`/api/token-image/${token}`:row.r.logo_url,priceUsd:row.r.valuation_status==='no_liquidity'?null:row.r.price_usd,marketCapUsd:row.r.valuation_status==='no_liquidity'?null:row.r.market_cap_usd,
        marketCapSupply:row.r.total_supply_raw!=null&&row.r.decimals!=null?q(String(row.r.total_supply_raw)).div(new FreshRational(10n**BigInt(row.r.decimals))).decimal(255):null,valuationStatus:row.r.valuation_status},
      trades:page.items,summary:{investedUsd:s.investedUsd,soldUsd:s.soldUsd,realizedProfitUsd:row.realizedComplete?s.realizedProfitUsd:null,avgBoughtPriceUsd:null,avgSoldPriceUsd:null,
        avgBoughtMcapUsd:null,avgSoldMcapUsd:null,remainingTokenAmount:s.quantity,remainingCostBasisUsd:s.remainingCostUsd,buyCount:counts.buys,sellCount:counts.sells,
        valuedBuyCount:counts.valued_buys,valuedSellCount:counts.valued_sells,excludedSellCount:counts.sells-counts.valued_sells,unpricedTradeCount:counts.unpriced??(complete?0:1),firstTradeAt:iso(counts.first_at),lastTradeAt:iso(counts.last_at),
        status:s.quantity==='0'?'closed':'open',profitBasis:'observed_fifo'},accountingSnapshot:row.snapshot,
      realizedAccounting:{version:2,source:row.snapshot.source,policy:'kollens_fifo_v1',walletAddress:wallet,tokenAddress:token,status:row.realizedComplete?'ready':estimate?'estimated':pending?'pending':'unavailable',checkedAt:row.snapshot.asOf,
        realizedProfitUsd:row.realizedComplete?s.realizedProfitUsd:null,coverage:{transactionsComplete:row.balanceReady,balanceMatched:row.balanceReady,verification:row.snapshot.source==='mixed'?'mixed_history':'node_history',...(complete?{}:{reason})},
        ...(profitPosition?{position:profitPosition}:{})},
      coverage:{source:'indexed',indexedTradeCount:counts.buys+counts.sells,returnedTradeCount:page.items.length,complete:row.realizedComplete&&counts.buys+counts.sells<=100,historyLimit:100,costsIncluded:false},generatedAt:new Date(now()).toISOString()};
    Object.assign(result,{__freshRevision:{scopeId,correctionEpoch:String(row.scope.correction_epoch),membershipRevision:String(row.scope.revision),...(tokenHistory(row.scope,token)?{historyPermissionDigest:tokenHistory(row.scope,token)!.permissionDigest}:{})}});
    result.tracking={version:1,source:'fresh',fromBlock:tokenFrom(row.scope,token),utcDay:freshUtcDay(now()),realizedComplete:row.realizedComplete};
    if(replay){
      const estimatedReplay=!!estimate&&row.balanceReady&&estimate.totalProfitUsd!==null;
      if(!row.realizedComplete&&!estimatedReplay){result.replayAccounting={version:2,source:row.snapshot.source,policy:'kollens_fifo_v1',walletAddress:wallet,tokenAddress:token,status:pending?'pending':'unavailable',checkedAt:row.snapshot.asOf,
        inventoryBlockNumber:row.r.balance_block==null?null:String(row.r.balance_block),inventoryBlockHash:row.r.balance_hash??null,events:[],final:null,
        coverage:{transactionsComplete:false,balanceMatched:row.balanceReady,exactFinal:false,verification:row.snapshot.source==='mixed'?'mixed_history':'node_history',reason}};return result;}
      const events=(await db.query(`SELECT e.* FROM fresh.financial_events e JOIN fresh.scope_event_results r ON r.event_id=e.id JOIN fresh.tokens t ON t.address=e.token_address JOIN fresh.accounting_scopes s ON s.id=r.scope_id AND s.active WHERE r.scope_id=$1 AND r.token_address=$2 AND e.wallet_address=ANY(s.wallet_addresses) AND ${freshScopeEventSql('e','s')} AND e.canonical AND ${freshTrackedEventSql('e','t')} ORDER BY e.block_number,e.transaction_index,e.execution_index,e.log_index NULLS FIRST,e.id`,[scopeId,token])).rows;
      const scope:FreshScope={...typedScope(row.scope),tokenHistoryStarts:row.scope.tokenHistoryStarts};
      let position=null as ReturnType<typeof freshPositionFromRow>|null,lots:FreshLot[]=[],estimatedRealized=FreshRational.fromStored('0');const frames=[],feeKeys=new Set<string>(),profits=new Map<string,{event:string|null;cumulative:string|null}>();
      for(const e of events){const event=freshEventFromRow(e);
        const feeKey=event.feeKey?`${event.walletAddress}:${event.feeKey}`:null;
        const applied=applyFreshEvent(scope,event,{position,lots,feeAlreadyApplied:feeKey!==null&&feeKeys.has(feeKey)});if(feeKey)feeKeys.add(feeKey);position=applied.position;lots=applied.lots;if(!position)continue;
        estimatedRealized=estimatedRealized.add(FreshRational.fromStored(applied.result.realizedQ??applied.result.estimatedRealizedQ??'0'));
        const marked=summarizeFreshPosition(position,lots,null);if(estimatedReplay){marked.realizedProfitUsd=estimatedRealized.decimal();marked.remainingCostUsd=lots.reduce((n,l)=>n.add(FreshRational.fromStored(l.costQ??l.knownCostQ??'0')),FreshRational.fromStored('0')).decimal();marked.investedUsd=FreshRational.fromStored(position.investedQ).decimal();marked.soldUsd=FreshRational.fromStored(position.soldQ).decimal();marked.feesUsd=FreshRational.fromStored(position.feesQ).decimal();marked.capitalUsd=FreshRational.fromStored(position.capitalQ).decimal();}
        profits.set(e.id,{event:applied.result.realizedQ,cumulative:position.realizedQ});frames.push({id:e.id,tradeId:['buy','sell'].includes(e.kind)?e.id:undefined,kind:e.kind,txHash:e.transaction_hash,timestamp:iso(e.occurred_at)!,blockNumber:String(e.block_number),transactionIndex:e.transaction_index,logIndex:e.log_index,
          remainingTokenAmount:marked.quantity,remainingCostBasisUsd:marked.remainingCostUsd,cumulativeRealizedProfitUsd:marked.realizedProfitUsd,investedUsd:marked.investedUsd,soldUsd:marked.soldUsd,transferOutIncomeUsd:marked.transferOutIncomeUsd,feesUsd:marked.feesUsd,feeInclusiveCostUsd:marked.capitalUsd});}
      const last=frames.at(-1),final=last?{...last,remainingTokenAmount:s.quantity,remainingCostBasisUsd:s.remainingCostUsd,cumulativeRealizedProfitUsd:s.realizedProfitUsd,investedUsd:s.investedUsd,soldUsd:s.soldUsd,transferOutIncomeUsd:s.transferOutIncomeUsd,feesUsd:s.feesUsd,feeInclusiveCostUsd:s.capitalUsd,reportedProfitUsd:s.estimatedProfitUsd,reportedRoi:s.roi,priceUsd:s.quantity==='0'?null:row.r.price_usd,timestamp:s.quantity==='0'?iso(row.r.last_event_at)!:iso(row.r.observed_at)??row.snapshot.asOf}:null;
      if(estimatedReplay&&final){if(estimatedRealized.compare(q(estimate.realizedProfitUsd))!==0&&estimatedRealized.decimal()!==estimate.realizedProfitUsd)throw Error('estimated_replay_projection_mismatch');Object.assign(final,{...last,remainingTokenAmount:s.quantity,remainingCostBasisUsd:estimate.knownRemainingCostUsd,cumulativeRealizedProfitUsd:estimate.realizedProfitUsd,feeInclusiveCostUsd:estimate.knownCapitalUsd,reportedProfitUsd:estimate.totalProfitUsd,reportedRoi:null,priceUsd:s.quantity==='0'?null:row.r.price_usd,timestamp:s.quantity==='0'?iso(row.r.last_event_at)!:iso(row.r.observed_at)??row.snapshot.asOf});}
      result.replayAccounting={version:2,source:row.snapshot.source,policy:'kollens_fifo_v1',walletAddress:wallet,tokenAddress:token,status:complete?'ready':estimatedReplay?'estimated':pending?'pending':'unavailable',checkedAt:row.snapshot.asOf,
        inventoryBlockNumber:row.r.balance_block==null?null:String(row.r.balance_block),inventoryBlockHash:row.r.balance_hash??null,events:frames,final,
        coverage:{transactionsComplete:row.balanceReady,balanceMatched:row.balanceReady,exactFinal:complete,...(estimatedReplay?{estimatedFinal:true}:{}),verification:row.snapshot.source==='mixed'?'mixed_history':'node_history',...(complete?{}:{reason})}};
      const eventsById=new Map(events.map(event=>[event.id,event]));
      result.inventory={version:1,events:frames.map(frame=>({...frame,tokenAmount:freshQuantity(eventsById.get(frame.id)!.quantity)})),
        coverage:{complete:row.balanceReady,reconciled:row.balanceReady,fromBlock:tokenFrom(row.scope,token),toBlock:row.r.balance_block==null?null:String(row.r.balance_block),blockHash:row.r.balance_hash??null,
          checkedAt:iso(row.r.balance_checked_at),balance:row.r.balance_quantity??s.quantity,status:row.balanceReady?'verified':'pending',scannedThroughBlock:row.r.balance_block==null?null:String(row.r.balance_block),
          initialBalanceSource:row.balanceReady?'derived_complete_movements':null,...(row.balanceReady?{}:{reason})}};
      result.coverage.complete=row.realizedComplete;result.coverage.returnedTradeCount=result.coverage.indexedTradeCount;
      // The export must include every recorded trade, even when the details page is paginated.
      result.trades=events.filter(e=>e.kind==='buy'||e.kind==='sell').map(e=>tradeIdentity({...row.r,...e,price_usd:e.price_usd,event_realized_q:profits.get(e.id)?.event,cumulative_realized_q:profits.get(e.id)?.cumulative,display_name:identity?.display_name,avatar_url:identity?.avatar_url,twitter:identity?.twitter}));
    }
    return result;
  }
  const service={boundary,state,leaderboard,positionRows,summaries,trades,activity};
  if(transactional)return service;
  const wrapped={...service};
  for(const key of ['leaderboard','positionRows','summaries','trades','activity'] as const){
    (wrapped as unknown as Record<string,(...values:unknown[])=>Promise<unknown>>)[key]=async(...args:unknown[])=>{const client=await db.connect();try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const inner:typeof service=createFreshReads(client as unknown as Pool,now,true,options);const value=await (inner[key] as (...values:unknown[])=>Promise<unknown>)(...args);await client.query('COMMIT');return value;
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
  }
  return wrapped;
}
