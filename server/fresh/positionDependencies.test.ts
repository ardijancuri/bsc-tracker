import { describe, expect, it } from 'vitest';
import { freshPositionDependencies, freshPositionReceiptRelevantSql } from './positionDependencies.js';
import type { FreshCapturedReceipt } from './capture.js';
const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`,hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
function fixture():FreshCapturedReceipt {
  const transaction={hash:hash(1),blockHash:hash(2),blockNumber:'0xa',transactionIndex:'0x0',from:address(1),to:address(2),input:'0x12345678',value:'0x1',gasPrice:'0x1'};
  return {transaction,receipt:{transactionHash:hash(1),transactionIndex:'0x0',blockHash:hash(2),blockNumber:'0xa',status:'0x1',gasUsed:'0x1',logs:[]},
    wallets:[address(1)],observedAt:'2026-10-24T00:00:00Z',trace:{type:'CALL',from:address(1),to:address(2),input:'0x12345678',value:'0x1',calls:[
      {type:'DELEGATECALL',from:address(2),to:address(3),calls:[{type:'CALL',from:address(2),to:address(4),error:'reverted',input:'0x'}]},
    ]}};
}
describe('temporary full-execution position dependency index',()=>{
  it('retains every entered contract including delegates and reverted child calls',()=>{
    const proof=freshPositionDependencies(fixture());expect(proof?.addresses).toEqual([1,2,3,4].map(address));expect(proof?.proofHash).toMatch(/^[a-f0-9]{64}$/);
    expect(freshPositionDependencies(fixture())).toEqual(proof);
  });
  it('retains original log contracts in addition to the trace',()=>{
    const entry=fixture();entry.receipt.logs=[{address:address(9),topics:[hash(3)],data:'0x',logIndex:'0x0',transactionHash:hash(1),transactionIndex:'0x0',blockHash:hash(2),blockNumber:'0xa'}];
    expect(freshPositionDependencies(entry)?.addresses).toContain(address(9));
  });
  it('does not accept Transfer logs as a substitute for an unavailable call tree',()=>{const entry=fixture();delete entry.trace;expect(freshPositionDependencies(entry)).toBeNull();});
  it.each(['wrong_root','wrong_input','invalid_transaction_hash','wrong_transaction_block_hash','wrong_transaction_block_number','failed_receipt','bad_log','unknown_call','missing_destination','bad_child','too_many_addresses'])('fails closed for %s',change=>{
    const entry=fixture();
    if(change==='wrong_root')entry.trace!.to=address(5);
    if(change==='wrong_input')entry.trace!.input='0xdeadbeef';
    if(change==='invalid_transaction_hash'){entry.transaction.hash='invalid';entry.receipt.transactionHash='invalid';}
    if(change==='wrong_transaction_block_hash')entry.transaction.blockHash=hash(999);
    if(change==='wrong_transaction_block_number')entry.transaction.blockNumber='0xb';
    if(change==='failed_receipt')entry.receipt.status='0x0';
    if(change==='bad_log')entry.receipt.logs=[{address:address(9),topics:[],data:'0x',logIndex:'0x0',transactionHash:hash(99),transactionIndex:'0x0',blockHash:hash(2),blockNumber:'0xa'}];
    if(change==='unknown_call')entry.trace!.calls![0].type='OTHER';
    if(change==='missing_destination')delete entry.trace!.calls![0].to;
    if(change==='bad_child')entry.trace!.calls![0].from='not-an-address';
    if(change==='too_many_addresses')entry.trace!.calls=Array.from({length:513},(_,n)=>({type:'CALL',from:address(2),to:address(n+100),input:'0x'}));
    expect(freshPositionDependencies(entry)).toBeNull();
  });
  it('keeps malformed or absent stored proof indexes conservative',()=>{
    const sql=freshPositionReceiptRelevantSql('e','p.token_address');expect(sql).toContain('position_dependency_addresses IS NULL');expect(sql).toContain('position_dependency_proof IS NULL');expect(sql).toContain("!~'^[0-9a-f]{64}$'");expect(sql).toContain('p.token_address=ANY');
  });
});
