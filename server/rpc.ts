let requestId = 0;
export type RpcErrorCategory = 'state_unavailable' | 'revert' | 'rate_limit' | 'transport' | 'invalid_response' | 'rpc_error';
/** Only sanitized diagnostics survive the transport boundary. Provider text,
 * request parameters and nested causes must never be attached to this error. */
export class RpcRequestError extends Error {
  readonly category: RpcErrorCategory;
  readonly code: number | null;
  declare readonly httpStatus?: number;
  /** A valid matching JSON-RPC envelope explicitly returned null. This never
   * marks malformed, missing, foreign-ID or failed transport responses. */
  declare readonly nullResult?: true;
  constructor(message: string, category: RpcErrorCategory, options: {code?: unknown; httpStatus?: unknown; nullResult?: unknown} = {}) {
    super(message);
    this.name = 'RpcRequestError';
    this.category = category;
    this.code = typeof options.code === 'number' && Number.isSafeInteger(options.code)
      && options.code >= -2147483648 && options.code <= 2147483647 ? options.code : null;
    if (typeof options.httpStatus === 'number' && Number.isInteger(options.httpStatus)
      && options.httpStatus >= 100 && options.httpStatus <= 599) this.httpStatus = options.httpStatus;
    if (options.nullResult === true) this.nullResult = true;
  }
}
function providerFailure(message: string, value: unknown): RpcRequestError {
  const error = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const text = typeof error.message === 'string' ? error.message : '';
  const code = error.code;
  const category: RpcErrorCategory = code === -32005 || /rate.?limit|too many requests|quota exceeded/i.test(text) ? 'rate_limit'
    : /not supported|missing trie|header not found|state (?:is )?(?:unavailable|not available)|historical state/i.test(text) ? 'state_unavailable'
      : code === 3 || /revert/i.test(text) ? 'revert' : 'rpc_error';
  return new RpcRequestError(message, category, {code});
}
function httpFailure(message: string, status: number): RpcRequestError {
  return new RpcRequestError(message, status === 429 ? 'rate_limit' : status >= 500 && status <= 599 ? 'transport' : 'rpc_error', {httpStatus: status});
}
export interface RpcBatchRequest {method:string;params:unknown[]}
export type Rpc = (<T>(method: string, params: unknown[]) => Promise<T>) & {
  batch?:(requests:RpcBatchRequest[])=>Promise<PromiseSettledResult<unknown>[]>;
};
export const chainRpc: Rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
  const id = ++requestId;
  let response: Response;
  try {
    response = await fetch(process.env.BSC_RPC_HTTP || 'http://127.0.0.1:8545', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(15000),
    });
  } catch { throw new RpcRequestError(`RPC ${method} unavailable`, 'transport'); }
  if (!response.ok) throw httpFailure(`RPC ${method} returned ${response.status}`, response.status);
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new RpcRequestError(`RPC ${method} unavailable`, 'invalid_response'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RpcRequestError(`RPC ${method} unavailable`, 'invalid_response');
  const body = value as Record<string, unknown>;
  if (body.jsonrpc !== '2.0' || body.id !== id) throw new RpcRequestError(`RPC ${method} unavailable`, 'invalid_response');
  if (body.error != null) throw providerFailure(`RPC ${method} unavailable`, body.error);
  if (body.result == null) throw new RpcRequestError(`RPC ${method} unavailable`, 'invalid_response', {nullResult:body.result===null});
  return body.result as T;
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
  if(requests.length>32)throw new RpcRequestError('RPC batch too large','rpc_error');
  if(!requests.length)return [];
  const items=requests.map(request=>({jsonrpc:'2.0',id:++requestId,method:request.method,params:request.params}));
  try {
    const response=await fetch(process.env.BSC_RPC_HTTP||'http://127.0.0.1:8545',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(items),signal:AbortSignal.timeout(15000),
    });
    if(!response.ok)throw httpFailure('RPC batch unavailable',response.status);
    let body:unknown;try{body=await response.json();}catch{throw new RpcRequestError('RPC batch unavailable','invalid_response');}
    if(!Array.isArray(body))throw new RpcRequestError('RPC batch unavailable','invalid_response');
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
      const reason=!rows?new RpcRequestError('RPC batch missing response','invalid_response')
        :rows.length!==1?new RpcRequestError('RPC batch duplicate response','invalid_response')
          :rows[0].jsonrpc!=='2.0'?new RpcRequestError('RPC batch element unavailable','invalid_response')
            :rows[0].error!=null?providerFailure('RPC batch element unavailable',rows[0].error)
              :rows[0].result==null?new RpcRequestError('RPC batch element unavailable','invalid_response',{nullResult:rows[0].result===null}):null;
      return reason?{status:'rejected' as const,reason}:{status:'fulfilled' as const,value:rows![0].result};
    });
  }catch(error){
    const reason=error instanceof RpcRequestError?error:new RpcRequestError('RPC batch unavailable','transport');
    return items.map(()=>({status:'rejected' as const,reason}));
  }
};
export const blockHex = (block: number | string) => `0x${BigInt(block).toString(16)}`;
