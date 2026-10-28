import {describe, expect, it} from 'vitest';
import {addFreshAdmissionRecheckMarker, freshAdmissionTransferWallets, freshAdmissionHistoricalEventIds, runFreshAdmissionRecheck} from './admissionRecheck.js';
import {encodeFreshEvidence, decodeFreshEvidence, type FreshCapturedReceipt} from './capture.js';
import {transferTopic} from '../swap.js';
import type {Pool} from 'pg';
import type{FreshFinancialEvent}from'../../shared/freshAccounting.js';
import{assertFreshDecodeEvidenceUnchanged,reconcileFreshDecodeEvidence}from'./decode.js';
import{createFreshStateEvidenceRpc}from'./stateEvidence.js';

const hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0'), address=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
const token=address(1), wallet=address(2), other=address(3), second=address(4), block={number:110,hash:hash(110),timestamp:'2026-10-26T12:00:00.000Z'};
const word=(n:bigint|string)=>'0x'+BigInt(n).toString(16).padStart(64,'0');
function fixture():FreshCapturedReceipt {
 const transaction={hash:hash(900),from:wallet,to:other,value:'0x0',blockHash:block.hash,blockNumber:'0x6e',transactionIndex:'0x0',gasPrice:'0x1'};
 return {transaction,receipt:{transactionHash:transaction.hash,transactionIndex:'0x0',blockHash:block.hash,blockNumber:'0x6e',status:'0x1',gasUsed:'0x1',effectiveGasPrice:'0x1',logs:[{address:token,topics:[transferTopic,word(other),word(wallet)],data:word(5n),logIndex:'0x0',transactionHash:transaction.hash,transactionIndex:'0x0',blockNumber:'0x6e',blockHash:block.hash}]},wallets:[wallet],observedAt:'2026-10-26T12:01:00.000Z'};
}
const marker=(n=1)=>({version:1 as const,kind:'token_admission_recheck_v1' as const,tokenAddress:address(n),admissionSha256:'a'.repeat(64),at:'2026-10-26T12:01:00.000Z',originalPayloadSha256:'b'.repeat(64),previous:{decoderStatus:'done' as const,decoderVersion:4,lastError:'original_failure'}});
const event=(id='buy'):FreshFinancialEvent=>({id,executionKey:'execution',walletAddress:wallet,tokenAddress:token,kind:'buy',quantity:'5',amountUsd:'10',feeUsd:'1',feeKey:'fee',counterparty:null,transferKey:null,blockNumber:String(block.number),blockHash:block.hash,transactionHash:hash(900),transactionIndex:0,executionIndex:0,logIndex:0,occurredAt:block.timestamp});

describe('bounded post-admission receipt recovery',()=>{
 it('finds an exact incoming transfer even before a wallet has traded',()=>expect(freshAdmissionTransferWallets(fixture(),token,block)).toEqual([wallet]));
 it('finds outgoing transfers and both original watched sides without importing unrelated participants',()=>{
  const f=fixture();f.wallets=[wallet,second];f.receipt.logs[0].topics=[transferTopic,word(wallet),word(second)];
  expect(freshAdmissionTransferWallets(f,token,block)).toEqual([wallet,second].sort());
  f.wallets=[wallet];expect(freshAdmissionTransferWallets(f,token,block)).toEqual([wallet]);
 });
 it.each(['zero','other_token','unwatched','failed'] as const)('ignores %s logs',reason=>{
  const f=fixture();if(reason==='zero')f.receipt.logs[0].data=word(0n);if(reason==='other_token')f.receipt.logs[0].address=address(9);if(reason==='unwatched')f.wallets=[second];if(reason==='failed')f.receipt.status='0x0';
  expect(freshAdmissionTransferWallets(f,token,block)).toEqual([]);
 });
 it.each(['short_data','bad_topic','extra_topic'] as const)('rejects malformed token transfer %s',reason=>{
  const f=fixture();if(reason==='short_data')f.receipt.logs[0].data='0x01';if(reason==='bad_topic')f.receipt.logs[0].topics[1]='0x'+'f'.repeat(64);if(reason==='extra_topic')f.receipt.logs[0].topics.push(word(1n));
  expect(()=>freshAdmissionTransferWallets(f,token,block)).toThrow();
 });
 it('rejects noncanonical receipt/log identities and duplicated original membership',()=>{
  const f=fixture();f.receipt.logs[0].blockHash=hash(111);expect(()=>freshAdmissionTransferWallets(f,token,block)).toThrow();
  const duplicate=fixture();duplicate.wallets.push(wallet);expect(freshAdmissionTransferWallets(duplicate,token,block)).toEqual([]);
 });
 it('deduplicates repeat logs and never infers token identity from a symbol',()=>{
  const f=fixture();f.receipt.logs.push({...f.receipt.logs[0],logIndex:'0x1'});expect(freshAdmissionTransferWallets(f,token,block)).toEqual([wallet]);
  expect(freshAdmissionTransferWallets(f,'TOKEN',block)).toEqual([]);
 });
 it('retains the complete original receipt and DONE/error provenance in a bounded additive marker',()=>{
  const f=fixture(), original=structuredClone(f), result=addFreshAdmissionRecheckMarker(f,marker());
  expect(f).toEqual(original);const {admissionRechecks,...body}=result;expect(body).toEqual(original);expect(admissionRechecks).toEqual([marker()]);
  expect(decodeFreshEvidence(encodeFreshEvidence(result))).toEqual({...result,version:1});
 });
 it('keeps separate token admissions and forbids the same token/admission from churning',()=>{
  const first=addFreshAdmissionRecheckMarker(fixture(),marker());const next=addFreshAdmissionRecheckMarker(first,marker(8));expect(next.admissionRechecks).toHaveLength(2);
  expect(()=>addFreshAdmissionRecheckMarker(first,marker())).toThrow('admission_recheck_marker_conflict');
 });
 it('silences only exact-token facts from original DONE receipts, preserving other token, wallet and execution identities',()=>{
  const f=addFreshAdmissionRecheckMarker(fixture(),marker()),buy=event();
  expect(freshAdmissionHistoricalEventIds(f,[buy,{...buy,id:'other-token',tokenAddress:address(8)},{...buy,id:'other-wallet',walletAddress:second},{...buy,id:'other-hash',transactionHash:hash(901)}])).toEqual(['buy']);
  expect(freshAdmissionHistoricalEventIds(fixture(),[buy])).toEqual([]);
 });
 it.each(['pending','repair']as const)('keeps a genuine fresh %s first trade under normal alert rules',status=>{
  const m={...marker(),previous:{...marker().previous,decoderStatus:status}},f=addFreshAdmissionRecheckMarker(fixture(),m);
  expect(freshAdmissionHistoricalEventIds(f,[event()])).toEqual([]);
 });
 it.each(['pending','repair']as const)('inherits original DONE silence across a later %s admission of the same receipt',status=>{
  const f=fixture();f.receipt.logs.push({...f.receipt.logs[0],address:address(8),logIndex:'0x1'});const first=addFreshAdmissionRecheckMarker(f,marker()),later=addFreshAdmissionRecheckMarker(first,{...marker(8),previous:{...marker(8).previous,decoderStatus:status}});
  expect(freshAdmissionHistoricalEventIds(later,[event(),{...event('second'),tokenAddress:address(8)}])).toEqual(['buy','second']);
 });
 it('never retroactively silences a genuine earlier pending first trade when another token later has DONE provenance',()=>{
  const f=fixture();f.receipt.logs.push({...f.receipt.logs[0],address:address(8),logIndex:'0x1'});const first=addFreshAdmissionRecheckMarker(f,{...marker(),previous:{...marker().previous,decoderStatus:'pending'}}),later=addFreshAdmissionRecheckMarker(first,marker(8));
  expect(freshAdmissionHistoricalEventIds(later,[event(),{...event('second'),tokenAddress:address(8)}])).toEqual(['second']);
 });
 it('invalid original DONE provenance cannot silence a later pending marker',()=>{
  const f=fixture();f.receipt.logs.push({...f.receipt.logs[0],address:address(8),logIndex:'0x1'});const first=addFreshAdmissionRecheckMarker(f,{...marker(),originalPayloadSha256:'bad'}),later=addFreshAdmissionRecheckMarker(first,{...marker(8),previous:{...marker(8).previous,decoderStatus:'pending'}});
  expect(freshAdmissionHistoricalEventIds(later,[event(),{...event('second'),tokenAddress:address(8)}])).toEqual([]);
 });
 it('malformed historical provenance cannot classify a live event as a recovered DONE fact',()=>{
  const m={...marker(),originalPayloadSha256:'bad'},f=addFreshAdmissionRecheckMarker(fixture(),m);
  expect(freshAdmissionHistoricalEventIds(f,[event()])).toEqual([]);
 });
 it('an admission marker defeats an already selected pre-admission normalizer including the additive-state merge path',()=>{
  const f=fixture(),selected={payload:encodeFreshEvidence(f)},latest={wallet_addresses:f.wallets,payload:encodeFreshEvidence(addFreshAdmissionRecheckMarker(f,marker()))};
  expect(()=>assertFreshDecodeEvidenceUnchanged(latest,selected,f.wallets)).toThrow('decode_evidence_changed');
  const state=createFreshStateEvidenceRpc(async()=>{throw Error('no_network');},{number:block.number,hash:block.hash});
  expect(()=>reconcileFreshDecodeEvidence(latest,selected,f,state)).toThrow('decode_evidence_changed');
 });
 it('bounds marker count and bytes while retaining the prior body',()=>{
  const f={...fixture(),admissionRechecks:Array.from({length:32},(_,i)=>marker(i+1))};expect(()=>addFreshAdmissionRecheckMarker(f,marker(33))).toThrow(/marker_/);
  expect(()=>addFreshAdmissionRecheckMarker(fixture(),{...marker(),previous:{...marker().previous,lastError:'x'.repeat(13000)}})).toThrow('admission_recheck_marker_bounds');
 });
 it('aborted work has zero database calls',async()=>{
  let calls=0;const db={query(){calls++;throw Error('unexpected');}}as unknown as Pool;
  expect((await runFreshAdmissionRecheck(db,{signal:AbortSignal.abort()})).yielded).toBe(true);expect(calls).toBe(0);
 });
 it.each([undefined,{ok:'false',occurred_at:block.timestamp},{ok:'true',occurred_at:'2026-10-26T11:59:00.000Z'},{ok:'true',occurred_at:'2026-10-26T12:01:00.000Z'},{ok:'true',occurred_at:'bad'}])('unhealthy or stale capture yields before scanning originals',async health=>{
  let calls=0;const db={async query(){calls++;return{rows:health?[health]:[]};}}as unknown as Pool;
  const result=await runFreshAdmissionRecheck(db,{now:new Date('2026-10-26T12:00:00.000Z')});expect(result.yielded).toBe(true);expect(calls).toBe(1);
 });
 it('invalid selection fails before any database calls',async()=>{
  let calls=0;const db={query(){calls++;throw Error('unexpected');}}as unknown as Pool;
  await expect(runFreshAdmissionRecheck(db,{reference:'other'})).rejects.toThrow('admission_recheck_reference');expect(calls).toBe(0);
 });
});
