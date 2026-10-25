import {describe,it,expect,vi} from 'vitest';
import type {Pool} from 'pg';
import {freshTokenDirectoryWindow,freshTokenDirectoryWindowMs,readFreshTokenDirectory,freshTokenDirectoryIdentity} from './tokenDirectory.js';
import {freshTrackedEventSql} from './tracking.js';

describe('rolling public token directory',()=>{
  const now=Date.parse('2026-10-24T12:00:00.000Z');
  it('uses a request-time rolling eight-hour window, including across UTC midnight',()=>{
    expect(freshTokenDirectoryWindow(now)).toEqual({windowStart:'2026-10-24T04:00:00.000Z',windowEnd:'2026-10-24T12:00:00.000Z',windowHours:8});
    expect(freshTokenDirectoryWindow(now+1).windowStart).toBe('2026-10-24T04:00:00.001Z');
    expect(freshTokenDirectoryWindow(Date.parse('2026-10-24T01:00:00Z')).windowStart).toBe('2026-10-23T17:00:00.000Z');
    expect(freshTokenDirectoryWindowMs).toBe(28_800_000);expect(()=>freshTokenDirectoryWindow(NaN)).toThrow();
  });
  it('shares one page/count query and sorts by actual public activity',async()=>{
    const query=vi.fn().mockResolvedValueOnce({rows:[{address:'token',last_public_trade_at:'2026-10-24T11:00:00Z',last_trade_at:'2026-10-24T12:00:00Z',total:2},
      {address:'next',last_public_trade_at:'2026-10-24T10:00:00Z',total:2}]});
    const result=await readFreshTokenDirectory({query} as unknown as Pool,{now,limit:1});
    expect(result).toMatchObject({total:2,nextOffset:1,nextCursor:'1',windowHours:8});expect(result.items[0].lastTradeAt).toBe('2026-10-24T11:00:00.000Z');
    expect(query).toHaveBeenCalledTimes(1);const [sql,args]=query.mock.calls[0];
    expect(args).toEqual(['2026-10-24T04:00:00.000Z','2026-10-24T12:00:00.000Z',2,0]);
    expect(sql).toContain('totals.total');expect(sql).toContain('LEFT JOIN LATERAL');expect(sql).toContain("e.kind IN('buy','sell')");
    expect(sql).toContain('b.block_hash=e.block_hash');expect(sql).toContain('tracked.is_tracked');expect(sql).not.toContain('e.observed_live');
    expect(sql).toContain(freshTrackedEventSql('e','directory_token'));
    expect(sql).toContain("t.valuation_status<>'no_liquidity'");
  });
  it('retains the total on an offset beyond the final page',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[{address:null,total:3}]});
    expect(await readFreshTokenDirectory({query} as unknown as Pool,{now,offset:500})).toMatchObject({items:[],total:3,nextOffset:null,nextCursor:null});
  });
  it('uses the same exact window for recent-trade previews',async()=>{
    const query=vi.fn().mockResolvedValueOnce({rows:[{address:'token',last_public_trade_at:'2026-10-24T11:00:00Z',total:1}]}).mockResolvedValueOnce({rows:[]});
    await readFreshTokenDirectory({query} as unknown as Pool,{now,withTrades:true});
    const [sql,args]=query.mock.calls[1];expect(args).toEqual(['2026-10-24T04:00:00.000Z','2026-10-24T12:00:00.000Z',['token']]);
    expect(sql).toContain('e.occurred_at>=$1::timestamptz');expect(sql).toContain('e.occurred_at<=$2::timestamptz');expect(sql).toContain('LIMIT 5');
    expect(sql).toContain('b.block_hash=e.block_hash');expect(sql).not.toContain('e.observed_live');
    expect(sql).toContain(freshTrackedEventSql('e','directory_token'));
    expect(sql).toContain('ORDER BY candidate.address,e.occurred_at DESC,e.id DESC');
  });
  it('normalizes non-finite pagination without passing invalid PostgreSQL limits',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[{address:null,total:0}]});await readFreshTokenDirectory({query} as unknown as Pool,{now,limit:Infinity,offset:NaN});
    expect(query.mock.calls[0][1].slice(2)).toEqual([151,0]);
  });
  it('exposes only fresh positive ready quotes while preserving stored observations',()=>{
    const row={address:'token',valuation_status:'ready',observed_at:new Date(now-120_000),price_usd:'0.000001',market_cap_usd:'1000',last_public_trade_at:new Date(now)};
    expect(freshTokenDirectoryIdentity(row,now)).toMatchObject({priceUsd:'0.000001',marketCapUsd:'1000',valuationStatus:'ready'});
    for(const change of[{observed_at:new Date(now-120_001)},{observed_at:new Date(now+1)},{observed_at:null},
      {valuation_status:'quote_unavailable'},{valuation_status:'pending'},{market_cap_usd:'0'},{price_usd:'-1'},{price_usd:'invalid'}]){
      expect(freshTokenDirectoryIdentity({...row,...change},now)).toMatchObject({priceUsd:null,marketCapUsd:null});
    }
    expect(row).toMatchObject({price_usd:'0.000001',market_cap_usd:'1000',valuation_status:'ready'});
  });
});
