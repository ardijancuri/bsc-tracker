import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{gunzipSync}from'node:zlib';import type{PoolClient}from'pg';
import{createFreshStateEvidenceRpc}from'./stateEvidence.js';import{freshTokenMetadata,freshQuoteUsd}from'./pricing.js';import{createFreshReceiptRecovery}from'./recovery.js';import{normalizeFreshReceipt}from'./decode.js';import{freshEventFromRow}from'./accounting.js';import{WBNB}from'../launchpad.js';
/** Real PostgreSQL JSONB ordering on all four original receipts/proofs. */
export async function verifyFreshCapturedFlapQuoteJsonb(c:PoolClient){
 const fixture=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/historical-captured-flap-quote.json.gz',import.meta.url))).toString()),checks:string[]=[];let rpcCalls=0,headerReads=0;
 const rpc=async()=>{rpcCalls++;throw Error('external_rpc_forbidden');},canonicalHash=async(n:number)=>fixture.headers.find((h:any)=>h.number===n)?.hash??null;
 const normalize=async(x:any)=>{const state=createFreshStateEvidenceRpc(rpc,x.target,x.entry.stateEvidence),db={query:async(sql:string,args:any[])=>{headerReads++;if(sql==='SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1')return{rows:[{block_hash:await canonicalHash(Number(args[0]))}]};throw Error('historical_database_scan_forbidden');}},recovery=createFreshReceiptRecovery(db as any,rpc,x.entry,x.target,{state:()=>state.snapshot()});return normalizeFreshReceipt(x.entry,{number:x.entry.transaction.blockNumber,hash:x.target.hash,timestamp:'0x'+Math.floor(Date.parse(x.target.timestamp)/1000).toString(16)},
  {metadata:t=>freshTokenMetadata(t,{rpc:state.rpc,block:x.target}),knownLaunch:async t=>t===x.token,eligible:async t=>t.address===x.token,priceUsd:t=>t===WBNB?freshQuoteUsd(t,{rpc:state.rpc,block:x.target}):recovery.priceUsd(t)});};
 await c.query('BEGIN');try{
  await c.query('CREATE TEMP TABLE captured_flap_jsonb(id integer PRIMARY KEY,value jsonb NOT NULL)ON COMMIT DROP');
  for(const[i,x]of fixture.cases.entries())await c.query('INSERT INTO pg_temp.captured_flap_jsonb VALUES($1,$2::jsonb)',[i,JSON.stringify(x)]);
  const before=(await c.query('SELECT id,value FROM pg_temp.captured_flap_jsonb ORDER BY id')).rows;
  for(const row of before){const x=row.value,decoded=await normalize(x);assert.deepEqual(decoded.events,x.expectedEvents);assert.deepEqual(decoded.reasons,[]);assert.deepEqual(decoded.events,[{...freshEventFromRow(x.originalFinancialEvent),amountUsd:x.expectedEvents[0].amountUsd}]);assert.notEqual(decoded.events[0].amountUsd,'0');checks.push('Actual original transfer '+row.id+' keeps identity gas quantity with genuine nonzero historical mark after JSONB');}
  for(const[name,path,value]of[['source checksum','{entry,recoveryEvidence,genericCapturedPrices,0,conversion,capturedFlapAuthorization,sourceSha256}','"forged"'],['original target','{entry,recoveryEvidence,genericCapturedPrices,0,target,hash}','"0x'+'f'.repeat(64)+'"'],['historical source','{entry,recoveryEvidence,genericCapturedPrices,0,conversion,quote,source,hash}','"0x'+'f'.repeat(64)+'"']]as const){
   await c.query('SAVEPOINT negative');await c.query('UPDATE pg_temp.captured_flap_jsonb SET value=jsonb_set(value,$1,$2::jsonb)WHERE id=0',[path,value]);const x=(await c.query('SELECT value FROM pg_temp.captured_flap_jsonb WHERE id=0')).rows[0].value;
   const decoded=await normalize(x);assert.equal(decoded.events[0].amountUsd,null);assert(decoded.reasons.includes('incoming_transfer_cost_unknown'));await c.query('ROLLBACK TO SAVEPOINT negative');checks.push('Changed '+name+' remains cost unknown after JSONB');
  }
  assert.deepEqual((await c.query('SELECT id,value FROM pg_temp.captured_flap_jsonb ORDER BY id')).rows,before);assert.equal(rpcCalls,0);checks.push('Every original receipt/proof and null original amount unchanged; zero external reads');
  await c.query('ROLLBACK');return{passed:true,checks,rpcCalls,providerCalls:0,applicationWrites:0,financialWrites:0,canonicalHeaderReads:headerReads,fixtureWrites:'TEMP JSONB only, rolled back'};
 }catch(error){await c.query('ROLLBACK');throw error;}
}
