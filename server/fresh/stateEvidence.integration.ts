/** Successful metadata survives a valuation repair and node-state pruning.
 * Every fixture write rolls back; no real providers or messages are used. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {Interface} from 'ethers';
import {runFreshDecode} from './decode.js';
import {encodeFreshEvidence,decodeFreshEvidence,type FreshCapturedReceipt} from './capture.js';
import {RpcRequestError,type Rpc} from '../rpc.js';
import {transferTopic} from '../swap.js';
const url=new URL(process.env.DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='5436'||!url.pathname.includes('fresh'))throw Error('Isolated local fresh database required');
const db=new Pool({connectionString:url.toString(),max:1}),client=await db.connect();
const addr=()=>`0x${randomBytes(20).toString('hex')}`,hash=()=>`0x${randomBytes(32).toString('hex')}`,word=(v:string)=>v.slice(2).padStart(64,'0');
const wallet=addr(),sender=addr(),token=addr(),tx=hash(),blockHash=hash(),now=new Date(),scope=`kol:${wallet}`;
const abi=new Interface(['function decimals() view returns(uint8)','function totalSupply() view returns(uint256)','function name() view returns(string)','function symbol() view returns(string)']);
try{
 await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(73621941)');
 const n=Number((await client.query("SELECT block_number FROM fresh.checkpoints WHERE key='capture'")).rows[0].block_number)+100,hex=`0x${n.toString(16)}`;
 await client.query('INSERT INTO fresh.wallets(address,monitoring_from_block) VALUES($1,$2)',[wallet,n]);
 await client.query('INSERT INTO fresh.kols(wallet_address) VALUES($1)',[wallet]);
 await client.query("INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,starts_at,starts_block) VALUES($1,'kol',$2,$3,$4)",[scope,[wallet],new Date(now.getTime()-1000),n]);
 await client.query('INSERT INTO fresh.recent_blocks(block_number,block_hash,parent_hash,occurred_at) VALUES($1,$2,$3,$4)',[n,blockHash,hash(),now]);
 await client.query("INSERT INTO fresh.launch_facts(token_address,protocol,block_number,block_hash,tx_hash,launched_at,proof,status) VALUES($1,'fourmeme',$2,$3,$4,$5,'{}','eligible')",[token,n-1,hash(),hash(),now]);
 const entry:FreshCapturedReceipt={transaction:{hash:tx,from:sender,to:sender,value:'0x0',blockHash,blockNumber:hex,transactionIndex:'0x0',gasPrice:'0x0'},receipt:{transactionHash:tx,transactionIndex:'0x0',blockHash,blockNumber:hex,status:'0x1',gasUsed:'0x5208',effectiveGasPrice:'0x0',logs:[{address:token,topics:[transferTopic,`0x${word(sender)}`,`0x${word(wallet)}`],data:`0x${(10n*10n**18n).toString(16).padStart(64,'0')}`,logIndex:'0x0',transactionHash:tx,transactionIndex:'0x0',blockHash,blockNumber:hex}]},wallets:[wallet],observedAt:now.toISOString()};
 await client.query('INSERT INTO fresh.recent_evidence(tx_hash,block_hash,block_number,transaction_index,payload,expires_at,wallet_addresses) VALUES($1,$2,$3,0,$4,$5,$6)',[tx,blockHash,n,encodeFreshEvidence(entry),new Date(now.getTime()+72*3600_000),[wallet]]);
 // Only this fixture is selected; all remaining SQL uses the caller-owned
 // transaction. Decoder commits become savepoint releases, never real commits.
 const query=async(sql:string,values?:unknown[])=>{
  if(sql==='BEGIN')return client.query('SAVEPOINT state_evidence_decode');
  if(sql==='COMMIT')return client.query('RELEASE SAVEPOINT state_evidence_decode');
  if(sql==='ROLLBACK')return client.query('ROLLBACK TO SAVEPOINT state_evidence_decode');
  if(sql.startsWith('SELECT e.*,b.parent_hash,b.occurred_at'))return client.query('SELECT e.*,b.parent_hash,b.occurred_at FROM fresh.recent_evidence e JOIN fresh.recent_blocks b USING(block_number,block_hash) WHERE e.tx_hash=$1',[tx]);
  return client.query(sql,values);
 };
 const fixtureDb={query,connect:async()=>({query,release(){}})} as unknown as Pool;
 const rpc:Rpc=async<T>(method:string,params:unknown[])=>{
  assert.equal(method,'eth_call');assert.deepEqual(params[1],{blockHash,requireCanonical:true});
  const call=params[0] as {to:string;data:string};
  if(call.data===abi.encodeFunctionData('decimals'))return abi.encodeFunctionResult('decimals',[18]) as T;
  if(call.to===token){for(const field of ['totalSupply','name','symbol'] as const)if(call.data===abi.encodeFunctionData(field))return abi.encodeFunctionResult(field,[field==='totalSupply'?10n**24n:field==='name'?'Verified fixture token':'FRESH']) as T;}
  throw new RpcRequestError('RPC eth_call unavailable','revert',{code:3});
 };
 await runFreshDecode(fixtureDb,rpc,{now});
 const first=(await client.query('SELECT * FROM fresh.recent_evidence WHERE tx_hash=$1',[tx])).rows[0];
 assert.equal(first.decoder_status,'repair');assert.match(first.last_error,/incoming_transfer_cost_unknown/);
 const stored=decodeFreshEvidence(first.payload);assert.ok(stored.stateEvidence?.calls.some(c=>c.to===token&&c.data==='0x313ce567'));
 const expired:Rpc=async()=>{throw new RpcRequestError('RPC eth_call unavailable','state_unavailable',{code:-32000});};
 await runFreshDecode(fixtureDb,expired,{now:new Date(now.getTime()+90_000)});
 const second=(await client.query('SELECT * FROM fresh.recent_evidence WHERE tx_hash=$1',[tx])).rows[0];
 assert.match(second.last_error,/incoming_transfer_cost_unknown/);assert.doesNotMatch(second.last_error,/token_decimals_unavailable/);
 const events=(await client.query('SELECT * FROM fresh.financial_events WHERE transaction_hash=$1',[tx])).rows;
 assert.equal(events.length,1);assert.equal(events[0].quantity,'10');assert.equal(events[0].amount_usd,null);assert.equal(events[0].fee_usd,'0');
 assert.deepEqual(decodeFreshEvidence(second.payload).receipt,entry.receipt);assert.deepEqual(decodeFreshEvidence(second.payload).transaction,entry.transaction);
 console.log(JSON.stringify({ok:true,checks:['partial_repair_retains_block_specific_state','pruned_state_keeps_verified_quantity','unknown_cost_stays_null','original_receipt_retained','idempotent_financial_facts'],fixtureWrites:'rolled back'}));
}finally{await client.query('ROLLBACK');client.release();await db.end();}
