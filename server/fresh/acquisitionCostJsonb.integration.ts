/** Actual PostgreSQL jsonb regression using only a transaction-local temp table.
 * The caller owns the client; no application table is modified. */
import assert from'node:assert/strict';
import type{PoolClient}from'pg';
import{WBNB}from'../launchpad.js';
import{RpcRequestError}from'../rpc.js';
import{assertFreshEventQuoteCompatible,freshEventFromRow,freshFinancialBasis,validateFreshFinancialEvent}from'./accounting.js';
import{freshAcquisitionCostKey}from'./acquisitionCost.js';
import{normalizeFreshReceipt}from'./decode.js';
import{freshQuoteUsd,freshTokenMetadata,type FreshPriceBlock}from'./pricing.js';
import{createFreshReceiptRecovery}from'./recovery.js';
import{createFreshStateEvidenceRpc}from'./stateEvidence.js';
import type{FreshCapturedReceipt}from'./capture.js';
import type{FreshAcquisitionCost,FreshFinancialEvent}from'../../shared/freshAccounting.js';
export type FreshAcquisitionCostJsonbFixture={entry:FreshCapturedReceipt;block:FreshPriceBlock;token:string;wallet:string;originalFinancialEvent:{id:string;fee_usd:string}};
const oldKey=(v:FreshAcquisitionCost)=>JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))));
export async function verifyFreshAcquisitionCostJsonbRoundtrip(client:PoolClient,fixtures:FreshAcquisitionCostJsonbFixture[]){
 let unexpectedReads=0;const missing=async()=>{unexpectedReads++;throw new RpcRequestError('offline_no_rpc','state_unavailable');};
 async function normalize(f:FreshAcquisitionCostJsonbFixture){const state=createFreshStateEvidenceRpc(missing,f.block,f.entry.stateEvidence),recovery=createFreshReceiptRecovery({query:async()=>{unexpectedReads++;throw Error('offline_no_database');}}as any,missing,f.entry,f.block,{state:()=>state.snapshot()}),result=await normalizeFreshReceipt(f.entry,{number:f.entry.transaction.blockNumber,hash:f.block.hash,timestamp:'0x'+Math.floor(Date.parse(f.block.timestamp)/1000).toString(16)},
  {metadata:address=>freshTokenMetadata(address,{rpc:async(method,params)=>{const call=params[0]as any;if(method==='eth_call'&&['0x06fdde03','0x95d89b41'].includes(String(call?.data))&&!state.snapshot()?.calls.some(c=>c.to===call.to&&c.data===call.data))throw Error('optional_identity_not_retained');return state.rpc(method,params);},block:f.block,requireSupply:false}),tokenDiscovery:async address=>address===f.token?'eligible':'pending',eligible:async t=>t.address===f.token,priceUsd:address=>address===WBNB?freshQuoteUsd(address,{rpc:state.rpc,block:f.block}):Promise.resolve(null),additionalNativeFeeWei:recovery.additionalNativeFeeWei,directFlapPurchaseUsd:recovery.directFlapPurchaseUsd,quotePaymentUsd:recovery.quotePaymentUsd,nativeQuoteChangeUsd:recovery.nativeQuoteChangeUsd,acquisitionCost:recovery.acquisitionCost,retainedQuoteMetadata:recovery.importedMetadata});
  assert.deepEqual(result.reasons,[]);assert.equal(result.events.length,1);assert.equal(state.writes,0);return result.events[0];
 }
 const toRow=(e:FreshFinancialEvent)=>({id:e.id,execution_key:e.executionKey,wallet_address:e.walletAddress,token_address:e.tokenAddress,kind:e.kind,quantity:e.quantity,amount_usd:e.amountUsd,fee_usd:e.feeUsd,fee_key:e.feeKey,counterparty:e.counterparty,transfer_key:e.transferKey,block_number:e.blockNumber,block_hash:e.blockHash,transaction_hash:e.transactionHash,transaction_index:e.transactionIndex,execution_index:e.executionIndex,log_index:e.logIndex,occurred_at:e.occurredAt,canonical:true,quote_address:e.quoteAddress,quote_symbol:e.quoteSymbol,quote_amount:e.quoteAmount,fee_attribution:e.feeAttribution??null});
 const checks:string[]=[];let shallowConflicts=0,nestedConflicts=0,tempMutations=0;
 await client.query('BEGIN');
 try{
  await client.query('CREATE TEMP TABLE acquisition_cost_roundtrip(id text PRIMARY KEY, original_row jsonb NOT NULL, acquisition_cost jsonb, fee_usd text, fee_key text) ON COMMIT DROP');
  for(const fixture of fixtures){
   const f=structuredClone(fixture),first=await normalize(f);validateFreshFinancialEvent(first);assert.equal(first.id,f.originalFinancialEvent.id);assert.equal(first.feeUsd,f.originalFinancialEvent.fee_usd);assert.ok(first.acquisitionCost?.intermediateQuoteProof);
   await client.query('INSERT INTO pg_temp.acquisition_cost_roundtrip(id,original_row,fee_usd,fee_key) VALUES($1,$2::jsonb,$3,$4)',[first.id,JSON.stringify(toRow(first)),first.feeUsd,first.feeKey]);tempMutations++;
   await client.query('UPDATE pg_temp.acquisition_cost_roundtrip SET acquisition_cost=$2::jsonb WHERE id=$1',[first.id,JSON.stringify(freshFinancialBasis(first))]);tempMutations++;
   const row=(await client.query('SELECT original_row,acquisition_cost,id,fee_usd,fee_key FROM pg_temp.acquisition_cost_roundtrip WHERE id=$1',[first.id])).rows[0],saved=freshEventFromRow({...row.original_row,acquisition_cost:row.acquisition_cost}),next=await normalize(f);
   assert.notEqual(oldKey(saved.acquisitionCost!),oldKey(next.acquisitionCost!));shallowConflicts++;
   assert.equal(freshAcquisitionCostKey(saved.acquisitionCost),freshAcquisitionCostKey(next.acquisitionCost));assert.doesNotThrow(()=>assertFreshEventQuoteCompatible(saved,next));validateFreshFinancialEvent(saved);
   assert.equal(saved.id,first.id);assert.equal(row.id,first.id);assert.equal(saved.feeUsd,first.feeUsd);assert.equal(row.fee_usd,first.feeUsd);assert.equal(saved.feeKey,first.feeKey);assert.equal(row.fee_key,first.feeKey);assert.deepEqual(saved.acquisitionCost,first.acquisitionCost);
   for(const field of Object.keys(next.acquisitionCost!.intermediateQuoteProof!)){const changed=structuredClone(next);(changed.acquisitionCost!.intermediateQuoteProof as any)[field]='changed';assert.throws(()=>assertFreshEventQuoteCompatible(saved,changed),/conflicting_acquisition_cost_evidence/);nestedConflicts++;}
   const changed=structuredClone(next);changed.acquisitionCost!.tokenCostUsd='0';assert.throws(()=>assertFreshEventQuoteCompatible(saved,changed),/conflicting_acquisition_cost_evidence/);
  }
  assert.equal(unexpectedReads,0);assert.equal(shallowConflicts,fixtures.length);checks.push('actual_postgres_nested_jsonb_reordering_reproduces_old_failure','all_actual_receipts_normalize_after_jsonb_update','all_nested_proof_field_conflicts_still_rejected','identity_fee_key_and_fee_value_unchanged','zero_provider_or_recovery_database_reads','all_writes_explicitly_pg_temp');
 }finally{await client.query('ROLLBACK');}
 const gone=(await client.query("SELECT to_regclass('pg_temp.acquisition_cost_roundtrip') name")).rows[0].name;assert.equal(gone,null);checks.push('temp_writes_rolled_back');
 return{fixtures:fixtures.length,shallowConflicts,nestedConflicts,tempMutations,providerCalls:unexpectedReads,applicationWrites:0,rolledBack:true,checks};
}
