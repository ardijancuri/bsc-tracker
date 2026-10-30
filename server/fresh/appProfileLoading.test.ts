import{describe,it,expect,vi}from'vitest';import type{Pool}from'pg';import{createFreshApp}from'./app.js';import type{FreshServices}from'./services.js';
const wallet='0x'+'1'.repeat(40),from='2026-10-29T10:00:00.000Z',to='2026-10-30T10:00:00.000Z';
async function fixture(delayed=false){
 const row={address:wallet,rank:3,realizedProfitUsd:'123.45',tradeCount24h:4,buyCount24h:2,sellCount24h:2,accounting:{complete:true}},frame={kol:row,period:'24h',windowStart:from,windowEnd:to,utcDay:'2026-10-30',trackingBoundary:'129627586'};
 let release!:(v:{rows:unknown[]})=>void;
 const query=vi.fn(async()=>delayed?await new Promise<{rows:unknown[]}>(r=>release=r):{rows:[]});
 const reads={kol:vi.fn(async()=>frame),leaderboard:vi.fn(async()=>({...frame,kol:undefined,items:[row]})),summaries:vi.fn(async()=>({})),trades:vi.fn(async()=>({items:[{id:'recorded-trade'}],nextCursor:'cursor'}))};
 const{app}=await createFreshApp({query}as unknown as Pool,{services:{reads,charts:{},replay:{},cache:{}}as unknown as FreshServices});
 return{app,reads,query,frame,row,release:()=>release({rows:[]})};
}
describe('KOL profile uses shared public metrics without a full leaderboard HTTP assembly',()=>{
 it('preserves rank, stored P&L, counters, cursors and the exact trade window',async()=>{const f=await fixture();try{const r=await f.app.inject('/api/kols/'+wallet);expect(r.statusCode).toBe(200);expect(r.json()).toEqual({kol:f.row,stats:f.row,trades:[{id:'recorded-trade'}],tradesNextCursor:'cursor',tradeCount24h:4,buyCount24h:2,sellCount24h:2,tokens:[],tokensNextCursor:null,period:'24h',windowStart:from,windowEnd:to,utcDay:'2026-10-30',trackingBoundary:'129627586'});expect(f.reads.leaderboard).not.toHaveBeenCalled();expect(f.reads.trades).toHaveBeenCalledWith({wallet,limit:10,window:'24h',windowStart:from,windowEnd:to});}finally{await f.app.close();}});
 it('starts recent trades while token summaries are still loading',async()=>{const f=await fixture(true);try{const request=f.app.inject('/api/kols/'+wallet);const done=request.then(r=>r);await vi.waitFor(()=>expect(f.reads.trades).toHaveBeenCalledTimes(1));expect(f.reads.summaries).not.toHaveBeenCalled();f.release();expect((await done).statusCode).toBe(200);}finally{await f.app.close();}});
 it('keeps invalid wallet addresses rejected before reads',async()=>{const f=await fixture();try{expect((await f.app.inject('/api/kols/invalid')).statusCode).toBe(400);expect(f.reads.kol).not.toHaveBeenCalled();}finally{await f.app.close();}});
});
