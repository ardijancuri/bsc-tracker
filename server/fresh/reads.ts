import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { KolTokenActivity, KolTokenTrade,KolTokenProfitPosition } from '../../shared/kolTokenTrades.js';
import type { NodeAccountingSummary } from '../../shared/nodeAccounting.js';
import { applyFreshEvent, freshDecimal, freshQuantity, freshEventFromRow, freshLotFromRow, freshPositionFromRow, FreshRational, freshUtcDay, summarizeFreshPosition,freshFeeExclusions } from './accounting.js';
import type { FreshFinancialEvent, FreshLot, FreshScope } from '../../shared/freshAccounting.js';
import { freshPositionReceiptRelevantSql } from './positionDependencies.js';
import { freshPositionWalletGapSql } from './balanceScheduling.js';
import { freshStoredKolRollingMetrics, rankFreshStoredLeaderboard, freshRollingLeaderboardPendingSql } from './leaderboard.js';
import {freshTradeBnbEquivalent} from './tradeBnbDisplay.js';

const iso = (v: unknown) => v == null ? null : new Date(v as string).toISOString();
const fingerprint = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const q = FreshRational.parse;
const preparationPending=(reasons:string[])=>reasons.length>0&&reasons.every(reason=>['balance_pending','decoding_pending','registration_pending','quote_unavailable'].includes(reason));
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
  const amount = freshDecimal(r.amount_usd), quantity = freshQuantity(r.quantity ?? r.token_amount);
  const bnbEquivalent=freshTradeBnbEquivalent(r);
  return { id:r.id,txHash:r.transaction_hash ?? r.tx_hash,walletAddress:r.wallet_address,tokenAddress:r.token_address,
    kolName:r.display_name ?? null,kolAvatarUrl:r.avatar_url ?? null,kolTwitter:r.twitter ?? null,
    tokenSymbol:r.symbol ?? null,tokenName:r.name ?? null,tokenLogoUrl:r.logo_data ? `/api/token-image/${r.token_address}` : r.logo_url ?? null,
    side:r.kind ?? r.side,tokenAmount:quantity,quoteSymbol:r.quote_symbol ?? null,quoteTokenAddress:r.quote_address??null,quoteAmount:freshQuantity(r.quote_amount ?? null),
    ...(bnbEquivalent!==null?{bnbEquivalentAmount:bnbEquivalent}:{}),
    ...(r.acquisition_cost?{acquisitionCost:r.acquisition_cost}:{}),
    amountUsd:amount,priceUsd:r.price_usd ?? (amount && quantity && q(quantity).n !== 0n ? q(amount).div(q(quantity)).decimal() : null),
    marketCapUsd:null,timestamp:iso(r.occurred_at ?? r.timestamp)!,source:'node',blockNumber:String(r.block_number),transactionIndex:r.transaction_index,
    valuationStatus:amount === null ? 'unpriced' : 'valued',realizedProfitUsd:freshDecimal(r.event_realized_q ?? null),cumulativeRealizedProfitUsd:freshDecimal(r.cumulative_realized_q??null) };
}

/** Read paths touch current rows and bounded pages. Financial history is replayed only for an explicitly requested export. */
export function createFreshReads(db: Pool, now = Date.now, transactional=false) {
  async function boundary() { return (await db.query(`SELECT block_number::text,block_hash,value FROM fresh.checkpoints WHERE key='start'`)).rows[0] ?? null; }
  async function state() { const rows = (await db.query(`SELECT key,block_number::text,block_hash,updated_at,value FROM fresh.checkpoints WHERE key IN('start','capture','decode','quote','utc_day')`)).rows;
    return Object.fromEntries(rows.map(row=>[row.key,row])); }
  async function leaderboard() {
    const at=now(),states=await state(),day=freshUtcDay(at),windowStart=new Date(at-86_400_000).toISOString(),windowEnd=new Date(at).toISOString();
    const result=await db.query(`SELECT k.*,k.today_utc::text AS utc_date,p.address,p.display_name,p.avatar_url,p.twitter,p.creator_claimed,p.creator_bio,
      w.decode_gap_from_block,w.decode_gap_reason,
      ${freshRollingLeaderboardPendingSql()} AS decoding_pending,
      p.creator_website_url,p.creator_x_url,p.creator_telegram_url,p.creator_updated_at
      FROM fresh.kols k JOIN fresh.wallets w ON w.address=k.wallet_address JOIN published_kols p ON p.address=k.wallet_address WHERE k.is_tracked`,[windowStart,windowEnd]);
    const items=result.rows.map(r=>{
      const stored=freshStoredKolRollingMetrics(r,at),{current,realizedProfitUsd:realized,knownRealizedProfitUsd:known}=stored;
      const valuedSell=stored.valuedSellCount,excludedSell=stored.excludedSellCount,
        valuedTransfer=stored.valuedTransferCount,excludedTransfer=stored.excludedTransferCount,
        valuedFee=stored.valuedFeeCount,excludedFee=stored.excludedFeeCount;
      const asOf=stored.updatedAt ?? iso(states.decode?.updated_at ?? states.start?.updated_at) ?? `${day}T00:00:00.000Z`;
      return { ...kolIdentity(r),realizedProfitUsd:realized,knownRealizedProfitUsd:known,unrealizedProfitUsd:null,updatedAt:stored.updatedAt,
        tradeCount24h:stored.tradeCount,buyCount24h:current?r.rolling_buy_count:0,sellCount24h:current?r.rolling_sell_count:0,
        unpricedSellCount24h:excludedSell,valuedSellCount:valuedSell,excludedSellCount:excludedSell,
        accounting:{version:1,policy:'kollens_fifo_v1',period:'24h' as const,walletAddress:r.wallet_address,windowStart,windowEnd,
          snapshotId:fingerprint([r.wallet_address,'24h',r.revision]),asOf,source:'node',coveredThroughBlock:states.decode?.block_number ?? null,
          coveredThroughHash:states.decode?.block_hash ?? null,complete:stored.complete,reasons:stored.reasons,
          realizedProfitUsd:realized,knownRealizedProfitUsd:known,valuedSellCount:valuedSell,
          excludedSellCount:excludedSell,valuedTransferOutCount:valuedTransfer,excludedTransferOutCount:excludedTransfer,
          valuedFeeCount:valuedFee,excludedFeeCount:excludedFee,feeOnlyFeesUsd:current?freshDecimal(r.rolling_fee_only_q):'0',exclusions:{feeOnly:freshFeeExclusions(current?{
            unallocated_fee_count:r.rolling_unallocated_fee_count,unallocated_fee_q:r.rolling_unallocated_fee_q,
            unallocated_fee_unknown_count:r.rolling_unallocated_fee_unknown_count,unattributed_fee_count:r.rolling_unattributed_fee_count}:undefined)}},
        period:'24h' as const,windowStart,windowEnd,utcDay:day,trackingBoundary:states.start?.block_number ?? null,accountingStatus:stored.complete?'ready':r.decoding_pending?'refreshing':'pending',
        ...(r.decoding_pending?{refreshStatus:'pending' as const}:{}), };
    });
    return {items:rankFreshStoredLeaderboard(items),windowStart,windowEnd,period:'24h' as const,utcDay:day,trackingBoundary:states.start?.block_number ?? null,accountingPolicy:'kollens_fifo_v1'};
  }
  async function positionRows(scopeId:string,tokens?:string[]) {
    const rows=await db.query(`SELECT p.*,t.*,p.token_address AS address,p.revision AS position_revision,last.block_number AS last_event_block,
        ${freshPositionWalletGapSql("(SELECT block_number FROM fresh.checkpoints WHERE key='capture')")} AS wallet_gap,
        EXISTS(SELECT 1 FROM fresh.jobs j WHERE j.kind='registration_capture' AND j.reference=ANY(s.wallet_addresses) AND j.state NOT IN('done','cancelled')) AS registration_pending,
        EXISTS(SELECT 1 FROM fresh.recent_evidence e WHERE e.wallet_addresses&&s.wallet_addresses AND e.block_number>=s.starts_block AND e.decoder_status<>'done'
          AND ${freshPositionReceiptRelevantSql('e','p.token_address')}) AS decoding_pending
        FROM fresh.positions p JOIN fresh.tokens t ON t.address=p.token_address JOIN fresh.accounting_scopes s ON s.id=p.scope_id
        LEFT JOIN fresh.financial_events last ON last.id=p.last_event_id WHERE p.scope_id=$1 ${tokens?'AND p.token_address=ANY($2::text[])':''}`,tokens?[scopeId,tokens]:[scopeId]);
    const lots=await db.query(`SELECT * FROM fresh.open_lots WHERE scope_id=$1 ${tokens?'AND token_address=ANY($2::text[])':''}`,tokens?[scopeId,tokens]:[scopeId]);
    const scopes=await db.query(`SELECT * FROM fresh.accounting_scopes WHERE id=$1 AND active`,[scopeId]),states=await state();
    const scope=scopes.rows[0]; if(!scope)return [];
    const lotsByToken=new Map<string,FreshLot[]>();for(const row of lots.rows){const list=lotsByToken.get(row.token_address)??[];list.push(freshLotFromRow(row));lotsByToken.set(row.token_address,list);}
    return rows.rows.map(r=>{
      const owned=lotsByToken.get(r.token_address)??[];
      const position=freshPositionFromRow({...r,revision:r.position_revision});
      const priced=iso(r.observed_at),fresh=r.valuation_status==='ready'&&priced!==null&&now()-Date.parse(priced)<=120_000&&now()>=Date.parse(priced)
        &&r.last_event_block!=null&&r.observed_block!=null&&BigInt(r.observed_block)>=BigInt(r.last_event_block);
      const summary=summarizeFreshPosition(position,owned,fresh?r.price_usd:null);
      const balanceReady=r.balance_status==='matched'&&r.balance_quantity!=null&&q(r.balance_quantity).compare(q(position.quantityQ))===0&&r.balance_block!=null&&/^0x[\da-f]{64}$/.test(r.balance_hash??'')&&r.last_event_block!=null
        &&BigInt(r.balance_block)>=BigInt(r.last_event_block)&&states.capture?.block_number!=null&&BigInt(r.balance_block)<=BigInt(states.capture.block_number)
        &&Date.parse(r.balance_checked_at)>=Date.parse(r.last_event_at??0)&&!r.wallet_gap&&!r.decoding_pending&&!r.registration_pending;
      const realizedComplete=balanceReady&&!position.unknownCost&&!position.unknownFee&&position.realizedQ!==null;
      const financialReasons=[...(position.unknownCost?['unknown_costs']:[]),...(position.unknownFee?['unknown_fees']:[]),...(balanceReady?[]:[r.wallet_gap?'wallet_decode_gap':r.registration_pending?'registration_pending':r.decoding_pending?'decoding_pending':r.balance_status==='mismatch'?'balance_mismatch':'balance_pending'])];
      const endingReady=realizedComplete&&summary.status==='complete',endingReasons=[...financialReasons,...(summary.status==='quote_unavailable'?['quote_unavailable']:[])];
      const snapshotId=fingerprint([scopeId,r.token_address,r.position_revision,r.observed_hash,r.observed_at,scope.correction_epoch,scope.revision,r.balance_block,r.balance_hash,r.balance_quantity,r.balance_status,r.wallet_gap,r.decoding_pending,r.registration_pending]);
      const snapshot={version:2 as const,snapshotId,source:'node' as const,scope:(scope.kind==='kol'?'public':'portfolio') as 'public'|'portfolio',
        asOf:iso(r.balance_checked_at)??iso(states.decode?.updated_at)??new Date(now()).toISOString(),historyFingerprint:fingerprint([scopeId,r.token_address,scope.correction_epoch,r.position_revision]),
        historyFrom:iso(scope.starts_at),coveredThroughBlock:balanceReady?String(r.balance_block):states.decode?.block_number??null,valuationBlock:r.observed_block==null?null:String(r.observed_block),
        valuationHash:r.observed_hash??null,complete:realizedComplete,reasons:financialReasons,historyBoundary:scope.kind==='kol'?'token_creation' as const:'membership_added' as const,
        ...(realizedComplete&&!endingReady?{refreshStatus:'pending' as const,refreshReason:'quote_unavailable'}:{})};
      return {r,position,lots:owned,summary,snapshot,scope,balanceReady,realizedComplete,endingReady,endingReasons};
    });
  }
  async function summaries(wallet:string,tokens:string[],scopeId=publicScope(wallet)):Promise<Record<string,NodeAccountingSummary>> {
    const rows=await positionRows(scopeId,tokens);return Object.fromEntries(rows.map(({r,summary:s,snapshot,scope,realizedComplete,endingReady,endingReasons,balanceReady})=>[r.token_address,{
      tracking:{version:1,source:'fresh',fromBlock:String(scope.starts_block),utcDay:freshUtcDay(now())},walletAddress:wallet,quotedAt:iso(r.observed_at),
      realizedStatus:realizedComplete?'ready':preparationPending(snapshot.reasons)?'pending':'unavailable',
      tokenAddress:r.token_address,snapshot,status:endingReady?'ready':preparationPending(endingReasons)?'pending':'unavailable',position:s.quantity==='0'?'closed':'open',realizedProfitUsd:realizedComplete?s.realizedProfitUsd:null,
      estimatedProfitUsd:endingReady?s.estimatedProfitUsd:null,roi:endingReady?s.roi:null,remainingTokenAmount:s.quantity,valueUsd:balanceReady?s.valueUsd:null,...(endingReady?{}:{reason:endingReasons[0]}) }]));
  }
  async function trades(options:{wallet?:string;token?:string;limit?:number;cursor?:string;scopeId?:string;today?:boolean;window?:'24h';windowStart?:string;windowEnd?:string}={}) {
    const values:unknown[]=[],where=[`e.canonical`,`e.kind IN('buy','sell')`,`t.launch_status='eligible'`];
    if(options.scopeId){values.push(options.scopeId);where.push(`s.id=$${values.length}`,'s.active');}else where.push('k.is_tracked');
    for(const [name,value]of [['wallet_address',options.wallet],['token_address',options.token]])if(value){values.push(value);where.push(`e.${name}=$${values.length}`);}
    const end=options.windowEnd??new Date(now()).toISOString();
    const start=options.windowStart??(options.window==='24h'?new Date(Date.parse(end)-86_400_000).toISOString():options.today?`${freshUtcDay(now())}T00:00:00.000Z`:null);
    if(start){values.push(start);where.push(`e.occurred_at${options.window==='24h'?'>' : '>='}$${values.length}::timestamptz`);}
    if(options.window==='24h'||options.windowEnd){values.push(end);where.push(`e.occurred_at<=$${values.length}::timestamptz`);}
    if(options.cursor){try{const cursor=JSON.parse(Buffer.from(options.cursor,'base64url').toString());if(typeof cursor.ts==='string'&&Number.isFinite(Date.parse(cursor.ts))&&typeof cursor.id==='string'){values.push(cursor.ts,cursor.id);where.push(`(e.occurred_at,e.id)<($${values.length-1}::timestamptz,$${values.length})`);}}catch{}}
    values.push(Math.min(options.limit??50,100)+1);
    const rows=(await db.query(`SELECT e.*,t.name,t.symbol,t.logo_url,t.logo_data,p.display_name,p.avatar_url,p.twitter,
      r.realized_q AS event_realized_q FROM fresh.financial_events e JOIN fresh.tokens t ON t.address=e.token_address
      ${options.scopeId?'JOIN fresh.accounting_scopes s ON s.id=$1 JOIN fresh.scope_event_results r ON r.event_id=e.id AND r.scope_id=s.id':'JOIN fresh.kols k ON k.wallet_address=e.wallet_address LEFT JOIN fresh.scope_event_results r ON r.event_id=e.id AND r.scope_id=\'kol:\'||e.wallet_address'}
      LEFT JOIN published_kols p ON p.address=e.wallet_address WHERE ${where.join(' AND ')} ORDER BY e.occurred_at DESC,e.id DESC LIMIT $${values.length}`,values)).rows;
    const limit=Math.min(options.limit??50,100),items=rows.slice(0,limit).map(tradeIdentity),last=items.at(-1);
    return {items,nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify({ts:last.timestamp,id:last.id})).toString('base64url'):null};
  }
  async function activity(wallet:string,token:string,scopeId=publicScope(wallet),replay=false):Promise<KolTokenActivity|null> {
    const [row]=await positionRows(scopeId,[token]);if(!row)return null;
    if(!row.scope.wallet_addresses.includes(wallet)||row.scope.kind==='portfolio_combined')return null;
    const identity=(await db.query(`SELECT * FROM published_kols WHERE address=$1`,[wallet])).rows[0];
    if(row.scope.kind==='kol'&&!identity?.is_tracked)return null;
    const page=await trades({wallet,token,scopeId,limit:100});const s=row.summary;
    const counts=(await db.query(`SELECT count(*) FILTER(WHERE e.kind='buy')::int AS buys,count(*) FILTER(WHERE e.kind='sell')::int AS sells,
      min(e.occurred_at) AS first_at,max(e.occurred_at) AS last_at FROM fresh.scope_event_results r JOIN fresh.financial_events e ON e.id=r.event_id
      WHERE r.scope_id=$1 AND r.token_address=$2 AND e.canonical`,[scopeId,token])).rows[0];
    const complete=row.endingReady,reason=row.endingReasons[0]??s.status,pending=preparationPending(row.endingReasons);
    const profitPosition:KolTokenProfitPosition|undefined=s.capitalUsd===null?undefined:{status:s.quantity==='0'?'closed':'open',estimatedProfitUsd:complete?s.estimatedProfitUsd:null,estimatedRoi:complete?s.roi:null,
      unrealizedProfitUsd:complete&&s.valueUsd&&s.remainingCostUsd?q(s.valueUsd).sub(q(s.remainingCostUsd)).decimal():null,remainingTokenAmount:s.quantity,remainingCostBasisUsd:s.remainingCostUsd,
      feeInclusiveCostUsd:s.capitalUsd,priceUsd:row.r.valuation_status==='no_liquidity'?null:row.r.price_usd,pricedAt:iso(row.r.observed_at),valuationSource:'node',
      ...(s.investedUsd!==null&&s.soldUsd!==null&&s.transferOutIncomeUsd!==null&&s.feesUsd!==null?{cashFlow:{investedUsd:s.investedUsd,soldUsd:s.soldUsd,transferOutIncomeUsd:s.transferOutIncomeUsd,feesUsd:s.feesUsd}}:{}),...(complete?{}:{reason})};
    const result:KolTokenActivity={kol:identity?{address:wallet,name:identity.display_name,avatarUrl:identity.avatar_url,twitter:identity.twitter,source:'node',lastSeenAt:iso(row.r.last_event_at)}:
      {address:wallet,name:null,avatarUrl:null,twitter:null,source:'node',lastSeenAt:iso(row.r.last_event_at)},
      token:{address:token,symbol:row.r.symbol,name:row.r.name,logoUrl:row.r.logo_data?`/api/token-image/${token}`:row.r.logo_url,priceUsd:row.r.valuation_status==='no_liquidity'?null:row.r.price_usd,marketCapUsd:row.r.valuation_status==='no_liquidity'?null:row.r.market_cap_usd,
        marketCapSupply:row.r.total_supply_raw!=null&&row.r.decimals!=null?q(String(row.r.total_supply_raw)).div(new FreshRational(10n**BigInt(row.r.decimals))).decimal(255):null,valuationStatus:row.r.valuation_status},
      trades:page.items,summary:{investedUsd:s.investedUsd,soldUsd:s.soldUsd,realizedProfitUsd:s.realizedProfitUsd,avgBoughtPriceUsd:null,avgSoldPriceUsd:null,
        avgBoughtMcapUsd:null,avgSoldMcapUsd:null,remainingTokenAmount:s.quantity,remainingCostBasisUsd:s.remainingCostUsd,buyCount:counts.buys,sellCount:counts.sells,
        valuedBuyCount:counts.buys,valuedSellCount:counts.sells,excludedSellCount:0,unpricedTradeCount:complete?0:1,firstTradeAt:iso(counts.first_at),lastTradeAt:iso(counts.last_at),
        status:s.quantity==='0'?'closed':'open',profitBasis:'observed_fifo'},accountingSnapshot:row.snapshot,
      realizedAccounting:{version:2,source:'node',policy:'kollens_fifo_v1',walletAddress:wallet,tokenAddress:token,status:row.realizedComplete?'ready':pending?'pending':'unavailable',checkedAt:row.snapshot.asOf,
        realizedProfitUsd:s.realizedProfitUsd,coverage:{transactionsComplete:row.balanceReady,balanceMatched:row.balanceReady,verification:'node_history',...(complete?{}:{reason})},
        ...(profitPosition?{position:profitPosition}:{})},
      coverage:{source:'indexed',indexedTradeCount:counts.buys+counts.sells,returnedTradeCount:page.items.length,complete:counts.buys+counts.sells<=100,historyLimit:100,costsIncluded:false},generatedAt:new Date(now()).toISOString()};
    Object.assign(result,{__freshRevision:{scopeId,correctionEpoch:String(row.scope.correction_epoch),membershipRevision:String(row.scope.revision)}});
    result.tracking={version:1,source:'fresh',fromBlock:String(row.scope.starts_block),utcDay:freshUtcDay(now()),realizedComplete:row.realizedComplete};
    if(replay){
      const events=(await db.query(`SELECT e.* FROM fresh.financial_events e JOIN fresh.scope_event_results r ON r.event_id=e.id WHERE r.scope_id=$1 AND r.token_address=$2 AND e.canonical ORDER BY e.block_number,e.transaction_index,e.execution_index,e.log_index NULLS FIRST,e.id`,[scopeId,token])).rows;
      const scope:FreshScope={id:scopeId,kind:row.scope.kind,walletAddresses:row.scope.wallet_addresses,accountId:row.scope.account_id,startsAt:iso(row.scope.starts_at)!,startsBlock:String(row.scope.starts_block),revision:String(row.scope.revision)};
      let position=null as ReturnType<typeof freshPositionFromRow>|null,lots:FreshLot[]=[];const frames=[],feeKeys=new Set<string>(),profits=new Map<string,{event:string|null;cumulative:string|null}>();
      for(const e of events){const event=freshEventFromRow(e);
        const feeKey=event.feeKey?`${event.walletAddress}:${event.feeKey}`:null;
        const applied=applyFreshEvent(scope,event,{position,lots,feeAlreadyApplied:feeKey!==null&&feeKeys.has(feeKey)});if(feeKey)feeKeys.add(feeKey);position=applied.position;lots=applied.lots;if(!position)continue;
        const marked=summarizeFreshPosition(position,lots,null);profits.set(e.id,{event:applied.result.realizedQ,cumulative:position.realizedQ});frames.push({id:e.id,tradeId:['buy','sell'].includes(e.kind)?e.id:undefined,kind:e.kind,txHash:e.transaction_hash,timestamp:iso(e.occurred_at)!,blockNumber:String(e.block_number),transactionIndex:e.transaction_index,logIndex:e.log_index,
          remainingTokenAmount:marked.quantity,remainingCostBasisUsd:marked.remainingCostUsd,cumulativeRealizedProfitUsd:marked.realizedProfitUsd,investedUsd:marked.investedUsd,soldUsd:marked.soldUsd,transferOutIncomeUsd:marked.transferOutIncomeUsd,feesUsd:marked.feesUsd,feeInclusiveCostUsd:marked.capitalUsd});}
      const last=frames.at(-1),final=last?{...last,remainingTokenAmount:s.quantity,remainingCostBasisUsd:s.remainingCostUsd,cumulativeRealizedProfitUsd:s.realizedProfitUsd,investedUsd:s.investedUsd,soldUsd:s.soldUsd,transferOutIncomeUsd:s.transferOutIncomeUsd,feesUsd:s.feesUsd,feeInclusiveCostUsd:s.capitalUsd,reportedProfitUsd:s.estimatedProfitUsd,reportedRoi:s.roi,priceUsd:s.quantity==='0'?null:row.r.price_usd,timestamp:s.quantity==='0'?iso(row.r.last_event_at)!:iso(row.r.observed_at)??row.snapshot.asOf}:null;
      result.replayAccounting={version:2,source:'node',policy:'kollens_fifo_v1',walletAddress:wallet,tokenAddress:token,status:complete?'ready':pending?'pending':'unavailable',checkedAt:row.snapshot.asOf,
        inventoryBlockNumber:row.r.balance_block==null?null:String(row.r.balance_block),inventoryBlockHash:row.r.balance_hash??null,events:frames,final,
        coverage:{transactionsComplete:row.balanceReady,balanceMatched:row.balanceReady,exactFinal:complete,verification:'node_history',...(complete?{}:{reason})}};
      const eventsById=new Map(events.map(event=>[event.id,event]));
      result.inventory={version:1,events:frames.map(frame=>({...frame,tokenAmount:freshQuantity(eventsById.get(frame.id)!.quantity)})),
        coverage:{complete:row.balanceReady,reconciled:row.balanceReady,fromBlock:String(row.scope.starts_block),toBlock:row.r.balance_block==null?null:String(row.r.balance_block),blockHash:row.r.balance_hash??null,
          checkedAt:iso(row.r.balance_checked_at),balance:row.r.balance_quantity??s.quantity,status:row.balanceReady?'verified':'pending',scannedThroughBlock:row.r.balance_block==null?null:String(row.r.balance_block),
          initialBalanceSource:row.balanceReady?'derived_complete_movements':null,...(row.balanceReady?{}:{reason})}};
      result.coverage.complete=true;result.coverage.returnedTradeCount=result.coverage.indexedTradeCount;
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
      const inner:typeof service=createFreshReads(client as unknown as Pool,now,true);const value=await (inner[key] as (...values:unknown[])=>Promise<unknown>)(...args);await client.query('COMMIT');return value;
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
  }
  return wrapped;
}
