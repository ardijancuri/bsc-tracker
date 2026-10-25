/** Real uniqueness/lease/reorg SQL, with every fixture row rolled back. */
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { Rpc } from '../rpc.js';
import type { FreshBlock,FreshReceipt,FreshLog } from './capture.js';
import {FRESH_UNISWAP_V4_BSC_MANAGER as manager,freshStockwavePoolId,stockwavePoolManagerInterface}from'./stockwaveMarket.js';
import {collectFreshV4DiscoveryPage,commitFreshV4DiscoveryPage,freshV4DiscoveryProgress,readFreshV4MarketIdentities}from'./v4Discovery.js';
const url=new URL(process.env.DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='5436'||!url.pathname.includes('fresh'))throw Error('Isolated local fresh database required');
const db=new Pool({connectionString:url.toString(),max:1}),client=await db.connect();
const addr=()=>`0x${randomBytes(20).toString('hex')}`,hash=()=>`0x${randomBytes(32).toString('hex')}`;
const token=addr(),quote=addr(),wallet=addr(),txHash=hash(),now=new Date(),lease=randomUUID(),job={id:`market_discovery:${token}`,reference:token,lease_id:lease};
try{
 await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(73621941)');
 const creation=Number((await client.query("SELECT block_number FROM fresh.checkpoints WHERE key='capture'")).rows[0].block_number)+100,initial=creation+1,end=creation+2;
 const hashes=new Map([[creation,hash()],[initial,hash()],[end,hash()]]),currencies=[token,quote].sort();
 await client.query('INSERT INTO fresh.tokens(address,launch_status) VALUES($1,\'eligible\')',[token]);
 for(const number of[creation,initial,end])await client.query('INSERT INTO fresh.recent_blocks(block_number,block_hash,parent_hash,occurred_at) VALUES($1,$2,$3,$4)',[number,hashes.get(number),hash(),now]);
 await client.query("INSERT INTO fresh.launch_facts(token_address,protocol,block_number,block_hash,tx_hash,launched_at,proof,status) VALUES($1,'evm_creation',$2,$3,$4,$5,'{}','eligible')",[token,creation,hashes.get(creation),hash(),now]);
 const fact=(await client.query('SELECT to_jsonb(lf) AS fact FROM fresh.launch_facts lf WHERE token_address=$1',[token])).rows[0].fact;
 await client.query('CREATE TEMP TABLE fresh_v4_test_capture(LIKE fresh.checkpoints INCLUDING DEFAULTS) ON COMMIT DROP');
 await client.query("INSERT INTO fresh_v4_test_capture(key,block_number,block_hash,revision,value) VALUES('capture',$1,$2,991,$3::jsonb)",[end,hashes.get(end),JSON.stringify({startBlock:creation-1,startHash:hash()})]);
 const capture={block_number:end,revision:'991'},progress=freshV4DiscoveryProgress(fact,capture,{},null);
 await client.query("INSERT INTO fresh.jobs(id,kind,reference,state,lease_id,lease_until,progress) VALUES($1,'market_discovery',$2,'pending',$3,$4,$5::jsonb)",[job.id,token,lease,new Date(now.getTime()+60_000),JSON.stringify(progress)]);
 const numberHex=`0x${initial.toString(16)}`,logs:FreshLog[]=[0,3000].map((fee,index)=>{
   const key={currency0:currencies[0],currency1:currencies[1],fee,tickSpacing:200,hooks:addr()};
   return{address:manager,...stockwavePoolManagerInterface.encodeEventLog('Initialize',[freshStockwavePoolId(key),key.currency0,key.currency1,fee,200,key.hooks,1n<<96n,0]),
    blockHash:hashes.get(initial)!,blockNumber:numberHex,transactionHash:txHash,transactionIndex:'0x0',logIndex:`0x${index.toString(16)}`};
 });
 const block:FreshBlock={number:numberHex,hash:hashes.get(initial)!,parentHash:hashes.get(creation)!,timestamp:`0x${Math.floor(now.getTime()/1000).toString(16)}`,
  transactions:[{hash:txHash,from:wallet,to:manager,value:'0x0',gasPrice:'0x1',blockHash:hashes.get(initial)!,blockNumber:numberHex,transactionIndex:'0x0'}]};
 const receipt:FreshReceipt={transactionHash:txHash,transactionIndex:'0x0',blockHash:block.hash,blockNumber:numberHex,status:'0x1',gasUsed:'0x5208',effectiveGasPrice:'0x1',logs};
 const rpc:Rpc=async<T>(method:string,params:unknown[]):Promise<T>=>{
  if(method==='eth_getLogs'){const topics=(params[0]as any).topics;return(topics[currencies[0]===token?2:3]?logs:[])as T;}
  if(method==='eth_getTransactionReceipt')return receipt as T;
  if(method==='eth_getBlockByNumber'){const number=Number(BigInt(params[0]as string));return(number===initial?block:{...block,number:`0x${number.toString(16)}`,hash:hashes.get(number),parentHash:hashes.get(number-1),transactions:[]})as T;}
  throw Error('unexpected_fixture_rpc');
 };
 const page=await collectFreshV4DiscoveryPage({rpc,token,fromBlock:creation,toBlock:end,canonicalHash:async(n)=>hashes.get(n)??null});
 const mutations:string[]=[];
 const wrapped={query:(sql:string,params?:unknown[])=>{mutations.push(sql);return client.query(sql.replaceAll('fresh.checkpoints','fresh_v4_test_capture'),params);}}as typeof client;
 const first=await commitFreshV4DiscoveryPage(wrapped,job,fact,progress,page,now);assert.equal(first.markets,2);
 let markets=(await client.query('SELECT * FROM fresh.markets WHERE token_address=$1 ORDER BY id',[token])).rows;
 assert.equal(markets.length,2);assert.ok(markets.every(row=>row.address===null&&row.identity.manager===manager));
 const ready=markets[0],readyIdentity={...ready.identity,market:ready.identity,currentConversion:{proof:'retained'}},readyState={reserve:'123'};
 await client.query("UPDATE fresh.markets SET identity=$2::jsonb,state=$3::jsonb,status='ready',observed_block=$4,observed_hash=$5,observed_at=$6 WHERE id=$1",[ready.id,JSON.stringify(readyIdentity),JSON.stringify(readyState),end,hashes.get(end),now]);
 const lease2=randomUUID();await client.query('UPDATE fresh.jobs SET lease_id=$2,lease_until=$3,progress=$4::jsonb WHERE id=$1',[job.id,lease2,new Date(now.getTime()+60_000),JSON.stringify(progress)]);
 await assert.rejects(commitFreshV4DiscoveryPage(wrapped,job,fact,progress,page,now),/v4_discovery_lease_changed/);
 const duplicate=await commitFreshV4DiscoveryPage(wrapped,{...job,lease_id:lease2},fact,progress,page,now);assert.equal(duplicate.markets,0);
 const preserved=(await client.query('SELECT * FROM fresh.markets WHERE id=$1',[ready.id])).rows[0];
 assert.equal(preserved.status,'ready');assert.deepEqual(preserved.identity,readyIdentity);assert.deepEqual(preserved.state,readyState);assert.equal(preserved.observed_hash,hashes.get(end));
 assert.equal((await readFreshV4MarketIdentities(client as any,[token])).get(token)!.length,2);
 const lease3=randomUUID();await client.query('UPDATE fresh.jobs SET lease_id=$2,lease_until=$3 WHERE id=$1',[job.id,lease3,new Date(now.getTime()+60_000)]);
 await client.query("UPDATE fresh_v4_test_capture SET revision=992 WHERE key='capture'");
 await assert.rejects(commitFreshV4DiscoveryPage(wrapped,{...job,lease_id:lease3},fact,progress,page,now),/v4_discovery_context_changed/);
 await client.query("UPDATE fresh_v4_test_capture SET revision=991 WHERE key='capture'");
 const orphanedHash=hash();await client.query('UPDATE fresh.recent_blocks SET block_hash=$2 WHERE block_number=$1',[initial,orphanedHash]);
 await assert.rejects(commitFreshV4DiscoveryPage(wrapped,{...job,lease_id:lease3},fact,progress,page,now),/v4_discovery_noncanonical/);
 const canonicalPage={...page,headers:page.headers.map(header=>header.number===initial?{...header,hash:orphanedHash}:header),identities:page.identities.map(identity=>({...identity,initial:{...identity.initial,blockHash:orphanedHash}}))};
 const repaired=await commitFreshV4DiscoveryPage(wrapped,{...job,lease_id:lease3},fact,progress,canonicalPage,now);assert.equal(repaired.markets,2);
 markets=(await client.query('SELECT * FROM fresh.markets WHERE token_address=$1',[token])).rows;assert.ok(markets.every(row=>row.status==='pending'&&row.observed_at===null&&Object.keys(row.state).length===0));
 assert.ok(!mutations.some(sql=>/INSERT INTO fresh\.(financial_events|recent_evidence)|UPDATE fresh\.(positions|kols|tokens)|DELETE FROM fresh\./.test(sql)));
 assert.equal((await client.query('SELECT count(*) FROM fresh.financial_events WHERE transaction_hash=$1',[txHash])).rows[0].count,'0');
 console.log(JSON.stringify({ok:true,checks:['two_manager_pools_preserved_without_unique_address_collision','duplicate_worker_lease_rejected','duplicate_discovery_preserves_ready_conversion_state','revision_change_and_orphan_header_rejected','canonical_reorg_identity_replaces_only_invalidated_state','bounded_identity_reader_unwraps_ready_market','no_financial_or_raw_receipt_writes'],fixtureWrites:'rolled back'}));
}finally{await client.query('ROLLBACK');client.release();await db.end();}
