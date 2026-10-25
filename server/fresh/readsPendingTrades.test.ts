import{describe,it,expect,vi}from'vitest';
import type{Pool}from'pg';
import{createFreshReads,tradeIdentity}from'./reads.js';
import{freshPublicTradeScopeSql}from'./publicTokens.js';
import{GANG_TOKEN_ADDRESS}from'./tracking.js';
const wallet='0x'+'1'.repeat(40),token='0x'+'2'.repeat(40),timestamp='2026-10-25T12:00:00.000Z';
const row={id:'trade',wallet_address:wallet,token_address:token,kind:'sell',transaction_hash:'0x'+'a'.repeat(64),block_number:'101',occurred_at:timestamp,
 quantity:null,raw_quantity:'123456789012345678901234567890',amount_usd:null,quote_symbol:'BNB',quote_amount:'0.4',accounting_status:'pending_precision',event_realized_q:'99',cumulative_realized_q:'100'};
describe('visible pending trade reads',()=>{
 it('never formats raw units as normalized token amounts or partial profit',()=>{
  const trade=tradeIdentity(row);expect(trade).toMatchObject({id:'trade',side:'sell',tokenAmount:null,amountUsd:null,quoteAmount:'0.4',quoteSymbol:'BNB',realizedProfitUsd:null,
   cumulativeRealizedProfitUsd:null,valuationStatus:'unpriced',accountingStatus:'pending_precision'});
  expect(trade).not.toHaveProperty('raw_quantity');expect(trade).not.toHaveProperty('rawTokenAmount');expect(JSON.stringify(trade)).not.toContain(row.raw_quantity);
 });
 it('keeps verified quantity and settlement separate from unavailable P&L',()=>{
  expect(tradeIdentity({...row,quantity:'123',accounting_status:'pending_settlement',quote_amount:null})).toMatchObject({tokenAmount:'123',quoteAmount:null,amountUsd:null,realizedProfitUsd:null,accountingStatus:'pending_settlement'});
  expect(tradeIdentity({...row,quantity:'123',amount_usd:'20',accounting_status:'ready'})).toMatchObject({tokenAmount:'123',amountUsd:'20',realizedProfitUsd:'99',accountingStatus:'ready'});
  expect(tradeIdentity({...row,quantity:'123',amount_usd:'20',market_cap_usd:'314159.265',provenance:{source:'gmgn_history'},accounting_status:'ready'})).toMatchObject({marketCapUsd:'314159.265',source:'mixed'});
 });
 it('reads one deduplicated view under public role, own-book and confirmation boundaries',async()=>{
  const query=vi.fn().mockResolvedValue({rows:[row]}),reads=createFreshReads({query}as unknown as Pool,()=>Date.parse(timestamp),true);
  const page=await reads.trades({token});expect(page.items).toHaveLength(1);expect(page.items[0].tokenAmount).toBeNull();
  const[sql,args]=query.mock.calls[0];expect(sql).toContain('FROM fresh.visible_trades e');expect(sql).toContain(freshPublicTradeScopeSql('e'));
  expect(sql).toContain('LEFT JOIN fresh.scope_event_results');expect(sql).toContain("WHERE key='capture'");expect(args).toEqual([token,51]);
 });
 it('does not require a pending trade to have a financial result while enforcing private scope membership and start',async()=>{
  const query=vi.fn().mockResolvedValue({rows:[row]}),reads=createFreshReads({query}as unknown as Pool,()=>Date.parse(timestamp),true);
  await reads.trades({scopeId:'portfolio:account:wallet',wallet,token});const[sql,args]=query.mock.calls[0];
  expect(sql).toContain('JOIN fresh.accounting_scopes s ON s.id=$1 LEFT JOIN fresh.scope_event_results');
  for(const guard of['s.active','e.wallet_address=ANY(s.wallet_addresses)','e.block_number>=s.starts_block','e.occurred_at>=s.starts_at'])expect(sql).toContain(guard);
  expect(sql).toContain('public.journal_wallets membership');expect(sql).toContain('membership.registration_block');expect(sql).toContain('membership.activity_from');
  expect(sql).not.toContain('JOIN fresh.scope_event_results r ON r.event_id=e.id AND r.scope_id=s.id JOIN');
  expect(args).toEqual(['portfolio:account:wallet',wallet,token,51]);
 });
 it('returns an unavailable pending-only summary and selected activity without fabricating a position or dropping swaps',async()=>{
  const scope={id:'kol:'+wallet,kind:'kol',wallet_addresses:[wallet],starts_block:'100',starts_at:'2026-10-25T00:00:00.000Z',revision:'1',correction_epoch:'1'};
  const query=vi.fn(async(sql:string)=>{
   if(sql.startsWith('SELECT block_number::text,block_hash,value FROM fresh.checkpoints'))return{rows:[]};
   if(sql.includes('FROM fresh.positions p JOIN fresh.tokens'))return{rows:[]};
   if(sql.includes('FROM fresh.open_lots'))return{rows:[]};
   if(sql.includes('SELECT * FROM fresh.accounting_scopes'))return{rows:[scope]};
   if(sql.includes("key IN('start','capture'"))return{rows:[{key:'capture',block_number:'200',block_hash:'0x'+'a'.repeat(64)}]};
   if(sql.startsWith('SELECT t.*,to_jsonb(s)'))return{rows:[{address:GANG_TOKEN_ADDRESS,name:'Gang',symbol:'GANG',launch_status:'preexisting',valuation_status:'pending',pending_scope:scope,pending_reason:'historical_precision_unavailable'}]};
   if(sql.startsWith('SELECT * FROM published_kols'))return{rows:[{address:wallet,display_name:'Gaoda',is_tracked:true}]};
   if(sql.includes('FROM fresh.visible_trades e'))return{rows:[{...row,token_address:GANG_TOKEN_ADDRESS},{...row,id:'trade2',token_address:GANG_TOKEN_ADDRESS}]};
   throw Error('Unexpected pending-only read');
  });
  const reads=createFreshReads({query}as unknown as Pool,()=>Date.parse(timestamp),true),summary=(await reads.summaries(wallet,[GANG_TOKEN_ADDRESS]))[GANG_TOKEN_ADDRESS];
  expect(summary).toMatchObject({status:'unavailable',position:'unknown',realizedProfitUsd:null,remainingTokenAmount:null,reason:'historical_precision_unavailable',snapshot:{complete:false}});
  const activity=await reads.activity(wallet,GANG_TOKEN_ADDRESS,'kol:'+wallet,true);
  expect(activity?.trades).toHaveLength(2);expect(activity).toMatchObject({summary:{realizedProfitUsd:null,remainingTokenAmount:null,status:'unknown'},
   realizedAccounting:{status:'unavailable',realizedProfitUsd:null},accountingSnapshot:{complete:false,reasons:['historical_precision_unavailable','unknown_costs']},
   replayAccounting:{status:'unavailable',events:[],final:null},coverage:{complete:false,returnedTradeCount:2}});
  expect(query.mock.calls.some(([sql])=>sql.includes('FROM fresh.financial_events e JOIN fresh.scope_event_results'))).toBe(false);
 });
 it('preserves pending visible swaps and hides the partial realized subtotal in selected replay mode',async()=>{
  const scope={id:'kol:'+wallet,kind:'kol',wallet_addresses:[wallet],starts_block:'100',starts_at:'2026-10-25T00:00:00.000Z',revision:'1',correction_epoch:'1'};
  const position={scope_id:scope.id,token_address:token,address:token,launch_status:'eligible',quantity_q:'1',invested_q:'1',sold_q:'100',incoming_q:'0',outgoing_q:'0',fees_q:'0',capital_q:'1',realized_q:'99',
   unknown_cost:false,unknown_fee:false,unknown_incoming_value:false,last_event_id:'trade',last_event_at:timestamp,last_event_block:'101',position_revision:'1',revision:'1',valuation_status:'pending',
   balance_status:'pending',wallet_gap:false,decoding_pending:true,pending_precision:true,registration_pending:false};
  const query=vi.fn(async(sql:string)=>{
   if(sql.includes('FROM fresh.positions p JOIN fresh.tokens'))return{rows:[position]};if(sql.includes('FROM fresh.open_lots'))return{rows:[]};
   if(sql.includes('SELECT * FROM fresh.accounting_scopes'))return{rows:[scope]};if(sql.includes("key IN('start','capture'"))return{rows:[{key:'capture',block_number:'200'}]};
   if(sql.startsWith('SELECT * FROM published_kols'))return{rows:[{address:wallet,is_tracked:true}]};
   if(sql.startsWith('SELECT count(*) FILTER'))return{rows:[{buys:1,sells:1,valued_buys:0,valued_sells:1,unpriced:1,first_at:timestamp,last_at:timestamp}]};
   if(sql.includes('FROM fresh.visible_trades e'))return{rows:[row,{...row,id:'trade2'}]};throw Error('Unexpected blocked export query');
  });
  const activity=await createFreshReads({query}as unknown as Pool,()=>Date.parse(timestamp),true).activity(wallet,token,'kol:'+wallet,true);
  expect(activity?.trades).toHaveLength(2);expect(activity?.summary.realizedProfitUsd).toBeNull();expect(activity?.realizedAccounting?.realizedProfitUsd).toBeNull();
  expect(activity?.coverage.complete).toBe(false);expect(activity?.replayAccounting?.final).toBeNull();
  expect(activity?.accountingSnapshot?.reasons).toContain('historical_precision_unavailable');
  expect(query.mock.calls.some(([sql])=>sql.includes('FROM fresh.financial_events e JOIN fresh.scope_event_results'))).toBe(false);
 });
});
