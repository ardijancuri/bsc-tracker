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
const partialWallets = [second, partialHigh, partialLow, unavailable];
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
  for (const wallet of [partialHigh, partialLow, unavailable]) await database.query('INSERT INTO kols(address,is_tracked)VALUES($1,true)',[wallet]);
  await database.query('INSERT INTO kols(address,is_tracked)VALUES($1,false)',[privateWallet]);
  await database.query(`INSERT INTO tokens(address,symbol,name,decimals,is_meme)VALUES($1,'PUBLIC','Public fixture',18,true)`,[token]);
  for(const [index,wallet]of[first,second,privateWallet].entries())await database.query(`INSERT INTO trades(id,tx_hash,wallet_address,token_address,side,token_amount,amount_usd,block_number,block_hash,transaction_index,timestamp,source)
    VALUES($1,$2,$3,$4,'buy',100,100,100,$5,$6,now()-interval '1 minute','node')`,[`period-trade-${index}`,`0x${String(index+1).repeat(64)}`,wallet,token,blockHash,index]);
  for (const [index,wallet] of [partialHigh, partialLow, partialLow, unavailable, unavailable, unavailable].entries()) await database.query(`INSERT INTO trades(id,tx_hash,wallet_address,token_address,side,token_amount,amount_usd,block_number,timestamp,source)
    VALUES($1,$2,$3,$4,'buy',100,100,100,now()-interval '1 minute','node')`,[`extra-trade-${index}`,`0x${String(index+3).repeat(64)}`,wallet,token]);
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
      complete:!partialWallets.includes(wallet),reasons:partialWallets.includes(wallet)?['purchase_cost_unknown']:[],realizedProfitUsd:partialWallets.includes(wallet)?null:wallet===first?'25.12345678901234567890123456789':wallet===feeOnly?'-0.1':'0',
      knownRealizedProfitUsd:wallet===second?'1000000':wallet===partialHigh?'100.00000000000000000002':wallet===partialLow?'100.00000000000000000001':wallet===first?'25.12345678901234567890123456789':wallet===feeOnly?'-0.1':'0',
      valuedSellCount:[first,second,partialHigh,partialLow].includes(wallet)?1:0,excludedSellCount:partialWallets.includes(wallet)?1:0,valuedTransferOutCount:0,excludedTransferOutCount:0,
      feeOnlyFeesUsd:wallet===feeOnly?'0.1':'0',valuedFeeCount:wallet===feeOnly?1:0,excludedFeeCount:0}));
  };
  const service=createNodeLeaderboardService({database,calculate,now:()=>periodNow});
  const refreshing=service.refresh();assert.equal(service.refresh(),refreshing,'Concurrent local refreshes share one promise');
  await started;
  const otherService=createNodeLeaderboardService({database,calculate,now:()=>periodNow});
  assert.equal((await otherService.refresh()).skipped,true,'A second worker does not duplicate in-flight accounting');
  releaseCalculation();const refreshed=await refreshing;
  assert.equal(calls,1);assert.equal(refreshed.partialWallets,3);assert.equal(refreshed.updatedWallets,legacy.items.length);
  const board=await get('/api/leaderboard');
  assert.equal(board.items[0].address,first,'A large partial subtotal never outranks a complete active wallet');
  assert.equal(board.items[1].address,feeOnly,'A complete wallet-paid fee realization is ranked even without token trades');
  assert.equal(board.items[2].address,second,'Active partial coverage appears before inactive zero-activity wallets');
  const firstRow=board.items[0],secondRow=board.items[2];
  assert.equal(firstRow.realizedProfitUsd,'25.12345678901234567890123456789','PostgreSQL preserves exact decimal text');
  assert.equal(firstRow.updatedAt,new Date(periodNow).toISOString(),'Cached reads retain the original as-of time');
  assert.equal(secondRow.realizedProfitUsd,null);assert.equal(secondRow.knownRealizedProfitUsd,'1000000');
  assert.deepEqual(board.items.slice(2,5).map((row:any)=>row.address),[second,partialHigh,partialLow],
    'Partial P&L sorts numerically with exact decimals, ahead of unknowns, even when lower-profit wallets have more trades');
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
  assert.equal((await database.query("SELECT realized_profit_usd::text AS profit FROM leaderboard_snapshots WHERE wallet_address=$1 AND period='7d'",[first])).rows[0].profit,'999','Migration preserves prior snapshots without reusing them');
  await database.query('UPDATE node_evidence_blocks SET block_hash=$1 WHERE block_number=100',[`0x${'d'.repeat(64)}`]);
  await assert.rejects(service.refresh(),/node_leaderboard_canonical_evidence_changed/);
  assert.equal((await get('/api/leaderboard')).items.find((row:any)=>row.address===first).accounting.snapshotId,firstRow.accounting.snapshotId,'Failed publication does not overwrite a dated committed result');
  await rollbackNodeAccounting(database,100);
  const rolledBack=(await get('/api/leaderboard')).items.find((row:any)=>row.address===first);
  assert.equal(rolledBack.accounting,null);assert.equal(rolledBack.realizedProfitUsd,null,'Reorg cleanup removes the new rollup instead of exposing its legacy scalar');
  console.log('Node leaderboard PostgreSQL/API integration passed: public isolation, legacy version gate, shared refresh, cross-worker coalescing, exact decimals, partial ranking, identical profile rollup, original as-of and reorg rejection.');
} finally {
  child.kill();await exited;await database.end();
  if(!/^node_leaderboard_test_[a-f0-9]{32}$/.test(name))throw new Error('Invalid disposable database name');
  await admin.query(`DROP DATABASE "${name}" WITH(FORCE)`);await admin.end();
}
