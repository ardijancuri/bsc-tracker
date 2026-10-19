import {afterEach,describe,expect,it,vi}from'vitest';
import {chainRpc,rpcBatch,type Rpc}from'./rpc.js';
const requests=(count:number)=>Array.from({length:count},(_,index)=>({method:'eth_call',params:[{to:`contract-${index}`},{blockHash:'canonical',requireCanonical:true}]}));
afterEach(()=>vi.unstubAllGlobals());
describe('bounded JSON-RPC batches',()=>{
  it('matches out-of-order responses by exact ID',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{
      const items=JSON.parse(options.body);expect(items).toHaveLength(3);expect(options.signal).toBeInstanceOf(AbortSignal);
      return {ok:true,json:async()=>items.toReversed().map((item:any)=>({jsonrpc:'2.0',id:item.id,result:item.params[0].to}))};
    }));
    expect(await rpcBatch(chainRpc,requests(3))).toEqual(['contract-0','contract-1','contract-2'].map(value=>({status:'fulfilled',value})));
  });
  it('isolates duplicate, missing, foreign and provider-error elements',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{
      const items=JSON.parse(options.body);
      return {ok:true,json:async()=>[
        {jsonrpc:'2.0',id:items[0].id,result:'duplicate-a'},{jsonrpc:'2.0',id:items[0].id,result:'duplicate-b'},
        {jsonrpc:'2.0',id:items[2].id,error:{message:'provider-secret-must-not-escape'}},
        {jsonrpc:'2.0',id:items[3].id,result:null},{jsonrpc:'2.0',id:items[4].id,result:'valid'},
        {jsonrpc:'2.0',id:items[1].id.toString(),result:'wrong-type'},
        {jsonrpc:'2.0',id:-123456789,result:'foreign'},
      ]};
    }));
    const results=await rpcBatch(chainRpc,requests(5));
    expect(results.map(row=>row.status)).toEqual(['rejected','rejected','rejected','rejected','fulfilled']);
    expect(results[4]).toEqual({status:'fulfilled',value:'valid'});
    expect(results.slice(0,4).map(row=>row.status==='rejected'?row.reason.message:'')).toEqual([
      'RPC batch duplicate response','RPC batch missing response','RPC batch element unavailable','RPC batch element unavailable']);
  });
  it('bounds each wire batch at32 and keeps injection compatible',async()=>{
    const pages:number[]=[];
    const rpc:Rpc=async<T>()=>'single' as T;
    rpc.batch=async entries=>{pages.push(entries.length);return entries.map(()=>({status:'fulfilled',value:'batch'}));};
    expect(await rpcBatch(rpc,requests(65))).toHaveLength(65);expect(pages).toEqual([32,32,1]);
    const injected:Rpc=async<T>(_method:string,params:unknown[])=>{if((params[0]as any).to==='contract-1')throw Error('one failure');return 'single' as T;};
    expect((await rpcBatch(injected,requests(3))).map(row=>row.status)).toEqual(['fulfilled','rejected','fulfilled']);
    await expect(chainRpc.batch!(requests(33))).rejects.toThrow('RPC batch too large');
  });
  it.each([null,{},'invalid'])('rejects malformed envelopes without leaking response data',async body=>{
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>body})));
    const result=await rpcBatch(chainRpc,requests(2));
    expect(result).toHaveLength(2);expect(result.every(row=>row.status==='rejected'&&row.reason.message==='RPC batch unavailable')).toBe(true);
  });
});
