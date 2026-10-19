let requestId = 0;
export interface RpcBatchRequest {method:string;params:unknown[]}
export type Rpc = (<T>(method: string, params: unknown[]) => Promise<T>) & {
  batch?:(requests:RpcBatchRequest[])=>Promise<PromiseSettledResult<unknown>[]>;
};
export const chainRpc: Rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
  const response = await fetch(process.env.BSC_RPC_HTTP || 'http://127.0.0.1:8545', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`RPC ${method} returned ${response.status}`);
  const body = await response.json() as { result?: T; error?: { message: string } };
  if (body.error || body.result == null) throw new Error(`RPC ${method} unavailable`);
  return body.result;
};
/** Batches are an optional transport optimization. Injected single-call RPCs
 * retain compatibility and each failed element stays independent. */
export async function rpcBatch<T>(rpc:Rpc,requests:RpcBatchRequest[]):Promise<PromiseSettledResult<T>[]> {
  const results:PromiseSettledResult<T>[]=[];
  for(let offset=0;offset<requests.length;offset+=32){const page=requests.slice(offset,offset+32);
    if(rpc.batch)results.push(...await rpc.batch(page) as PromiseSettledResult<T>[]);
    else results.push(...await Promise.allSettled(page.map(request=>rpc<T>(request.method,request.params))));
  }
  return results;
}
chainRpc.batch=async requests=>{
  if(requests.length>32)throw new Error('RPC batch too large');
  if(!requests.length)return [];
  const items=requests.map(request=>({jsonrpc:'2.0',id:++requestId,method:request.method,params:request.params}));
  try {
    const response=await fetch(process.env.BSC_RPC_HTTP||'http://127.0.0.1:8545',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(items),signal:AbortSignal.timeout(15000),
    });
    if(!response.ok)throw new Error('RPC batch unavailable');
    const body:unknown=await response.json();if(!Array.isArray(body))throw new Error('RPC batch invalid response');
    const expected=new Set(items.map(item=>item.id)),byId=new Map<number,Record<string,unknown>[]>();
    for(const value of body){
      if(!value||typeof value!=='object')continue;
      const row=value as Record<string,unknown>;
      // Foreign IDs cannot satisfy or overwrite any requested element.
      if(typeof row.id!=='number'||!Number.isSafeInteger(row.id)||!expected.has(row.id))continue;
      const records=byId.get(row.id)??[];records.push(row);byId.set(row.id,records);
    }
    return items.map(item=>{
      const rows=byId.get(item.id);
      const reason=!rows?'RPC batch missing response':rows.length!==1?'RPC batch duplicate response'
        :rows[0].jsonrpc!=='2.0'||rows[0].error!=null||rows[0].result==null?'RPC batch element unavailable':null;
      return reason?{status:'rejected' as const,reason:new Error(reason)}:{status:'fulfilled' as const,value:rows![0].result};
    });
  }catch{
    return items.map(()=>({status:'rejected' as const,reason:new Error('RPC batch unavailable')}));
  }
};
export const blockHex = (block: number | string) => `0x${BigInt(block).toString(16)}`;
