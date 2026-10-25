import net from 'node:net';
import {stat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {freshAddress,freshHash,freshInteger,type FreshTransaction} from './capture.js';
import {freshTraceMatchesTransaction,validateFreshTrace,type FreshCallTrace} from './trace.js';

type Method='eth_getTransactionReceipt'|'debug_traceTransaction';
export type FreshIpcTraceRequest=(path:string,method:Method,params:unknown[],signal:AbortSignal,deadline:number)=>Promise<unknown>;
const MAX_BYTES=8*1024*1024;
/** Only two fixed read methods are ever sent to the pre-existing private IPC.
 * Cancellation settles after the socket closes, before a queue slot is freed. */
const request:FreshIpcTraceRequest=(path,method,params,signal,deadline)=>new Promise((resolve,reject)=>{
 if(signal.aborted){reject(Error('trace_cancelled'));return;}
 const socket=net.createConnection(path);let bytes=0,body='',finished=false,error:Error|undefined,value:unknown;
 const finish=(problem?:Error,result?:unknown)=>{if(finished)return;finished=true;error=problem;value=result;clearTimeout(timer);signal.removeEventListener('abort',abort);socket.destroy();};
 const abort=()=>finish(Error('trace_cancelled'));
 const timer=setTimeout(()=>finish(Error('trace_timeout')),Math.max(1,deadline-Date.now()));
 signal.addEventListener('abort',abort,{once:true});
 socket.on('error',()=>finish(Error('trace_ipc_unavailable')));
 socket.on('end',()=>finish(Error('trace_incomplete')));
 socket.on('close',()=>{if(!finished)finish(Error('trace_incomplete'));error?reject(error):resolve(value);});
 socket.on('connect',()=>{if(signal.aborted||Date.now()>=deadline){finish(Error('trace_timeout'));return;}
  socket.write(JSON.stringify({jsonrpc:'2.0',id:1,method,params})+'\n');});
 socket.on('data',(chunk:Buffer)=>{
  if(finished)return;
  bytes+=chunk.length;if(bytes>MAX_BYTES){finish(Error('trace_too_large'));return;}body+=chunk.toString('utf8');
  let result:any;try{result=JSON.parse(body);}catch{return;}
  if(result?.jsonrpc!=='2.0'||result.id!==1||result.error||result.result==null){finish(Error('trace_unavailable'));return;}
  finish(undefined,result.result);
 });
 if(signal.aborted)abort();
});
const receiptMatches=(raw:unknown,tx:FreshTransaction)=>{
 try{const r=raw as Record<string,unknown>;return !!r&&freshHash(r.transactionHash)===tx.hash.toLowerCase()
  &&freshHash(r.blockHash)===tx.blockHash.toLowerCase()&&freshInteger(r.blockNumber)===freshInteger(tx.blockNumber)
  &&freshInteger(r.transactionIndex)===freshInteger(tx.transactionIndex)&&freshInteger(r.status)===1n;}catch{return false;}
};
async function verifySocket(path:string){const info=await stat(path);if(!info.isSocket()||(info.mode&0o007)!==0)throw Error('trace_socket_permissions_invalid');}
export interface FreshIpcTraceOptions{
 path?:string;maxQueued?:number;timeoutMs?:number;
 /** Deterministic tests only; production callers use the fixed private transport. */
 request?:FreshIpcTraceRequest;verifySocket?:(path:string)=>Promise<void>;
}
/** A separate instance is used by urgent capture (maxQueued:0) and decoding.
 * An unavailable trace leaves the existing explicit repair state unchanged. */
export function createFreshIpcTrace(options:FreshIpcTraceOptions={}){
 const path=options.path??process.env.BSC_TRACE_IPC,transport=options.request??request,check=options.verifySocket??verifySocket;
 const timeoutMs=Math.min(8000,Math.max(1,options.timeoutMs??8000)),maxQueued=Math.min(8,Math.max(0,options.maxQueued??8));
 type Job={tx:FreshTransaction;signal?:AbortSignal;resolve:(trace:FreshCallTrace|null)=>void;abort:()=>void};
 const jobs:Job[]=[];let running=false;
 const pump=async()=>{if(running||!jobs.length)return;running=true;const job=jobs.shift()!;job.signal?.removeEventListener('abort',job.abort);
  const controller=new AbortController(),abort=()=>controller.abort(),deadline=Date.now()+timeoutMs;
  job.signal?.addEventListener('abort',abort,{once:true});if(job.signal?.aborted)abort();const timer=setTimeout(abort,timeoutMs);
  try{
   if(!path||!isAbsolute(path)||/^https?:/i.test(path)||!freshHash(job.tx.hash)||!freshHash(job.tx.blockHash)||!freshAddress(job.tx.from)
    ||job.tx.to!==null&&!freshAddress(job.tx.to))throw Error('trace_local_ipc_required');
   for(const v of[job.tx.blockNumber,job.tx.transactionIndex,job.tx.value])freshInteger(v);
   await check(path);controller.signal.throwIfAborted();
   const before=await transport(path,'eth_getTransactionReceipt',[job.tx.hash],controller.signal,deadline);
   if(!receiptMatches(before,job.tx))throw Error('trace_receipt_mismatch');
   const raw=await transport(path,'debug_traceTransaction',[job.tx.hash,{tracer:'callTracer',timeout:'5s',reexec:32,tracerConfig:{onlyTopCall:false,withLog:false}}],controller.signal,deadline);
   const after=await transport(path,'eth_getTransactionReceipt',[job.tx.hash],controller.signal,deadline);
   controller.signal.throwIfAborted();if(!receiptMatches(after,job.tx))throw Error('trace_receipt_mismatch');
   const trace=validateFreshTrace(raw);if(!freshTraceMatchesTransaction(trace,job.tx)
    ||typeof job.tx.input==='string'&&trace.input!==job.tx.input.toLowerCase())throw Error('trace_transaction_mismatch');
   job.resolve(trace);
  }catch{job.resolve(null);}finally{clearTimeout(timer);job.signal?.removeEventListener('abort',abort);running=false;void pump();}
 };
 return(tx:FreshTransaction,signal?:AbortSignal)=>new Promise<FreshCallTrace|null>(resolve=>{
  if(!path||signal?.aborted||running&&jobs.length>=maxQueued){resolve(null);return;}
  const job:Job={tx,signal,resolve,abort:()=>{const index=jobs.indexOf(job);if(index>=0){jobs.splice(index,1);resolve(null);}}};
  signal?.addEventListener('abort',job.abort,{once:true});jobs.push(job);void pump();
 });
}
