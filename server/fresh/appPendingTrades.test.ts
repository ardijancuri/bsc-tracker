import{describe,it,expect,vi}from'vitest';
import type{Pool}from'pg';
import{createFreshApp}from'./app.js';
import type{FreshServices}from'./services.js';
import{GANG_TOKEN_ADDRESS}from'./tracking.js';
describe('selected token pending swap visibility',()=>{
 it('lists participating public traders without requiring a position and keeps detail/market counts consistent',async()=>{
  const identities=Array.from({length:5},(_,i)=>({address:'0x'+String(i+1).repeat(40),display_name:'KOL '+i,is_tracked:true}));
  const row={address:GANG_TOKEN_ADDRESS,name:'Gang',symbol:'GANG',launch_status:'preexisting',valuation_status:'ready',price_usd:'0.01',market_cap_usd:'1000000',
   today_kol_count:3,today_buy_count:0,today_sell_count:3,today_volume_q:'30'};
  const counts={today_kol_count:5,today_buy_count:3,today_sell_count:7,today_volume_q:'30'};
  const query=vi.fn(async(sql:string)=>{
   if(sql.startsWith('INSERT INTO fresh.jobs'))return{rows:[]};
   if(sql.startsWith('SELECT t.*,t.today_utc'))return{rows:[row]};
   if(sql.startsWith('SELECT p.* FROM published_kols'))return{rows:identities};
   if(sql.startsWith('SELECT count(DISTINCT e.wallet_address)'))return{rows:[counts]};
   throw Error('Unexpected selected-token query');
  });
  const trades=vi.fn(async()=>({items:Array.from({length:10},(_,i)=>({id:'swap'+i,tokenAmount:null,amountUsd:null,accountingStatus:'pending_precision'})),nextCursor:null}));
  const summaries=vi.fn(async()=>({[GANG_TOKEN_ADDRESS]:{status:'unavailable',remainingTokenAmount:null,realizedProfitUsd:null,reason:'historical_precision_unavailable'}}));
  const services={reads:{trades,summaries},charts:{},replay:{},cache:{}}as unknown as FreshServices;
  const{app}=await createFreshApp({query}as unknown as Pool,{services});try{
   const detail=await app.inject('/api/tokens/'+GANG_TOKEN_ADDRESS);expect(detail.statusCode).toBe(200);
   expect(detail.json()).toMatchObject({token:{kolCount24h:5,buys24h:3,sells24h:7,volume24hUsd:'30'},kols:identities.map(k=>({address:k.address,name:k.display_name}))});
   expect(detail.json().trades).toHaveLength(10);
   const participants=query.mock.calls.find(([sql])=>sql.startsWith('SELECT p.* FROM published_kols'))![0];
   expect(participants).toContain('fresh.visible_trades trader_event');expect(participants).not.toContain('fresh.positions');
   expect(participants).toContain('public_trade_scope.starts_block');expect(participants).toContain('public_trade_wallet.active');
   const market=await app.inject('/api/tokens/'+GANG_TOKEN_ADDRESS+'/market');expect(market.statusCode).toBe(200);
   expect(market.json().token).toMatchObject({kolCount24h:5,periodKolCount:5,buys24h:3,sells24h:7,periodVolumeUsd:'30'});
   const cards=await app.inject('/api/kols/'+identities[0].address+'/tokens');expect(cards.statusCode).toBe(200);
   expect(cards.json().items[0]).toMatchObject({address:GANG_TOKEN_ADDRESS,accountingSummary:{status:'unavailable',remainingTokenAmount:null,realizedProfitUsd:null}});
   const cardQuery=query.mock.calls.filter(([sql])=>sql.startsWith('SELECT t.*,t.today_utc')).at(-1)![0];
   expect(cardQuery).toContain('fresh.visible_trades e');expect(cardQuery).not.toContain('fresh.positions');
   expect(row.today_kol_count).toBe(3);expect(row.today_sell_count).toBe(3);
   const sql=query.mock.calls.find(([sql])=>sql.startsWith('SELECT count(DISTINCT e.wallet_address)'))![0];
   expect(sql).toContain('FROM fresh.visible_trades e');expect(sql).not.toContain('realized');
  }finally{await app.close();}
 });
});
