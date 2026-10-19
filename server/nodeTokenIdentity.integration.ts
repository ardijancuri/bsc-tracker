import assert from'node:assert/strict';
import{randomUUID}from'node:crypto';
import pg from'pg';
import{AbiCoder,encodeBytes32String}from'ethers';
import{createNodeTokenIdentityService,enqueueNodeTokenIdentities,ensureNodeTokenIdentitySchema,rollbackNodeTokenIdentities}from'./nodeTokenIdentity.js';
const configured=new URL(process.env.DATABASE_URL??'postgres://invalid');
if(!['localhost','127.0.0.1'].includes(configured.hostname)||configured.port!=='5435')throw Error('Disposable local PostgreSQL only');
const admin=new pg.Client({connectionString:configured.href});await admin.connect();
const name=`node_identity_test_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE DATABASE "${name}"`);
const url=new URL(configured);url.pathname=`/${name}`;const database=new pg.Pool({connectionString:url.href,max:8});
const token=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`,hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`,
  timestamp=new Date().toISOString(),abi=AbiCoder.defaultAbiCoder(),str=(value:string)=>abi.encode(['string'],[value]);
const scopes=(tokens:string[],blockNumber=100)=>tokens.map(tokenAddress=>({tokenAddress,blockNumber,blockHash:hash(blockNumber),timestamp}));
let nameReady=false,deleteLate=false;const calls:{token:string;selector:string;hash:string}[]=[];
const rpc=async<T>(_method:string,params:unknown[]):Promise<T>=>{
  const request=params[0]as{to:string;data:string},checkpoint=params[1]as{blockHash:string;requireCanonical:boolean};
  assert.equal(checkpoint.requireCanonical,true);calls.push({token:request.to,selector:request.data,hash:checkpoint.blockHash});
  if(request.to===token(3)&&deleteLate){await database.query('DELETE FROM node_evidence_blocks WHERE block_number=102');return str('Orphan')as T;}
  if(request.to===token(1)){
    if(request.data!=='0x95d89b41'&&!nameReady)throw Error('Name temporarily unavailable');
    return(request.data==='0x95d89b41'?str('NODE'):encodeBytes32String('Node Name'))as T;
  }
  if(request.to===token(4))return(request.data==='0x95d89b41'?'0x':str('Name Only'))as T;
  return(request.data==='0x95d89b41'?encodeBytes32String('TWO'):str('中文名字'))as T;
};
try{
  await database.query(`CREATE TABLE tokens(address text PRIMARY KEY,symbol text,name text,decimals integer);
    CREATE TABLE node_evidence_blocks(block_number bigint PRIMARY KEY,block_hash text UNIQUE NOT NULL,timestamp timestamptz NOT NULL);
    CREATE TABLE worker_state(key text PRIMARY KEY,value jsonb);
    CREATE TABLE creator_profiles(display_name text);CREATE TABLE journal_wallets(private_label text);
    INSERT INTO creator_profiles VALUES('Claimed KOL');INSERT INTO journal_wallets VALUES('Private Wallet');`);
  await ensureNodeTokenIdentitySchema(database);
  await database.query('INSERT INTO node_evidence_blocks VALUES(100,$1,$2),(101,$3,$2)',[hash(100),timestamp,hash(101)]);
  await database.query(`INSERT INTO worker_state VALUES('node_collection','{"blockNumber":100}')`);
  await database.query(`INSERT INTO tokens VALUES($1,'LEGACY','Provider Name',9),($2,NULL,NULL,NULL),($3,NULL,NULL,NULL),($4,NULL,NULL,NULL)`,[token(1),token(2),token(3),token(4)]);
  await enqueueNodeTokenIdentities(database,[...scopes([token(1),token(2)]),...scopes([token(1)])]);
  assert.equal((await database.query('SELECT count(*)::int n FROM node_token_identity_jobs')).rows[0].n,2);
  const service=createNodeTokenIdentityService({database,rpc});
  const first=await service.drain({limit:2});assert.deepEqual(first,{claimed:2,complete:1,partial:1});
  assert.deepEqual((await database.query('SELECT symbol,name,decimals FROM tokens WHERE address=$1',[token(1)])).rows[0],{symbol:'NODE',name:'Provider Name',decimals:9},
    'Node identity supersedes the provider label without guessing or changing financial precision');
  assert.deepEqual((await database.query('SELECT symbol,name,decimals FROM tokens WHERE address=$1',[token(2)])).rows[0],{symbol:'TWO',name:'中文名字',decimals:null});
  const partial=(await database.query('SELECT * FROM node_token_identity_jobs WHERE token_address=$1',[token(1)])).rows[0];
  assert.equal(partial.completed_at,null);assert.equal(partial.last_error,'token_name_unavailable');
  assert.ok(partial.next_attempt_at>Date.now());
  nameReady=true;await database.query('UPDATE node_token_identity_jobs SET next_attempt_at=now() WHERE token_address=$1',[token(1)]);
  const restarted=createNodeTokenIdentityService({database,rpc});assert.equal((await restarted.drain({limit:1})).complete,1);
  assert.equal((await database.query('SELECT name FROM tokens WHERE address=$1',[token(1)])).rows[0].name,'Node Name');
  await enqueueNodeTokenIdentities(database,scopes([token(1)],101));
  assert.equal((await restarted.drain({limit:1})).claimed,0,'Frequent swaps do not refetch complete names at every block');
  await restarted.queueMissing({limit:1,priorityTokens:[token(4)]});
  const nameOnly=await restarted.drain({limit:1});assert.equal(nameOnly.partial,1);
  assert.equal((await database.query('SELECT name FROM tokens WHERE address=$1',[token(4)])).rows[0].name,'Name Only');
  assert.equal((await database.query('SELECT symbol FROM tokens WHERE address=$1',[token(4)])).rows[0].symbol,null);
  await enqueueNodeTokenIdentities(database,scopes([token(5),token(6)]));
  const concurrent=await Promise.all([restarted.drain({limit:1}),restarted.drain({limit:1})]);
  assert.equal(concurrent.reduce((sum,result)=>sum+result.complete,0),2,'Concurrent identity workers lease different tokens');
  assert.equal((await database.query('SELECT count(*)::int n FROM node_token_identity_evidence WHERE token_address=ANY($1::text[])',[[token(5),token(6)]])).rows[0].n,2);
  await database.query('INSERT INTO node_evidence_blocks VALUES(102,$1,$2)',[hash(102),timestamp]);
  await database.query(`UPDATE worker_state SET value='{"blockNumber":102}' WHERE key='node_collection'`);
  await enqueueNodeTokenIdentities(database,scopes([token(3)],102));deleteLate=true;
  const orphan=await restarted.drain({limit:1});assert.equal(orphan.partial,1);
  assert.equal((await database.query('SELECT name FROM tokens WHERE address=$1',[token(3)])).rows[0].name,null);
  assert.equal((await database.query('SELECT count(*)::int n FROM node_token_identity_evidence WHERE token_address=$1',[token(3)])).rows[0].n,0,
    'A late RPC response cannot publish after its canonical block is removed');
  await rollbackNodeTokenIdentities(database,100);
  assert.deepEqual((await database.query('SELECT symbol,name FROM tokens WHERE address=$1',[token(1)])).rows[0],{symbol:'LEGACY',name:'Provider Name'});
  assert.equal((await database.query('SELECT name FROM tokens WHERE address=$1',[token(2)])).rows[0].name,null);
  assert.equal((await database.query('SELECT display_name FROM creator_profiles')).rows[0].display_name,'Claimed KOL');
  assert.equal((await database.query('SELECT private_label FROM journal_wallets')).rows[0].private_label,'Private Wallet');
  // A high-address live token must not wait behind an old alphabetical backlog.
  for(const index of[10,20,30])await database.query('INSERT INTO tokens(address) VALUES($1)',[token(index)]);
  let clock=100_000;const prioritized=createNodeTokenIdentityService({database,rpc,now:()=>clock});
  await prioritized.queueMissing({limit:2,priorityTokens:[token(30)],recentTokens:[token(20)]});
  assert.deepEqual((await database.query('SELECT token_address,priority FROM node_token_identity_jobs WHERE token_address=ANY($1::text[]) ORDER BY priority DESC',[[token(10),token(20),token(30)]])).rows,
    [{token_address:token(30),priority:100},{token_address:token(20),priority:50}],
    'Selected and latest public trade identities enqueue before lower-address unreferenced tokens');
  await prioritized.queueMissing({limit:1});
  assert.ok((await database.query('SELECT 1 FROM node_token_identity_jobs WHERE token_address=$1',[token(10)])).rows.length);
  await database.query('INSERT INTO tokens(address) VALUES($1)',[token(9)]);
  assert.equal(await prioritized.queueMissing({limit:1}),0,'Repeated polling does not rescan the old token backlog every second');
  clock+=30_001;assert.equal(await prioritized.queueMissing({limit:1}),1);
  await database.query('INSERT INTO tokens(address) VALUES($1)',[token(40)]);
  await enqueueNodeTokenIdentities(database,scopes([token(40)]));
  await database.query("UPDATE node_token_identity_jobs SET next_attempt_at=now()+interval '1 hour' WHERE token_address=$1",[token(40)]);
  await prioritized.queueMissing({limit:1,recentTokens:[token(40)]});
  const promoted=(await database.query('SELECT priority,next_attempt_at<=now() ready FROM node_token_identity_jobs WHERE token_address=$1',[token(40)])).rows[0];
  assert.deepEqual(promoted,{priority:50,ready:true},'An already queued live token is promoted ahead of old backfill without losing its durable job');
  await database.query(`CREATE TABLE published_kols(address text PRIMARY KEY,is_tracked boolean NOT NULL);
    CREATE TABLE trades(id text PRIMARY KEY,wallet_address text NOT NULL,token_address text NOT NULL,timestamp timestamptz NOT NULL,block_number bigint);
    CREATE INDEX trades_recent_idx ON trades(timestamp DESC,id DESC);
    CREATE INDEX trades_token_idx ON trades(token_address,timestamp DESC);`);
  const publicWallet=token(1000),privateWallet=token(1001),untrackedWallet=token(1002);
  await database.query('INSERT INTO published_kols VALUES($1,true),($2,false)',[publicWallet,untrackedWallet]);
  for(const index of[70,80,81,82,83,84,85,86,88,90])await database.query('INSERT INTO tokens(address) VALUES($1)',[token(index)]);
  await database.query("UPDATE tokens SET symbol='BURST',name='Burst' WHERE address=$1",[token(70)]);
  await database.query("UPDATE tokens SET symbol='PARTIAL' WHERE address=$1",[token(81)]);
  await database.query("UPDATE tokens SET symbol='UNKNOWN',name='Unknown' WHERE address=$1",[token(82)]);
  await database.query("UPDATE tokens SET symbol='USDT' WHERE address=$1",[token(88)]);
  await database.query('INSERT INTO node_token_identity_jobs(token_address,priority,completed_at) VALUES($1,50,now())',[token(70)]);
  await database.query("INSERT INTO node_token_identity_jobs(token_address,priority,last_seen_block,next_attempt_at) VALUES($1,0,100,now()+interval '1 hour')",[token(80)]);
  await database.query(`INSERT INTO trades SELECT 'burst-'||n,$1,$2,now()-interval '10 minutes'+n*interval '1 millisecond',100
    FROM generate_series(1,600)n`,[publicWallet,token(70)]);
  for(const[index,wallet,age,block]of[[80,publicWallet,'20 minutes',100],[81,publicWallet,'21 minutes',100],
    [82,publicWallet,'22 minutes',100],[83,privateWallet,'1 minute',100],[84,publicWallet,'25 hours',100],
    [85,publicWallet,'1 minute',null],[86,untrackedWallet,'1 minute',100],[88,publicWallet,'25 hours',100]]as const){
    await database.query('INSERT INTO trades VALUES($1,$2,$3,now()-$4::interval,$5::bigint)',[`older-${index}`,wallet,token(index),age,block]);
  }
  assert.deepEqual([...new Set((await database.query('SELECT token_address FROM trades WHERE wallet_address=$1 AND block_number IS NOT NULL ORDER BY timestamp DESC LIMIT 512',[publicWallet])).rows
    .map(row=>row.token_address))],[token(70)],'The original recent-row input cannot see the older eligible identity behind a burst');
  await database.query("UPDATE trades SET timestamp=now()-interval '1 minute' WHERE id='older-88'");
  let feedClock=200_000;const feedIdentity=createNodeTokenIdentityService({database,rpc,now:()=>feedClock}),callsBeforeFeed=calls.length;
  await feedIdentity.queueMissing({limit:5,priorityTokens:[token(90)],recentTokens:[token(70)]});
  assert.deepEqual((await database.query('SELECT token_address,priority FROM node_token_identity_jobs WHERE token_address=ANY($1::text[]) ORDER BY priority DESC,token_address',
    [[token(80),token(81),token(82),token(88),token(90)]])).rows,[{token_address:token(90),priority:100},...([80,81,82,88].map(index=>({token_address:token(index),priority:50})))],
    'Older public feed identities, partial names, placeholders and visible quote assets get recent priority without displacing a selected token');
  assert.deepEqual((await database.query('SELECT last_seen_block::text,next_attempt_at<=now() ready FROM node_token_identity_jobs WHERE token_address=$1',[token(80)])).rows[0],
    {last_seen_block:'100',ready:true},'Public discovery promotes an existing durable backfill job without losing its block');
  assert.equal((await database.query('SELECT count(*)::int n FROM node_token_identity_jobs WHERE token_address=ANY($1::text[]) AND priority=50',
    [[token(83),token(84),token(85),token(86)]])).rows[0].n,0,'Private, expired, unconfirmed and untracked activity never enters public-feed priority');
  assert.equal((await database.query('SELECT name FROM tokens WHERE address=$1',[token(81)])).rows[0].name,null,'Queuing never fabricates a full name from its symbol');
  await database.query('INSERT INTO tokens(address) VALUES($1)',[token(87)]);
  await database.query("INSERT INTO trades VALUES('late-visible',$1,$2,now()-interval '23 minutes',100)",[publicWallet,token(87)]);
  await feedIdentity.queueMissing({limit:1});
  assert.notEqual((await database.query('SELECT priority FROM node_token_identity_jobs WHERE token_address=$1',[token(87)])).rows[0]?.priority,50,
    'Public discovery does not rerun its 24-hour indexed scan on each poll');
  feedClock+=30_001;await feedIdentity.queueMissing({limit:1});
  assert.equal((await database.query('SELECT priority FROM node_token_identity_jobs WHERE token_address=$1',[token(87)])).rows[0].priority,50);
  assert.equal(calls.length,callsBeforeFeed,'Public feed discovery is database-only and never adds request-time RPC');
  assert.ok(calls.every(call=>validCapturedHash(call.hash)));
  console.log('Node identity PostgreSQL regression passed: durable coalescing, optional partial names, canonical provenance, restart retry, node publication, unchanged precision/private labels and reorg recovery');
}finally{await database.end();await admin.query(`DROP DATABASE "${name}" WITH(FORCE)`);await admin.end();}
function validCapturedHash(value:string){return[hash(100),hash(102)].includes(value);}
