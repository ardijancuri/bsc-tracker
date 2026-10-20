import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { NodeLeaderboardSnapshot } from '../shared/nodeLeaderboard.js';
import { createNodeLeaderboardService } from './nodeLeaderboard.js';
import { rollbackNodeAccounting } from './nodeAccountingSchema.js';

const configured = new URL(process.env.DATABASE_URL ?? 'postgres://invalid');
if (!['localhost','127.0.0.1'].includes(configured.hostname) || configured.port !== '5435') throw new Error('Disposable local PostgreSQL only');
const admin = new pg.Client({ connectionString: configured.href }); await admin.connect();
const name = `node_leaderboard_test_${randomUUID().replaceAll('-','')}`;
await admin.query(`CREATE DATABASE "${name}"`);
const target = new URL(configured); target.pathname = `/${name}`;
const database = new pg.Pool({ connectionString: target.href, max: 4 });
const first = '0xbf004bff64725914ee36d03b87d6965b0ced4903', second = '0x3391a39a1b508e54a361924a26056c01c1c2c07d';
const feeOnly = '0x609f2c912175f8cd4438c1882f291fa6a4b4c735';
const partialHigh = `0x${'5'.repeat(40)}`, partialLow = `0x${'6'.repeat(40)}`, unavailable = `0x${'7'.repeat(40)}`;
const completeZero = `0x${'8'.repeat(40)}`, partialZero = `0x${'c'.repeat(40)}`;
const partialNegative = `0x${'d'.repeat(40)}`, completeNegative = `0x${'e'.repeat(40)}`, partialLoss = `0x${'f'.repeat(40)}`;
const completeTie = `0x${'12'.repeat(20)}`, partialTie = `0x${'23'.repeat(20)}`;
const extraWallets = [completeZero, partialZero, partialNegative, completeNegative, partialLoss, completeTie, partialTie];
const partialWallets = [second, partialHigh, partialLow, partialZero, partialNegative, partialLoss, partialTie, unavailable];
const profits: Record<string, string> = { [first]: '25.12345678901234567890123456789', [second]: '1000000',
  [partialHigh]: '100.00000000000000000002', [partialLow]: '100.00000000000000000001', [feeOnly]: '-0.1',
  [completeZero]: '0', [partialZero]: '0', [partialNegative]: '-0.05', [completeNegative]: '-50', [partialLoss]: '-100',
  [completeTie]: '5', [partialTie]: '5' };
const privateWallet = `0x${'9'.repeat(40)}`, token = `0x${'a'.repeat(40)}`, blockHash = `0x${'b'.repeat(64)}`;
const periodNow = Date.now()-10_000;
const bootstrap = `
  import { MockAgent,setGlobalDispatcher } from 'undici';
  const transport=new MockAgent();transport.disableNetConnect();setGlobalDispatcher(transport);
  globalThis.fetch=async()=>{throw new Error('External financial providers disabled in leaderboard integration');};
  await import(${JSON.stringify(new URL('./index.ts',import.meta.url).href)});
`;
const child = spawn(process.execPath,['--import','tsx','--input-type=module','--eval',bootstrap],{
  cwd:fileURLToPath(new URL('..',import.meta.url)),stdio:['ignore','pipe','pipe'],windowsHide:true,
  env:{...process.env,DATABASE_URL:target.href,PORT:'0',NODE_ENV:'test',TELEGRAM_BOT_TOKEN:'',TELEGRAM_WEBHOOK_SECRET:'',
    GMGN_API_KEY:'',GMGN_ACCOUNTING_API_KEY:'',GMGN_CHART_API_KEY:'',BSC_RPC_HTTP:'http://127.0.0.1:1',BSC_RPC_WS:'',NODE_HISTORICAL_IMPORTS:'0'},
});
let log='';
const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
const ready=new Promise<string>((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error(`API startup timed out: ${log}`)),30_000);
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('exit',code=>{clearTimeout(timer);reject(new Error(`API exited ${code}: ${log}`));});
  child.stdout.on('data',chunk=>{log=(log+String(chunk)).slice(-16000);const url=log.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];if(url){clearTimeout(timer);resolve(url);}});
  child.stderr.on('data',chunk=>{log=(log+String(chunk)).slice(-16000);});
});
try {
  const base=await ready;
  for (const wallet of [partialHigh, partialLow, unavailable, ...extraWallets]) await database.query('INSERT INTO kols(address,is_tracked)VALUES($1,true)',[wallet]);
  await database.query('UPDATE kols SET display_name=$1 WHERE address=ANY($2::text[])', ['Equal profit', [completeTie, partialTie]]);
  await database.query('INSERT INTO kols(address,is_tracked)VALUES($1,false)',[privateWallet]);
  await database.query(`INSERT INTO tokens(address,symbol,name,decimals,is_meme)VALUES($1,'PUBLIC','Public fixture',18,true)`,[token]);
  for(const [index,wallet]of[first,second,privateWallet].entries())await database.query(`INSERT INTO trades(id,tx_hash,wallet_address,token_address,side,token_amount,amount_usd,block_number,block_hash,transaction_index,timestamp,source)
    VALUES($1,$2,$3,$4,'buy',100,100,100,$5,$6,now()-interval '1 minute','node')`,[`period-trade-${index}`,`0x${String(index+1).repeat(64)}`,wallet,token,blockHash,index]);
  for (const [index,wallet] of [partialHigh, partialLow, partialLow, unavailable, unavailable, unavailable].entries()) await database.query(`INSERT INTO trades(id,tx_hash,wallet_address,token_address,side,token_amount,amount_usd,block_number,timestamp,source)
    VALUES($1,$2,$3,$4,'buy',100,100,100,now()-interval '1 minute','node')`,[`extra-trade-${index}`,`0x${String(index+3).repeat(64)}`,wallet,token]);
  for (const [index,wallet] of extraWallets.entries()) await database.query(`INSERT INTO trades(id,tx_hash,wallet_address,token_address,side,token_amount,amount_usd,block_number,timestamp,source)
    VALUES($1,$2,$3,$4,'buy',100,100,100,$5,'node')`,[`rank-trade-${index}`,`0x${(index+10).toString(16).padStart(64,'0')}`,wallet,token,new Date(periodNow-60_000).toISOString()]);
  await database.query(`INSERT INTO node_evidence_blocks(block_number,block_hash,parent_hash,timestamp,header)VALUES(100,$1,$2,now(),'{}')`,[blockHash,`0x${'c'.repeat(64)}`]);
  await database.query(`INSERT INTO leaderboard_snapshots(wallet_address,period,window_start,realized_profit_usd)VALUES($1,'1d',now()-interval '24 hours',888),($1,'7d',NULL,999)`,[first]);
  async function get(path:string){const response=await fetch(base+path,{signal:AbortSignal.timeout(15_000)});assert.ok(response.ok,`${path}: ${response.status} ${await response.clone().text()}`);const result=await response.json();assert.ok(!JSON.stringify(result).includes(privateWallet),`${path} leaked a private wallet`);return result;}
  const legacy=await get('/api/leaderboard');
  assert.equal(legacy.items.find((row:any)=>row.address===first).realizedProfitUsd,null,'The old window-only figure is hidden until a new versioned result exists');
  assert.equal(legacy.items.find((row:any)=>row.address===first).accounting,null);
  let releaseCalculation!:()=>void,calculationStarted!:()=>void,calls=0;
  const gate=new Promise<void>(resolve=>{releaseCalculation=resolve;}),started=new Promise<void>(resolve=>{calculationStarted=resolve;});
  const calculate=async({wallets,windowStart,windowEnd}:any):Promise<NodeLeaderboardSnapshot[]>=>{
    assert.ok(!wallets.includes(privateWallet),'The calculator receives public tracked KOLs only');
    calls++;calculationStarted();await gate;
    return wallets.map((wallet:string)=>({version:1,policy:'kollens_fifo_v1',walletAddress:wallet,windowStart,windowEnd,asOf:windowEnd,
      snapshotId:createHash('sha256').update(wallet+windowStart+windowEnd).digest('hex'),source:'node',coveredThroughBlock:'100',coveredThroughHash:blockHash,
      complete:!partialWallets.includes(wallet),reasons:partialWallets.includes(wallet)?['purchase_cost_unknown']:[],realizedProfitUsd:partialWallets.includes(wallet)?null:profits[wallet]??'0',
      knownRealizedProfitUsd:profits[wallet]??'0',
      valuedSellCount:[first,second,partialHigh,partialLow,...extraWallets].includes(wallet)?1:0,excludedSellCount:partialWallets.includes(wallet)?1:0,valuedTransferOutCount:0,excludedTransferOutCount:0,
      feeOnlyFeesUsd:wallet===feeOnly?'0.1':'0',valuedFeeCount:wallet===feeOnly?1:0,excludedFeeCount:0}));
  };
  const service=createNodeLeaderboardService({database,calculate,now:()=>periodNow});
  const refreshing=service.refresh();assert.equal(service.refresh(),refreshing,'Concurrent local refreshes share one promise');
  await started;
  const otherService=createNodeLeaderboardService({database,calculate,now:()=>periodNow});
  assert.equal((await otherService.refresh()).skipped,true,'A second worker does not duplicate in-flight accounting');
  releaseCalculation();const refreshed=await refreshing;
  assert.equal(calls,1);assert.equal(refreshed.partialWallets,partialWallets.length-1);assert.equal(refreshed.updatedWallets,legacy.items.length);
  const board=await get('/api/leaderboard');
  const rankedOrder = [second,partialHigh,partialLow,first,completeTie,partialTie,completeZero,partialZero,partialNegative,feeOnly,completeNegative,partialLoss];
  assert.deepEqual(board.items.slice(0,rankedOrder.length).map((row:any)=>row.address),rankedOrder,
    'Complete and partial results sort globally by exact positive, zero and negative P&L; equal amounts use stable name/address ties');
  assert.deepEqual((await get('/api/leaderboard')).items.map((row:any)=>row.address),board.items.map((row:any)=>row.address),
    'Repeated reads preserve deterministic ordering, including equal complete and partial amounts');
  const firstRow=board.items.find((row:any)=>row.address===first),secondRow=board.items.find((row:any)=>row.address===second);
  assert.equal(firstRow.realizedProfitUsd,'25.12345678901234567890123456789','PostgreSQL preserves exact decimal text');
  assert.equal(firstRow.updatedAt,new Date(periodNow).toISOString(),'Cached reads retain the original as-of time');
  assert.equal(secondRow.realizedProfitUsd,null);assert.equal(secondRow.knownRealizedProfitUsd,'1000000');
  assert.deepEqual(board.items.slice(0,3).map((row:any)=>row.address),[second,partialHigh,partialLow],
    'Partial P&L sorts numerically with exact decimals, ahead of unknowns, even when lower-profit wallets have more trades');
  assert.ok(board.items.findIndex((row:any)=>row.address===partialLoss)<board.items.findIndex((row:any)=>row.address===unavailable),
    'An unknown subtotal of zero stays below a known loss rather than becoming a zero-profit rank');
  await database.query(`UPDATE leaderboard_snapshots SET realized_profit_usd=NULL,
    node_accounting=jsonb_set(jsonb_set(jsonb_set(node_accounting,'{complete}','false'),'{realizedProfitUsd}','null'),'{reasons}','["period_collection_incomplete"]')
    WHERE wallet_address=$1 AND period='1d'`,[feeOnly]);
  const partiallyKnown=await get('/api/leaderboard');
  assert.ok(partiallyKnown.items.findIndex((row:any)=>row.address===second)<partiallyKnown.items.findIndex((row:any)=>row.address===feeOnly),
    'An unranked fee-only wallet with no token trades follows active partial wallets instead of benefiting from NULLS FIRST');
  assert.ok(partiallyKnown.items.findIndex((row:any)=>row.address===feeOnly)<partiallyKnown.items.findIndex((row:any)=>row.address===unavailable),
    'Known negative partial profit precedes unknown profit; unknown is never converted to zero');
  const profile=await get(`/api/kols/${first}`);
  assert.equal(profile.stats.accounting.snapshotId,firstRow.accounting.snapshotId);
  assert.equal(profile.stats.realizedProfitUsd,firstRow.realizedProfitUsd,'Profile and leaderboard consume the identical committed rollup');
  for (const wallet of [second,partialHigh,completeZero,partialZero,partialNegative,completeNegative,partialLoss]) {
    const row=partiallyKnown.items.find((item:any)=>item.address===wallet);
    const detail=await get(`/api/kols/${wallet}`);
    assert.deepEqual(detail.stats.accounting,row.accounting,
      'Profile and leaderboard retain identical frozen complete/partial, zero/loss and exact-decimal accounting evidence');
    assert.equal(detail.stats.realizedProfitUsd,row.realizedProfitUsd,'Both surfaces expose the same nullable complete result');
    assert.equal(detail.stats.knownRealizedProfitUsd,row.knownRealizedProfitUsd,'Both surfaces expose the same exact known subtotal');
  }
  // A selected wallet publishes independently of a roster sweep. Distinct
  // scopes wait for their own preparation rather than claiming another result.
  const targetCalls:string[][]=[];
  let targetNow=periodNow+1000,releaseTarget!:()=>void,targetStarted!:()=>void;
  let targetGate:Promise<void>|undefined=new Promise(resolve=>{releaseTarget=resolve;});
  const targetBegan=new Promise<void>(resolve=>{targetStarted=resolve;});
  const targeted=createNodeLeaderboardService({database,now:()=>targetNow,calculate:async request=>{
    targetCalls.push([...request.wallets]);targetStarted();await targetGate;return calculate(request);
  }});
  const savedOther=(await database.query("SELECT * FROM leaderboard_snapshots WHERE wallet_address=$1 AND period='1d'",[second])).rows[0];
  const targetRefresh=targeted.refresh({wallets:[first,first.toUpperCase(),'invalid']});
  assert.equal(targeted.refresh({wallets:[first]}),targetRefresh,'Identical normalized wallet selections join the same preparation');
  await targetBegan;
  assert.equal((await otherService.refresh({wallets:[second]})).skipped,true,
    'The PostgreSQL lease also excludes an unrelated target in another worker');
  releaseTarget();targetGate=undefined;
  assert.equal((await targetRefresh).updatedWallets,1);
  assert.deepEqual(targetCalls[0],[first]);
  assert.deepEqual((await database.query("SELECT * FROM leaderboard_snapshots WHERE wallet_address=$1 AND period='1d'",[second])).rows[0],savedOther,
    'Refreshing one wallet cannot overwrite another wallet\'s dated rollup');
  const refreshedFirst=(await get(`/api/kols/${first}`)).stats;
  assert.notEqual(refreshedFirst.accounting.snapshotId,firstRow.accounting.snapshotId);
  assert.equal(refreshedFirst.updatedAt,new Date(targetNow).toISOString(),
    'The API immediately reads a newly committed targeted result without a stale response cache');
  const preservedFirst=(await database.query("SELECT * FROM leaderboard_snapshots WHERE wallet_address=$1 AND period='1d'",[first])).rows[0];
  targetNow+=1000;
  assert.equal((await targeted.refresh({wallets:[second]})).updatedWallets,1,'A previously skipped selected wallet succeeds when retried');
  assert.deepEqual(targetCalls[1],[second]);
  assert.deepEqual((await database.query("SELECT * FROM leaderboard_snapshots WHERE wallet_address=$1 AND period='1d'",[first])).rows[0],preservedFirst,
    'Retrying the second target preserves the completed first target');
  // Repeat overlapping selected/expiry requests while an earlier calculation
  // is held. Both worker loops must make progress without racing fixed timers.
  for(let round=0;round<3;round++){
    targetNow+=1000;
    targetGate=new Promise(resolve=>{releaseTarget=resolve;});
    const phaseStarted=new Promise<void>(resolve=>{targetStarted=resolve;});
    const callOffset=targetCalls.length,activeRefresh=targeted.refresh({wallets:[first]});
    await phaseStarted;
    let waitingFinished=0;
    const waitingSelected=targeted.refresh({wallets:[second]}).then(result=>{waitingFinished++;return result;});
    const waitingPeriodic=targeted.refresh({limit:2}).then(result=>{waitingFinished++;return result;});
    await Promise.resolve();
    assert.equal(waitingFinished,0,'Distinct selected/periodic scopes remain pending instead of reporting an unrelated success');
    assert.equal(targetCalls.length,callOffset+1,'Queued scopes do not calculate concurrently with the active batch');
    releaseTarget();targetGate=undefined;
    const results=await Promise.all([activeRefresh,waitingSelected,waitingPeriodic]);
    assert.deepEqual(results.map(result=>result.updatedWallets),[1,1,2],
      'Persistent overlap lets both selected wallets and bounded rolling-expiry work finish each round');
    assert.ok(results.every(result=>!result.skipped),'Same-process scope arbitration makes progress without timer-based retries');
    assert.deepEqual(targetCalls[callOffset],[first]);
    assert.deepEqual(targetCalls[callOffset+1],[second],'Waiting scopes preserve FIFO arrival order');
    assert.equal(targetCalls[callOffset+2].length,2,'The periodic waiter performs its own bounded batch after the selected waiter');
    assert.equal(waitingFinished,2);
  }
  await database.query("UPDATE leaderboard_snapshots SET window_end=NULL WHERE wallet_address=$1 AND period='1d'",[first]);
  await database.query("UPDATE leaderboard_snapshots SET window_end=$2 WHERE wallet_address=$1 AND period='1d'",[second,new Date(periodNow-1000).toISOString()]);
  const beforeBounded=(await database.query("SELECT wallet_address,node_accounting FROM leaderboard_snapshots WHERE period='1d' ORDER BY wallet_address")).rows;
  targetNow+=1000;
  const boundedOffset=targetCalls.length;
  assert.equal((await targeted.refresh({limit:2})).updatedWallets,2);
  assert.deepEqual(targetCalls[boundedOffset],[first,second],'Bounded periodic work selects missing timestamps first, then the oldest rollup');
  const afterBounded=(await database.query("SELECT wallet_address,node_accounting FROM leaderboard_snapshots WHERE period='1d' ORDER BY wallet_address")).rows;
  assert.deepEqual(afterBounded.filter(row=>![first,second].includes(row.wallet_address)),beforeBounded.filter(row=>![first,second].includes(row.wallet_address)),
    'A bounded batch leaves every nonselected wallet unchanged');
  const lastGoodFirst=(await get('/api/leaderboard')).items.find((row:any)=>row.address===first);
  assert.equal((await get(`/api/kols/${first}`)).stats.accounting.snapshotId,lastGoodFirst.accounting.snapshotId,
    'Targeted publication remains identical across leaderboard and profile reads');
  assert.equal((await database.query("SELECT realized_profit_usd::text AS profit FROM leaderboard_snapshots WHERE wallet_address=$1 AND period='7d'",[first])).rows[0].profit,'999','Migration preserves prior snapshots without reusing them');
  await database.query('UPDATE node_evidence_blocks SET block_hash=$1 WHERE block_number=100',[`0x${'d'.repeat(64)}`]);
  await assert.rejects(service.refresh(),/node_leaderboard_canonical_evidence_changed/);
  assert.equal((await get('/api/leaderboard')).items.find((row:any)=>row.address===first).accounting.snapshotId,lastGoodFirst.accounting.snapshotId,'Failed publication does not overwrite a dated committed result');
  await rollbackNodeAccounting(database,100);
  const rolledBack=(await get('/api/leaderboard')).items.find((row:any)=>row.address===first);
  assert.equal(rolledBack.accounting,null);assert.equal(rolledBack.realizedProfitUsd,null,'Reorg cleanup removes the new rollup instead of exposing its legacy scalar');
  console.log('Node leaderboard PostgreSQL/API integration passed: public isolation, legacy version gate, targeted and bounded refreshes, normalized coalescing, persistent FIFO scope fairness, cross-worker exclusion/retry, exact decimals, partial ranking, identical profile rollup, uncached committed reads, original as-of and reorg rejection.');
} finally {
  child.kill();await exited;await database.end();
  if(!/^node_leaderboard_test_[a-f0-9]{32}$/.test(name))throw new Error('Invalid disposable database name');
  await admin.query(`DROP DATABASE "${name}" WITH(FORCE)`);await admin.end();
}
