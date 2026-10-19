import assert from 'node:assert/strict';
import pg from 'pg';
import { nodeMarketDiscoverySql, nodeMarketReceiptHintsSql } from './nodeMarketDiscovery.js';
import { publicTokenEvidenceSql } from './nodeMarketReadSql.js';
const connection=new URL(process.env.DATABASE_URL||'');
if(!['localhost','127.0.0.1'].includes(connection.hostname)||connection.port!=='5435'||!/^\/bscan_node_market_discovery_test_\d+$/.test(connection.pathname))
  throw new Error('Use an explicitly disposable local bscan_node_market_discovery_test_<timestamp> database');
const db=new pg.Pool({connectionString:connection.href});
const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
try {
  await db.query(`CREATE TABLE tokens(address text PRIMARY KEY,symbol text,name text);
    CREATE TABLE published_kols(address text PRIMARY KEY,is_tracked boolean);
    CREATE TABLE trades(wallet_address text,token_address text,block_number bigint,timestamp timestamptz);
    CREATE TABLE node_market_discoveries(token_address text PRIMARY KEY,last_attempt_at timestamptz);
    CREATE TABLE node_market_refresh_jobs(token_address text PRIMARY KEY,expires_at timestamptz);
    CREATE TABLE node_accounting_jobs(token_address text,priority integer);
    CREATE TABLE node_monitored_wallets(wallet_address text PRIMARY KEY,active boolean);
    CREATE TABLE node_executions(id text PRIMARY KEY,wallet_address text,timestamp timestamptz);
    CREATE TABLE node_execution_flows(execution_id text,token_address text);
    CREATE TABLE node_evidence_blocks(block_number bigint,block_hash text,timestamp timestamptz);
    CREATE TABLE node_accounting_baselines(wallet_address text,token_address text,checkpoint_block bigint,
      checkpoint_hash text,checkpoint_timestamp timestamptz,schema_version integer,invalidated_at timestamptz,events jsonb);`);
  const publicWallet=address(700),privateWallet=address(701),inactiveWallet=address(702),privateToken=address(9999),inactiveToken=address(10000),metadataOnly=address(10001);
  await db.query('INSERT INTO published_kols VALUES($1,true)',[publicWallet]);
  await db.query('INSERT INTO node_monitored_wallets VALUES($1,true),($2,false)',[privateWallet,inactiveWallet]);
  for(let n=1;n<=4;n++) {
    await db.query("INSERT INTO tokens VALUES($1,'OLD','Old historical token')",[address(n)]);
    await db.query("INSERT INTO trades VALUES($1,$2,100,now()-interval '30 days')",[publicWallet,address(n)]);
  }
  for(let n=1;n<=9;n++) {
    await db.query("INSERT INTO tokens VALUES($1,'NEW','Recently traded token')",[address(9000+n)]);
    await db.query("INSERT INTO trades VALUES($1,$2,100,now()-$3::int*interval '1 minute')",[publicWallet,address(9000+n),n]);
  }
  for(const [wallet,token] of [[privateWallet,privateToken],[inactiveWallet,inactiveToken]]) {
    await db.query("INSERT INTO tokens VALUES($1,'PRIVATE','Private-only asset')",[token]);
    await db.query('INSERT INTO node_executions VALUES($1,$2,now())',[token,wallet]);
    await db.query('INSERT INTO node_execution_flows VALUES($1,$1)',[token]);
  }
  await db.query("INSERT INTO tokens VALUES($1,'META','Metadata without monitored activity')",[metadataOnly]);
  const excluded='0x000ae314e2a2172a039b26378814c252734f556a';
  await db.query("INSERT INTO tokens VALUES($1,'ASTER','Excluded reward asset')",[excluded]);
  await db.query('INSERT INTO trades VALUES($1,$2,100,now())',[publicWallet,excluded]);
  await db.query("INSERT INTO node_market_refresh_jobs VALUES($1,now()+interval '1 minute'),($2,now()+interval '1 minute')",[address(1),excluded]);
  await db.query('INSERT INTO node_accounting_jobs VALUES($1,10)',[address(2)]);
  const selected=(await db.query(nodeMarketDiscoverySql())).rows.map(row=>row.address);
  assert.equal(selected.length,8,'The scheduler retains the existing request budget');
  assert.deepEqual(selected.slice(0,2),[address(1),address(2)],'Foreground chart then accounting work beats recent background discovery');
  assert.deepEqual(selected.slice(2,7),[privateToken,...[1,2,3,4].map(n=>address(9000+n))],'Recent active private and public activity beats the alphabetical historical crawl');
  assert.equal(selected[7],address(3),'Older history retains one fair slot instead of starving behind recent activity');
  assert.ok(!selected.includes(excluded)&&!selected.includes(inactiveToken)&&!selected.includes(metadataOnly));
  assert.equal((await db.query(`SELECT v.address FROM tokens v WHERE v.address=$1 AND ${publicTokenEvidenceSql()}`,[privateToken])).rowCount,0,'Worker-only private eligibility never grants public token visibility');
  await db.query('DELETE FROM node_market_refresh_jobs; DELETE FROM node_accounting_jobs');
  for(const token of selected)await db.query('INSERT INTO node_market_discoveries VALUES($1,now()) ON CONFLICT DO NOTHING',[token]);
  const next=(await db.query(nodeMarketDiscoverySql())).rows.map(row=>row.address);
  assert.deepEqual(next.slice(0,5),[5,6,7,8,9].map(n=>address(9000+n)),'Completed recent attempts rotate to the remaining recent tokens');
  assert.ok(next.includes(address(4)),'Unvisited old tokens continue rotating');
  await db.query(`ALTER TABLE node_executions ADD COLUMN tx_hash text,ADD COLUMN block_number bigint,ADD COLUMN block_hash text,ADD COLUMN transaction_index integer;
    CREATE TABLE node_evidence_transactions(tx_hash text PRIMARY KEY,block_number bigint,block_hash text,transaction_index integer,receipt jsonb);
    CREATE TABLE node_evidence_wallets(tx_hash text,wallet_address text);`);
  const hintToken=address(9001),unrelatedToken=address(9002),confirmed=10_000;
  async function receipt(height:number,token:string,logs:number,canonical=true) {
    const tx=`tx-${height}`,hash=`hash-${height}`;
    await db.query('INSERT INTO node_evidence_blocks VALUES($1,$2,now())',[height,canonical?hash:'different-fork']);
    await db.query('INSERT INTO node_evidence_transactions VALUES($1,$2,$3,0,$4::jsonb)',[tx,height,hash,JSON.stringify({logs:Array.from({length:logs},(_,index)=>({marker:`${height}:${index}`}))})]);
    // Repeated operations and several monitored wallet participants must not
    // spend the three-receipt budget on duplicate copies of one transaction.
    for(let operation=0;operation<2;operation++) {
      const id=`${tx}-operation-${operation}`;
      await db.query('INSERT INTO node_executions(id,wallet_address,timestamp,tx_hash,block_number,block_hash,transaction_index) VALUES($1,$2,now(),$3,$4,$5,0)',[id,privateWallet,tx,height,hash]);
      await db.query('INSERT INTO node_execution_flows VALUES($1,$2)',[id,token]);
      await db.query('INSERT INTO node_evidence_wallets VALUES($1,$2)',[tx,address(800+operation)]);
    }
  }
  for(const height of [10,20,30,40])await receipt(height,hintToken,80);
  await receipt(50,hintToken,2);
  await receipt(60,hintToken,1,false);
  await receipt(9999,unrelatedToken,1);
  await receipt(confirmed+1,hintToken,1);
  const hints=(await db.query(nodeMarketReceiptHintsSql(),[hintToken,confirmed])).rows.map(row=>row.log.marker as string);
  assert.equal(hints.length,150,'The expanded log budget remains bounded');
  assert.deepEqual(hints.slice(0,3),['50:0','50:1','40:0']);
  assert.equal(new Set(hints).size,150,'Shared-wallet and repeated-operation rows never duplicate a receipt');
  assert.ok(hints.includes('30:0'),'A permanently retained old pool log remains usable despite being more than 2000 blocks old');
  assert.ok(hints.every(marker=>['30','40','50'].includes(marker.split(':')[0])),'Only the latest three canonical token receipts at the confirmed checkpoint contribute');
  assert.deepEqual((await db.query(nodeMarketReceiptHintsSql(),[unrelatedToken,confirmed])).rows.map(row=>row.log.marker),['9999:0']);
  assert.equal((await db.query(nodeMarketReceiptHintsSql(),[address(123456),confirmed])).rowCount,0);
  console.log('Node market discovery priority and retained receipt-hint integration passed');
} finally { await db.end(); }
