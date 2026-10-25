import {afterEach,describe,expect,it,vi}from'vitest';
import {chainRpc,rpcBatch,RpcRequestError,type Rpc}from'./rpc.js';
const requests=(count:number)=>Array.from({length:count},(_,index)=>({method:'eth_call',params:[{to:`contract-${index}`},{blockHash:'canonical',requireCanonical:true}]}));
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
const sensitive='https://private-provider.invalid/secret-key';
const safeError=(error:unknown,message:string,category:string,code:number|null=null)=>{
  expect(error).toBeInstanceOf(RpcRequestError);
  expect(error).toMatchObject({message,category,code});
  expect(JSON.stringify(error)).not.toContain(sensitive);
  expect(String(error)).not.toContain(sensitive);
  expect((error as Error).cause).toBeUndefined();
};
describe('sanitized RPC diagnostics',()=>{
  it.each([
    [-32000,'not supported','state_unavailable'],
    [-32000,'missing trie node','state_unavailable'],
    [-32001,'header not found','state_unavailable'],
    [-32000,'state is unavailable','state_unavailable'],
    [3,'execution failed','revert'],
    [-32000,'execution reverted','revert'],
    [-32005,'request rejected','rate_limit'],
    [-32000,'rate limit reached','rate_limit'],
    [-32603,'something else','rpc_error'],
  ])('classifies provider error %s %s without retaining provider text',async(code,message,category)=>{
    const fetchMock=vi.fn(async(_url,options)=>({ok:true,json:async()=>({jsonrpc:'2.0',id:JSON.parse(options.body).id,error:{code,message:`${message} ${sensitive}`,data:{secret:sensitive}}})}));
    vi.stubGlobal('fetch',fetchMock);
    const error=await chainRpc('eth_call',[]).catch(error=>error);
    safeError(error,'RPC eth_call unavailable',category,code as number);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveProperty('data');expect(error).not.toHaveProperty('response');
  });
  it.each([429,500,503,403])('classifies HTTP %s and preserves its established message',async status=>{
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,status,json:async()=>{throw Error(sensitive);}})));
    const error=await chainRpc('eth_call',[]).catch(error=>error);
    safeError(error,`RPC eth_call returned ${status}`,status===429?'rate_limit':status>=500?'transport':'rpc_error');
    expect((error as RpcRequestError).httpStatus).toBe(status);
  });
  it('sanitizes network failures and timeouts without a transport retry',async()=>{
    const fetchMock=vi.fn(async()=>{throw new Error(sensitive,{cause:new Error(sensitive)});});
    vi.stubGlobal('fetch',fetchMock);vi.stubEnv('BSC_RPC_HTTP',sensitive);
    safeError(await chainRpc('eth_call',[]).catch(error=>error),'RPC eth_call unavailable','transport');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(['json',null,[],{},'string','wrong-id','wrong-version','null-result'])('rejects invalid %s without response leakage',async mode=>{
    vi.stubGlobal('fetch',vi.fn(async(_url,options)=>({ok:true,json:async()=>{
      if(mode==='json')throw Error(sensitive);
      const id=JSON.parse(options.body).id;
      if(mode==='wrong-id')return {jsonrpc:'2.0',id:id+1,result:sensitive};
      if(mode==='wrong-version')return {jsonrpc:'1.0',id,result:sensitive};
      if(mode==='null-result')return {jsonrpc:'2.0',id,result:null};
      return mode;
    }})));
    safeError(await chainRpc('eth_call',[]).catch(error=>error),'RPC eth_call unavailable','invalid_response');
  });
  it.each([NaN,Infinity,2147483648,-2147483649,1.5,'-32000',null])('does not retain unsafe provider code %s',async code=>{
    vi.stubGlobal('fetch',vi.fn(async(_url,options)=>({ok:true,json:async()=>({jsonrpc:'2.0',id:JSON.parse(options.body).id,error:{code,message:sensitive}})})));
    safeError(await chainRpc('eth_call',[]).catch(error=>error),'RPC eth_call unavailable','rpc_error');
  });
  it('accepts valid zero/false results and validates safe diagnostic properties',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(_url,options)=>({ok:true,json:async()=>({jsonrpc:'2.0',id:JSON.parse(options.body).id,result:false})})));
    expect(await chainRpc('eth_call',[])).toBe(false);
    expect(new RpcRequestError('safe','rpc_error',{code:-2147483648,httpStatus:NaN})).toMatchObject({code:-2147483648});
    expect(new RpcRequestError('safe','rpc_error',{code:2147483647,httpStatus:1000})).not.toHaveProperty('httpStatus');
  });
  it('retains independent safe categories and messages within one batch',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{
      const items=JSON.parse(options.body);
      return {ok:true,json:async()=>[
        {jsonrpc:'2.0',id:items[0].id,error:{code:-32000,message:`not supported ${sensitive}`}},
        {jsonrpc:'2.0',id:items[1].id,error:{code:-32005,message:sensitive}},
        {jsonrpc:'2.0',id:items[2].id,result:null},
      ]};
    }));
    const result=await rpcBatch(chainRpc,requests(3));
    for(const[index,category,code]of [[0,'state_unavailable',-32000],[1,'rate_limit',-32005],[2,'invalid_response',null]]as const){
      const row=result[index];expect(row.status).toBe('rejected');
      if(row.status==='rejected')safeError(row.reason,'RPC batch element unavailable',category,code);
    }
  });
  it.each(['network','json',429,503])('sanitizes complete batch failure %s',async mode=>{
    vi.stubGlobal('fetch',vi.fn(async()=>{
      if(mode==='network')throw Error(sensitive);
      return {ok:typeof mode==='string',status:mode,json:async()=>{throw Error(sensitive);}};
    }));
    const result=await rpcBatch(chainRpc,requests(2));
    for(const row of result){expect(row.status).toBe('rejected');if(row.status==='rejected'){
      safeError(row.reason,'RPC batch unavailable',mode==='json'?'invalid_response':mode===429?'rate_limit':'transport');
    }}
  });
});
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
