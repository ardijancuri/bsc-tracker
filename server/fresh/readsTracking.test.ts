import{describe,it,expect,vi}from'vitest';
import type{Pool}from'pg';
import{createFreshReads}from'./reads.js';
import{freshPublicTokenSql}from'./publicTokens.js';
import{GANG_TOKEN_ADDRESS,FRESH_GANG_CREATION_HASH,FRESH_GANG_CREATION_TIME,FRESH_GANG_HISTORY_FROM_BLOCK,FRESH_GANG_HISTORY_ADMISSION_KEY,freshTokenAdmissionKey}from'./tracking.js';

describe('preexisting token accounting read boundary',()=>{
 const now=Date.parse('2026-10-25T12:00:00.000Z'),wallet='0x'+'1'.repeat(40),hash='0x'+'a'.repeat(64);
 function fixture(kind:'kol'|'portfolio_wallet',imported=false,history=false){
  const scopeId=kind==='kol'?'kol:'+wallet:'portfolio:account:'+wallet;
  const row={scope_id:scopeId,token_address:GANG_TOKEN_ADDRESS,address:GANG_TOKEN_ADDRESS,launch_status:'preexisting',quantity_q:'5',
   invested_q:'0',sold_q:'0',incoming_q:'0',outgoing_q:'0',fees_q:'0',capital_q:'0',realized_q:null,
   unknown_cost:true,unknown_fee:false,unknown_incoming_value:true,imported_provenance:imported,last_event_id:'transfer',last_event_at:new Date(now-60_000),
   last_event_block:'102',position_revision:'1',revision:'1',valuation_status:'ready',observed_at:new Date(now),observed_block:'103',observed_hash:hash,price_usd:'1',
   balance_status:'matched',balance_quantity:'5',balance_block:'103',balance_hash:hash,balance_checked_at:new Date(now),wallet_gap:false,decoding_pending:false,registration_pending:false};
  const query=vi.fn(async(sql:string)=>{
   if(sql.startsWith('SELECT block_number::text,block_hash,value FROM fresh.checkpoints'))return{rows:history?[{block_number:'129627586',block_hash:hash,value:{startBlock:129627586,startHash:hash,startTime:'2026-10-25T02:42:03.000Z'}}]:[]};
   if(sql.includes('SELECT key,value FROM fresh.checkpoints'))return{rows:[{key:freshTokenAdmissionKey(GANG_TOKEN_ADDRESS),value:{version:1,kind:'explicit_existing',chainId:56,tokenAddress:GANG_TOKEN_ADDRESS,active:true,startBlock:129627586,startHash:hash,startTime:'2026-10-25T02:42:03.000Z',fromBlock:129627587,approvedAt:'2026-10-25T13:00:00.000Z',reason:'user_approved_gang_only'}},{key:FRESH_GANG_HISTORY_ADMISSION_KEY,value:{version:1,kind:'explicit_token_history',chainId:56,tokenAddress:GANG_TOKEN_ADDRESS,active:true,startBlock:129627586,startHash:hash,startTime:'2026-10-25T02:42:03.000Z',historyFromBlock:FRESH_GANG_HISTORY_FROM_BLOCK,historyFromHash:FRESH_GANG_CREATION_HASH,historyFromTime:FRESH_GANG_CREATION_TIME,sourceDatasetSha256:'c'.repeat(64),approvedAt:'2026-10-25T14:00:00.000Z',policy:'gmgn_gang_only_history_v1'}}]};
   if(sql.startsWith('SELECT 1 FROM fresh.launch_facts'))return{rows:[]};
   if(sql.startsWith('SELECT 1 FROM fresh.kols k JOIN fresh.wallets'))return{rows:[{}]};
   if(sql.includes('FROM fresh.positions p JOIN fresh.tokens'))return{rows:[row]};
   if(sql.includes('FROM fresh.open_lots'))return{rows:[{id:'lot',scope_id:scopeId,token_address:GANG_TOKEN_ADDRESS,wallet_address:wallet,acquired_event_id:'transfer',
    acquired_block:'102',acquired_transaction_index:0,acquired_execution_index:0,quantity_q:'5',cost_q:null,fee_known:true}]};
   if(sql.includes('SELECT * FROM fresh.accounting_scopes'))return{rows:[{id:scopeId,kind,wallet_addresses:[wallet],starts_at:new Date(now-120_000),starts_block:'101',correction_epoch:'1',revision:'1'}]};
   if(sql.includes("key IN('start','capture'"))return{rows:[{key:'capture',block_number:'103',block_hash:hash}]};
   throw Error('Unexpected read fixture SQL');
  });
  return{reads:createFreshReads({query}as unknown as Pool,()=>now,true),query,scopeId,row};
 }
 it('requires a genuine public swap before exposing a preexisting public position and never invents its original costs',async()=>{
  const{reads,query,scopeId}=fixture('kol'),summary=(await reads.summaries(wallet,[GANG_TOKEN_ADDRESS],scopeId))[GANG_TOKEN_ADDRESS];
  expect(query.mock.calls[0][0]).toContain("t.launch_status<>'preexisting' OR s.kind<>'kol'");
  expect(query.mock.calls[0][0]).toContain(freshPublicTokenSql('t'));
  expect(query.mock.calls[0][0]).toContain('h.block_number=e.block_number AND h.block_hash=e.block_hash');
  expect(query.mock.calls[0][0]).toContain('h.occurred_at IS NULL');
  expect(summary).toMatchObject({status:'unavailable',realizedStatus:'unavailable',realizedProfitUsd:null,estimatedProfitUsd:null,roi:null,reason:'unknown_costs',
   snapshot:{historyBoundary:'wallet_discovery',complete:false,reasons:['unknown_costs']}});
 });
 it('keeps private Portfolio admission separate from public publication and its membership boundary unchanged',async()=>{
  const{reads,scopeId}=fixture('portfolio_wallet'),summary=(await reads.summaries(wallet,[GANG_TOKEN_ADDRESS],scopeId))[GANG_TOKEN_ADDRESS];
  expect(summary).toMatchObject({realizedProfitUsd:null,estimatedProfitUsd:null,roi:null,snapshot:{scope:'portfolio',historyBoundary:'membership_added',complete:false}});
 });
 it('shows fully known realized sales even when unsold incoming lots still have unknown acquisition costs',async()=>{
  const{reads,scopeId,row,query}=fixture('kol');(row as any).realized_q='7';
  const summary=(await reads.summaries(wallet,[GANG_TOKEN_ADDRESS],scopeId))[GANG_TOKEN_ADDRESS];
  expect(summary).toMatchObject({realizedStatus:'ready',realizedProfitUsd:'7',estimatedProfitUsd:null,roi:null,reason:'unknown_costs',
   snapshot:{complete:true,reasons:[],refreshStatus:'pending',refreshReason:'unknown_costs'}});
  expect(query.mock.calls.every(([sql])=>sql.startsWith('SELECT'))).toBe(true);
  expect(query.mock.calls.some(([sql])=>sql.includes('SELECT e.* FROM fresh.financial_events'))).toBe(false);
 });
 it('does not expose old position totals while the explicit policy migration is incomplete',async()=>{
  const{reads,scopeId,row}=fixture('kol');Object.assign(row,{realized_q:'7',accounting_policy_ready:false});
  const summary=(await reads.summaries(wallet,[GANG_TOKEN_ADDRESS],scopeId))[GANG_TOKEN_ADDRESS];
  expect(summary.realizedProfitUsd).toBeNull();expect(summary.snapshot?.complete).toBe(false);expect(summary.snapshot?.reasons).toContain('accounting_policy_pending');
 });
 it('truthfully labels a shared accounting snapshot mixed when its canonical own-book facts include imported evidence',async()=>{
  const{reads,scopeId,query}=fixture('kol',true),summary=(await reads.summaries(wallet,[GANG_TOKEN_ADDRESS],scopeId))[GANG_TOKEN_ADDRESS];
  expect(summary.snapshot).toMatchObject({source:'mixed',complete:false});expect(summary.realizedProfitUsd).toBeNull();
  expect(query.mock.calls[0][0]).toContain('imported.provenance IS NOT NULL');expect(query.mock.calls[0][0]).toContain('imported.wallet_address=ANY(s.wallet_addresses)');
  expect(query.mock.calls[0][0]).toContain('imported.block_number>=s.starts_block');
 });
 it('hydrates only a validated public GANG history floor for snapshots and revision identities',async()=>{
  const ordinary=fixture('kol',true),historical=fixture('kol',true,true);
  const before=(await ordinary.reads.summaries(wallet,[GANG_TOKEN_ADDRESS],ordinary.scopeId))[GANG_TOKEN_ADDRESS];
  const after=(await historical.reads.summaries(wallet,[GANG_TOKEN_ADDRESS],historical.scopeId))[GANG_TOKEN_ADDRESS];
  expect(after.snapshot).toMatchObject({historyFrom:FRESH_GANG_CREATION_TIME,historyBoundary:'token_creation',source:'mixed'});
  expect(after.tracking?.fromBlock).toBe(String(FRESH_GANG_HISTORY_FROM_BLOCK));expect(after.snapshot?.snapshotId).not.toBe(before.snapshot?.snapshotId);
  expect(historical.query.mock.calls[0][0]).toContain('explicit_token_history');
  const privateFixture=fixture('portfolio_wallet',true,true),privateSummary=(await privateFixture.reads.summaries(wallet,[GANG_TOKEN_ADDRESS],privateFixture.scopeId))[GANG_TOKEN_ADDRESS];
  expect(privateSummary.snapshot?.historyFrom).toBe(new Date(now-120_000).toISOString());expect(privateFixture.query.mock.calls.some(([sql])=>sql.includes('SELECT key,value'))).toBe(false);
 });
});
