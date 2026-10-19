import{afterEach,describe,expect,it,vi}from'vitest';
import{api}from'./lib';
afterEach(()=>vi.unstubAllGlobals());
describe('live API reads',()=>{
  it('bypasses cached API responses and redirects while retaining JSON negotiation',async()=>{
    const payload={items:[{id:'confirmed-trade'}]},fetcher=vi.fn().mockResolvedValue(Response.json(payload));vi.stubGlobal('fetch',fetcher);
    expect(await api('/api/trades?limit=10')).toEqual(payload);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/trades?limit=10',{cache:'no-store',headers:{Accept:'application/json'}});
  });
  it('retains HTTP error handling for uncached requests',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({error:'unavailable'},{status:503})));
    await expect(api('/api/trades?limit=10')).rejects.toThrow('Request failed (503)');
  });
  it('forwards hook cancellation without changing live cache or JSON options',async()=>{
    const controller=new AbortController(),fetcher=vi.fn().mockResolvedValue(Response.json({items:[]}));vi.stubGlobal('fetch',fetcher);
    await api('/api/overview',{signal:controller.signal});
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/overview',{cache:'no-store',headers:{Accept:'application/json'},signal:controller.signal});
  });
});
