import { describe, expect, it } from 'vitest';
import { freshPositionDependencies, freshPositionReceiptRelevantSql,freshPositionReceiptPredatesTokenBirthSql,freshPositionReceiptRawRelevantSql } from './positionDependencies.js';
import type { FreshCapturedReceipt } from './capture.js';
import{decodeFreshEvidence}from'./capture.js';
import{readFileSync}from'node:fs';
import{gunzipSync}from'node:zlib';
import{createHash}from'node:crypto';
import{transferTopic}from'../swap.js';
const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`,hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
function fixture():FreshCapturedReceipt {
  const transaction={hash:hash(1),blockHash:hash(2),blockNumber:'0xa',transactionIndex:'0x0',from:address(1),to:address(2),input:'0x12345678',value:'0x1',gasPrice:'0x1'};
  return {transaction,receipt:{transactionHash:hash(1),transactionIndex:'0x0',blockHash:hash(2),blockNumber:'0xa',status:'0x1',gasUsed:'0x1',logs:[]},
    wallets:[address(1)],observedAt:'2026-10-24T00:00:00Z',trace:{type:'CALL',from:address(1),to:address(2),input:'0x12345678',value:'0x1',calls:[
      {type:'DELEGATECALL',from:address(2),to:address(3),calls:[{type:'CALL',from:address(2),to:address(4),error:'reverted',input:'0x'}]},
    ]}};
}
const actual=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/position-transfer-participants.json.gz',import.meta.url))).toString());
const transfer=(from:string,to:string,index=0)=>({address:address(9),topics:[transferTopic,'0x'+from.slice(2).padStart(64,'0'),'0x'+to.slice(2).padStart(64,'0')],data:'0x'+'1'.padStart(64,'0'),logIndex:'0x'+index.toString(16),transactionHash:hash(1),transactionIndex:'0x0',blockHash:hash(2),blockNumber:'0xa'});
describe('temporary full-execution position dependency index',()=>{
  it('retains every entered contract including delegates and reverted child calls',()=>{
    const proof=freshPositionDependencies(fixture());expect(proof?.addresses).toEqual([1,2,3,4].map(address));expect(proof?.proofHash).toMatch(/^[a-f0-9]{64}$/);
    expect(freshPositionDependencies(fixture())).toEqual(proof);
  });
  it('retains original log contracts in addition to the trace',()=>{
    const entry=fixture();entry.receipt.logs=[{address:address(9),topics:[hash(3)],data:'0x',logIndex:'0x0',transactionHash:hash(1),transactionIndex:'0x0',blockHash:hash(2),blockNumber:'0xa'}];
    expect(freshPositionDependencies(entry)?.addresses).toContain(address(9));
  });
  it('includes canonical passive incoming and outgoing participants without replacing the complete trace',()=>{
    const entry=fixture();entry.receipt.logs=[transfer(address(5),address(6)),transfer(address(7),address(5),1)];
    const proof=freshPositionDependencies(entry)!;expect(proof.addresses).toEqual([1,2,3,4,5,6,7,9].map(address));
    expect(entry.trace!.calls!.some(c=>c.to===address(6))).toBe(false);
    delete entry.trace;expect(freshPositionDependencies(entry)).toBeNull();
  });
  it('indexes the actual passive David receipt while preserving every original byte and unknown-cost financial fact',()=>{
    const bytes=Buffer.from(actual.payloadBase64,'base64');expect(createHash('sha256').update(bytes).digest('hex')).toBe(actual.payloadSha256);
    const entry=decodeFreshEvidence(bytes),original=structuredClone(entry),proof=freshPositionDependencies(entry)!;
    expect(proof.addresses).toContain(actual.fact.wallet_address);expect(proof.addresses).toContain(actual.fact.counterparty);
    expect(proof.addresses).toContain(actual.fact.token_address);expect(proof.addresses).toContain('0x5e972ac496e6875b2eb70e88d2d67793662ba029');
    const calls:string[]=[];const visit=(c:NonNullable<FreshCapturedReceipt['trace']>)=>{calls.push(c.to!);c.calls?.forEach(visit);};visit(entry.trace!);
    expect(calls).not.toContain(actual.fact.wallet_address);expect(entry).toEqual(original);
    expect(actual.fact.amount_usd).toBeNull();expect(actual.fact.fee_usd).toBe('0');expect(actual.fact.realized_q).toBe('0');
    expect(proof.proofHash).toBe(createHash('sha256').update(JSON.stringify([entry.transaction,entry.receipt,entry.trace])).digest('hex'));
  });
  it.each(['from_high_bits','to_high_bits','short_topic','extra_topic','missing_topic','short_data','foreign_topic'])('does not derive participants from malformed or non-ERC20 %s logs',change=>{
    const entry=fixture(),log=transfer(address(5),address(6));
    if(change==='from_high_bits')log.topics[1]='0x1'+log.topics[1].slice(3);
    if(change==='to_high_bits')log.topics[2]='0x1'+log.topics[2].slice(3);
    if(change==='short_topic')log.topics[1]='0x05';if(change==='extra_topic')log.topics.push(hash(4));
    if(change==='missing_topic')log.topics.pop();if(change==='short_data')log.data='0x01';if(change==='foreign_topic')log.topics[0]=hash(3);
    entry.receipt.logs=[log];const proof=freshPositionDependencies(entry);expect(proof?.addresses??[]).not.toContain(address(5));expect(proof?.addresses??[]).not.toContain(address(6));
  });
  it('fails closed when genuine transfer participants exceed the unchanged 512-address bound',()=>{
    const entry=fixture();entry.receipt.logs=Array.from({length:255},(_,n)=>transfer(address(1000+n*2),address(1001+n*2),n));
    expect(freshPositionDependencies(entry)).toBeNull();
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
  it('validates the birth map independently of outer receipt/token rows so PostgreSQL can initialize it once',()=>{
    const sql=freshPositionReceiptPredatesTokenBirthSql('e','p.token_address'),map=sql.slice(sql.indexOf('SELECT jsonb_object_agg'),sql.indexOf(' ->> p.token_address'));
    expect(map).toContain("canonical_token_birth_v1");expect(map).not.toContain('e.block_number');expect(map).not.toContain('p.token_address');
    expect(sql).toContain('COALESCE(');expect(sql).toContain('::bigint,false)');expect(sql).toContain('explicit_token.transaction_hash=e.tx_hash');
  });
  it('keeps global opaque-accounting relevance free of the unnecessary birth proof query',()=>{
    const sql=freshPositionReceiptRawRelevantSql('e','p.token_address');expect(sql).toContain('position_dependency_proof IS NULL');expect(sql).toContain('p.token_address=ANY');expect(sql).not.toContain('launch_facts');
  });
});
