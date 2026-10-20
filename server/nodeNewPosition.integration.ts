// Frozen public evidence only. Never run against an application database.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import position from './fixtures/new-node-position.json' with { type: 'json' };
import market from './fixtures/new-node-position-market.json' with { type: 'json' };
const target = new URL(process.env.DATABASE_URL ?? '');
if (!['localhost','127.0.0.1'].includes(target.hostname) || target.port !== '5435'
  || !/^\/bscan_node_position_test_\d+$/.test(target.pathname)) throw Error('Use a fresh local disposable bscan_node_position_test database');
const savedNow = Date.now, dispatcher = getGlobalDispatcher(), blocked = new MockAgent();
blocked.disableNetConnect(); setGlobalDispatcher(blocked);
Date.now = () => Date.parse(market.frozenAt);
const { pool, ensureSchema } = await import('./db.js');
const { nodeAccountingService, saveNodeAccountingBaseline } = await import('./nodeAccounting.js');
const { registerKolTokenTradesRoutes } = await import('./kolTokenTradesApi.js');
// Load the real browser contract through tsx without making the server's
// NodeNext project adopt the frontend's separate bundler-resolution graph.
const browserContract = '../src/tradeReplayData.ts';
const { prepareTradeReplayData, applyReplayMarketChart, validReplayAccountingFinal } = await import(browserContract);
const app = Fastify(); registerKolTokenTradesRoutes(app);
const wallet = position.wallet, token = position.token, flow = position.flow;
async function insert(table: string, row: Record<string,unknown>) {
  assert.match(table,/^[a-z_]+$/);
  const columns = Object.keys(row); columns.forEach(column => assert.match(column,/^[a-z_][a-z_0-9]*$/));
  await pool.query(`INSERT INTO ${table}(${columns.join(',')}) SELECT ${columns.join(',')}
    FROM jsonb_populate_record(NULL::${table},$1::jsonb) ON CONFLICT DO NOTHING`,[JSON.stringify(row)]);
}
try {
  await ensureSchema();
  await insert('kols',{address:wallet,display_name:'CryptoCharming',source:'node',is_tracked:true});
  await insert('tokens',{address:token,symbol:market.tokenSymbol,name:market.tokenName,decimals:18});
  for(const block of market.blocks) await insert('node_evidence_blocks',{...block,header:{}});
  await insert('node_monitored_wallets',market.monitor);
  await insert('worker_state',{key:'node',value:{blockNumber:Number(market.balance.block_number),blockHash:market.balance.block_hash}});
  for(const range of market.coverage) await insert('node_evidence_ranges',{...range,head_block:Number(market.balance.block_number)+6,
    wallets:{[wallet]:market.monitor.generation},decoded_at:market.frozenAt});
  for(const evidence of market.metadata) await insert('node_market_token_evidence',evidence);
  await insert('node_market_feed_evidence',market.feed);
  await insert('node_accounting_balances',market.balance);
  await insert('journal_opening_balances',{wallet_address:wallet,token_address:token,block_number:market.monitor.registration_block,
    block_hash:market.monitor.registration_hash,balance_raw:'0',decimals:18});
  const executionColumns=['id','tx_hash','wallet_address','execution_index','operation_hash','block_number','block_hash','transaction_index','timestamp',
    'status','kind','fee_native_wei','fee_complete','fee_reason','native_value_raw','logs','decoder_version'] as const;
  await insert('node_evidence_transactions',{tx_hash:flow.tx_hash,block_number:flow.block_number,block_hash:flow.block_hash,
    transaction_index:flow.transaction_index,timestamp:flow.timestamp,transaction:{from:wallet,to:flow.transaction_to,value:'0x6f05b59d3b20000'},
    receipt:{status:'0x1',logs:flow.logs},decoded_version:flow.decoder_version,observed_live:true});
  await insert('node_executions',Object.fromEntries(executionColumns.map(key=>[key,flow[key]])));
  await insert('node_execution_flows',{execution_id:flow.id,token_address:token,delta_raw:flow.delta_raw,log_indices:flow.log_indices,counterparties:flow.counterparties});
  await insert('node_trace_evidence',{tx_hash:flow.tx_hash,block_hash:flow.block_hash,trace:flow.trace,checked_at:flow.timestamp});
  for(const identity of market.markets) await insert('node_markets',identity);
  for(const observation of market.observations) await insert('node_market_observations',{...observation,candles_pending:false});
  for(const range of market.marketRanges) await insert('node_market_ranges',range);
  await pool.query(`INSERT INTO node_market_candles(token_address,market_id,minute,open,high,low,close,volume_usd,observations,first_observation_at,last_observation_at)
    SELECT token_address,market_id,date_trunc('minute',timestamp),(array_agg(price_usd ORDER BY timestamp,block_number,transaction_index,log_index))[1],
      max(price_usd),min(price_usd),(array_agg(price_usd ORDER BY timestamp DESC,block_number DESC,transaction_index DESC,log_index DESC))[1],
      sum(COALESCE(volume_usd,0)),count(*),min(timestamp),max(timestamp) FROM node_market_observations WHERE kind='swap'
    GROUP BY token_address,market_id,date_trunc('minute',timestamp)`);
  // The old saved WBNB bar reproduces the feed-shadowing failure exactly.
  await insert('node_market_observations',{id:'saved-wbnb',token_address:market.feed.quote_address,kind:'imported',source:'imported',
    timestamp:'2026-10-12T10:35:00Z',price_usd:'749.95',supply_estimated:true,import_id:'saved-wbnb',candles_pending:false});
  const refreshed = await nodeAccountingService.refresh({wallet,token,foreground:true});
  assert.equal(refreshed?.accountingSnapshot?.complete,true,JSON.stringify(refreshed?.accountingSnapshot));
  assert.equal(refreshed.accountingSnapshot.historyBoundary,'verified_zero_position');
  assert.equal(refreshed.accountingSnapshot.lifetimeComplete,false);
  assert.equal(refreshed.summary.investedUsd,position.expectedInvestedUsd);
  assert.equal(refreshed.realizedAccounting?.position?.cashFlow?.feesUsd,'0.021434868967144932');
  const base=`/api/kols/${wallet}/tokens/${token}`;
  const details=await app.inject({url:base+'/activity?pnl=true'}); assert.equal(details.statusCode,200);
  const activity=details.json();
  const summaryReply=await app.inject({url:`/api/kols/${wallet}/token-summaries?tokens=${token}`});assert.equal(summaryReply.statusCode,200);
  const summary=summaryReply.json().summaries[token];
  assert.equal(summary.estimatedProfitUsd,activity.realizedAccounting.position.estimatedProfitUsd);
  const preparationReply=await app.inject({url:base+'/replay-preparation?snapshot='+activity.accountingSnapshot.snapshotId});
  assert.equal(preparationReply.statusCode,200);
  const preparation=preparationReply.json();
  assert.equal(preparation.status,'ready',JSON.stringify(preparation));
  assert.equal(preparation.snapshotId,activity.accountingSnapshot.snapshotId);
  assert.equal(preparation.activity.replayAccounting.final.reportedProfitUsd,activity.realizedAccounting.position.estimatedProfitUsd);
  assert.equal(preparation.activity.replayAccounting.final.reportedRoi,activity.realizedAccounting.position.estimatedRoi);
  const replayData=prepareTradeReplayData(activity,null,undefined,Date.now());
  assert.ok(replayData,'The browser accepts the genuine frozen proof and accounting envelope');
  const renderable=applyReplayMarketChart(replayData,preparation.chart,Date.now());
  const final=validReplayAccountingFinal(renderable,Date.now());
  assert.ok(final,'The actual browser replay contract accepts the prepared market window and ending');
  assert.equal(final.reportedProfitUsd,Number(summary.estimatedProfitUsd));
  assert.equal(final.reportedRoi,Number(summary.roi));
  if(process.env.NODE_POSITION_ARTIFACT) await writeFile(process.env.NODE_POSITION_ARTIFACT,JSON.stringify({frozenAt:market.frozenAt,activity,summary,preparation},null,2));
  // A subsequently reconciled lifetime baseline supersedes this explicit
  // captured scope instead of preserving its unknown older cycles as zero.
  const capital=activity.realizedAccounting.position.feeInclusiveCostUsd;
  await saveNodeAccountingBaseline(pool,{wallet,token,checkpoint:{...activity.realizedAccounting.coverage.balanceProof},
    historyFingerprint:'a'.repeat(64),overlapVerified:true,quantityVerified:true,
    ledger:{investedUsd:position.expectedInvestedUsd,soldUsd:'50',incomingTransferCostUsd:'0',transferOutIncomeUsd:'0',feesUsd:'0.021434868967144932',
      realizedProfitUsd:'50',feeInclusiveCapitalUsd:capital,lots:[{tokenAmount:market.balance.balance,costBasisUsd:capital}]}});
  const lifetime=await nodeAccountingService.refresh({wallet,token});
  assert.equal(lifetime?.accountingSnapshot?.complete,true);
  assert.equal(lifetime.accountingSnapshot.historyBoundary,'imported_baseline');
  assert.equal(lifetime.accountingSnapshot.lifetimeComplete,undefined);
  assert.notEqual(lifetime.accountingSnapshot.snapshotId,activity.accountingSnapshot.snapshotId);
  assert.notEqual(lifetime.accountingSnapshot.historyFingerprint,activity.accountingSnapshot.historyFingerprint);
  console.log(JSON.stringify({result:'Exact reported position integration passed',invested:activity.summary.investedUsd,
    fee:activity.realizedAccounting.position.cashFlow.feesUsd,profit:summary.estimatedProfitUsd,roi:summary.roi,
    snapshot:activity.accountingSnapshot.snapshotId,chartPoints:preparation.chart.points.length,frozenAt:market.frozenAt,
    lifetimeUpgrade:true,externalProvidersDisabled:true}));
} finally { await app.close(); await pool.end(); Date.now=savedNow;setGlobalDispatcher(dispatcher);await blocked.close(); }
