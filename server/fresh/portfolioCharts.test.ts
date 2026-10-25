import Fastify from 'fastify';
import type { Pool } from 'pg';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { registerFreshPortfolio } from './portfolio.js';
import type { FreshServices } from './services.js';
import { FreshChartError,type FreshCharts } from './charts.js';
const apps:ReturnType<typeof Fastify>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
async function fixture(){
  const now=Date.parse('2026-10-21T12:00:00Z'),wallet='0x'+'1'.repeat(40),token='0x'+'2'.repeat(40),user='33333333-3333-4333-8333-333333333333';
  let member=true;
  const row={address:token,launched_at:new Date(now-200*86400_000) as Date|null,decimals:18,total_supply_raw:'1000000000000000000000',price_usd:'4',observed_at:new Date(now)};
  const db={query:vi.fn(async(sql:string)=>{
    if(sql.startsWith('SELECT * FROM public.journal_wallets'))return{rows:member?[{wallet_address:wallet,revision:'44444444-4444-4444-8444-444444444444'}]:[]};
    if(sql.includes('FROM fresh.positions p JOIN fresh.tokens'))return{rows:[row]};
    throw Error('Unexpected chart fixture query');
  })}as unknown as Pool;
  const chart=vi.fn(async(address:string,options:Parameters<FreshCharts['chart']>[1])=>({address,period:options.period!,resolution:options.resolution!,source:'gmgn' as const,points:[],candles:[],pending:false,stale:false,updatedAt:new Date(now).toISOString(),historyComplete:true}));
  const app=Fastify();apps.push(app);registerFreshPortfolio(app,{db,reads:{}as FreshServices['reads'],replay:{}as FreshServices['replay'],now:()=>now,charts:{chart},resolveUser:async()=>({id:user,name:'Private fixture',username:null,avatarUrl:null})});await app.ready();
  return{app,wallet,token,row,chart,url:`/api/journal/wallets/${wallet}/tokens/${token}/chart`,revoke:()=>{member=false;}};
}
describe('authorized Portfolio chart request contracts',()=>{
  it.each([['24h',86400_000],['7d',7*86400_000],['30d',30*86400_000]])('uses the precise %s calendar window',async(period,duration)=>{
    const{app,url,chart}=await fixture();const response=await app.inject(`${url}?period=${period}`);
    expect(response.statusCode).toBe(200);expect(response.json().period).toBe(period);
    const options=chart.mock.calls[0][1];expect(options.to-options.from).toBe(duration);expect(options.workload).toBe('browse');
  });
  it('retains interval lifetime pagination and independent replay queue selection',async()=>{
    const{app,url,chart}=await fixture();const response=await app.inject(`${url}?interval=1m&history=full&workload=replay`);
    expect(response.json()).toMatchObject({period:'1m',fullHistory:true,historyComplete:false,historyPending:true});
    const options=chart.mock.calls[0][1];expect(options.to-options.from).toBe(1000*60_000);expect(options).toMatchObject({workload:'replay',foreground:true});
  });
  it('keeps unknown creation explicit in a private bounded chart and still enforces membership',async()=>{
    const{app,url,row,chart,revoke}=await fixture();row.launched_at=null;
    const response=await app.inject(`${url}?interval=1m&history=full`);
    expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({fullHistory:true,historyComplete:false,historyPending:false,historyLoadStatus:'limited',historyRecoveryPending:false,historyRecoveryReason:'token_creation_unknown'});
    expect(response.json().historyBefore).toBeUndefined();expect(chart.mock.calls[0][1].to-chart.mock.calls[0][1].from).toBe(1000*60_000);
    revoke();expect((await app.inject(`${url}?interval=1m&history=full`)).statusCode).toBe(404);expect(chart).toHaveBeenCalledOnce();
  });
  it('preserves period identity on a provider cooldown and still rechecks private membership',async()=>{
    const{app,url,chart,revoke}=await fixture();chart.mockRejectedValue(new FreshChartError('provider_cooldown',60_000));
    const response=await app.inject(`${url}?period=7d`);expect(response.json()).toMatchObject({period:'7d',pending:true,loadStatus:'rate_limited',retryAfterMs:60_000});
    revoke();expect((await app.inject(`${url}?period=7d`)).statusCode).toBe(404);expect(chart).toHaveBeenCalledOnce();
  });
});
