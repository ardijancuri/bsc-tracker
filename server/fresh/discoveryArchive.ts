import{RpcRequestError,type Rpc}from'../rpc.js';
import{transferTopic}from'../swap.js';
const hash=(v:unknown)=>typeof v==='string'&&/^0x[a-f0-9]{64}$/.test(v),address=(v:unknown)=>typeof v==='string'&&/^0x[a-f0-9]{40}$/.test(v);
const block=(v:unknown)=>typeof v==='string'&&/^0x[a-f0-9]{1,14}$/.test(v)&&BigInt(v)<=BigInt(Number.MAX_SAFE_INTEGER);
export function freshDiscoveryArchiveRequestAllowed(method:string,params:unknown[]){
 if(!Array.isArray(params))return false;
 if(method==='eth_chainId')return params.length===0;
 if(method==='eth_getBlockByNumber')return params.length===2&&block(params[0])&&typeof params[1]==='boolean';
 if(method==='eth_getCode'){const at=params[1]as any;return params.length===2&&address(params[0])&&(block(at)||at&&typeof at==='object'&&!Array.isArray(at)&&Object.keys(at).sort().join(',')==='blockHash,requireCanonical'&&hash(at.blockHash)&&at.requireCanonical===true);}
 if(method==='eth_getTransactionReceipt')return params.length===1&&hash(params[0]);
 if(method==='eth_getLogs'&&params.length===1){const p=params[0]as any;return p&&Object.keys(p).sort().join(',')==='address,fromBlock,toBlock,topics'&&address(p.address)&&block(p.fromBlock)&&p.toBlock===p.fromBlock&&Array.isArray(p.topics)&&p.topics.length===2&&p.topics[0]===transferTopic&&p.topics[1]==='0x'+'0'.repeat(64);}
 return false;
}
/** Explicit server-only archive transport for birth evidence. Unconfigured
 * means no adapter and no external request. It cannot call financial methods,
 * traces, current state, wallet history or any chain-writing method. */
export function createFreshDiscoveryArchiveRpc(endpoint:string|undefined,options:{signal?:AbortSignal;timeoutMs?:number;maxRequestsPerMinute?:number;minIntervalMs?:number;maxResponseBytes?:number}={}):Rpc|undefined{
 if(!endpoint?.trim())return undefined;
 let url:URL;try{url=new URL(endpoint);if(!['https:','http:'].includes(url.protocol)||url.hash)throw Error();}catch{throw Error('discovery_archive_configuration_invalid');}
 const bounded=(v:number|undefined,d:number,min:number,max:number)=>typeof v==='number'&&Number.isFinite(v)?Math.min(max,Math.max(min,Math.floor(v))):d;
 const timeout=bounded(options.timeoutMs,4000,5,8000),cap=bounded(options.maxRequestsPerMinute,256,1,512),spacing=bounded(options.minIntervalMs,25,0,1000),maxBytes=bounded(options.maxResponseBytes,4*1024*1024,128,8*1024*1024);
 let id=0,active=false,cooldown=0,lastStart=0;const starts:number[]=[];
 const error=(message:string,category:'transport'|'rate_limit'|'invalid_response'|'rpc_error'|'state_unavailable',code?:unknown)=>new RpcRequestError(message,category,{code});
 return async<T>(method:string,params:unknown[]):Promise<T>=>{
  if(!freshDiscoveryArchiveRequestAllowed(method,params))throw error('discovery_archive_request_forbidden','rpc_error');
  if(options.signal?.aborted)throw error('discovery_archive_canceled','transport');
  const at=Date.now();while(starts.length&&starts[0]<=at-60_000)starts.shift();
  if(at<cooldown||starts.length>=cap)throw error('discovery_archive_cooldown','rate_limit');if(active)throw error('discovery_archive_busy','rate_limit');
  active=true;try{
   const wait=Math.max(0,lastStart+spacing-Date.now());if(wait)await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(error('discovery_archive_canceled','transport'));},timer=setTimeout(()=>{options.signal?.removeEventListener('abort',abort);resolve();},wait);options.signal?.addEventListener('abort',abort,{once:true});});
   if(options.signal?.aborted)throw error('discovery_archive_canceled','transport');const requestId=++id;lastStart=Date.now();starts.push(lastStart);
   const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout);
   let response:Response;try{response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:requestId,method,params}),signal});}catch{throw error('discovery_archive_unavailable','transport');}
   const discard=async()=>{try{await response.body?.cancel();}catch{/* Await cancellation before releasing the only transport slot. */}};
   if(response.status===429){const raw=response.headers.get('retry-after'),seconds=raw&&/^\d+$/.test(raw)?Number(raw):raw?Math.ceil((Date.parse(raw)-Date.now())/1000):60;cooldown=Date.now()+Math.max(60,Math.min(3600,Number.isFinite(seconds)?seconds:60))*1000;await discard();throw error('discovery_archive_rate_limited','rate_limit');}
   if(!response.ok){await discard();throw error('discovery_archive_http_unavailable','transport');}
   const length=Number(response.headers.get('content-length'));if(Number.isFinite(length)&&length>maxBytes){await discard();throw error('discovery_archive_response_too_large','invalid_response');}
   const reader=response.body?.getReader();if(!reader)throw error('discovery_archive_response_invalid','invalid_response');const pieces:Uint8Array[]=[];let bytes=0;
   try{while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>maxBytes){await reader.cancel();throw error('discovery_archive_response_too_large','invalid_response');}pieces.push(next.value);}}catch(failure){if(failure instanceof RpcRequestError)throw failure;throw error('discovery_archive_response_unavailable','transport');}
   let body:any;try{body=JSON.parse(Buffer.concat(pieces).toString());}catch{throw error('discovery_archive_response_invalid','invalid_response');}
   if(body?.jsonrpc!=='2.0'||body.id!==requestId)throw error('discovery_archive_identity_invalid','invalid_response');
   if(body.error){const raw=String(body.error.message??''),category=/rate.?limit|quota|too many|(?:credit|capacity|compute unit).*(?:exceed|exhaust|limit)/i.test(raw)?'rate_limit':/historical|missing trie|not supported|header not found|state.*unavailable/i.test(raw)?'state_unavailable':'rpc_error';if(category==='rate_limit')cooldown=Date.now()+60_000;
    const canonicalFailure=/non.?canonical|not canonical|\bmismatch\b|(?:hash|header|block).*?(?:not found|unknown)/i.test(raw),hashCode=method==='eth_getCode'&&params[1]&&typeof params[1]==='object',unsupported=category!=='rate_limit'&&!canonicalFailure&&hashCode&&/cannot unmarshal.*object|unsupported.*(?:selector|blockhash|eip.?1898)|(?:selector|blockhash|eip.?1898).*not supported/i.test(raw);
    // This provider can serve the same canonical historical state numerically
    // while its hash-selector backend lacks that state. Preserve only this
    // diagnosed shape; missing/noncanonical headers and generic errors cannot
    // authorize a numeric retry. The reader still brackets the numeric code
    // with both archive headers and an owned-node canonical header.
    const hashStateUnavailable=hashCode&&category==='state_unavailable'&&body.error.code===-32000&&!canonicalFailure&&/\bhistorical state(?:\s+(?:0x)?[a-f0-9]{64})?\s+(?:is\s+)?(?:not available|unavailable)\b|\bmissing trie node\b/i.test(raw);
    throw error(unsupported?'discovery_archive_hash_selector_unsupported':hashStateUnavailable?'discovery_archive_hash_state_unavailable':'discovery_archive_rpc_unavailable',category,body.error.code);}
   if(body.result==null)throw error('discovery_archive_result_unavailable','state_unavailable');return body.result as T;
  }finally{active=false;}
 };
}
