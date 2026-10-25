import {describe,it,expect,vi} from 'vitest';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {unlink} from 'node:fs/promises';
import {createFreshIpcTrace,type FreshIpcTraceRequest} from './ipcTrace.js';
import {freshNativeDelta} from './trace.js';
const hash=(x:string)=>'0x'+x.repeat(64),address=(x:string)=>'0x'+x.repeat(40);
const tx={hash:hash('a'),blockHash:hash('b'),blockNumber:'0x123',transactionIndex:'0x3',from:address('1'),to:address('2'),value:'0x10',input:'0x1234'};
const receipt={transactionHash:tx.hash,blockHash:tx.blockHash,blockNumber:tx.blockNumber,transactionIndex:tx.transactionIndex,status:'0x1'};
const tree={type:'CALL',from:tx.from,to:tx.to,value:tx.value,input:tx.input,calls:[{type:'CALL',from:tx.to,to:tx.from,value:'0x4'}]};
const socket={path:'/run/bsc/geth.ipc',verifySocket:async()=>{}};
describe('bounded production private IPC trace adapter',()=>{
 it('authenticates both receipt positions and the signed execution before approving the trace',async()=>{
  const request=vi.fn<FreshIpcTraceRequest>(async(_path,method)=>method==='debug_traceTransaction'?tree:receipt);
  const result=await createFreshIpcTrace({...socket,request})(tx);expect(result).toMatchObject(tree);expect(freshNativeDelta(result!,tx.from)).toBe(-12n);
  expect(request.mock.calls.map(c=>c[1])).toEqual(['eth_getTransactionReceipt','debug_traceTransaction','eth_getTransactionReceipt']);
  expect(request.mock.calls[1][2]).toEqual([tx.hash,{tracer:'callTracer',timeout:'5s',reexec:32,tracerConfig:{onlyTopCall:false,withLog:false}}]);
  expect(request.mock.calls.every(c=>c[0]===socket.path&&c[3] instanceof AbortSignal)).toBe(true);
 });
 it.each(['blockHash','blockNumber','transactionIndex','transactionHash','status'])('rejects changed %s after tracing',async field=>{
  let receipts=0;const altered={...receipt,[field]:field==='blockHash'||field==='transactionHash'?hash('c'):'0x0'};
  const request:FreshIpcTraceRequest=async(_path,method)=>method==='debug_traceTransaction'?tree:++receipts===1?receipt:altered;
  await expect(createFreshIpcTrace({...socket,request})(tx)).resolves.toBeNull();
 });
 it('does not trace a failed or orphaned initial receipt',async()=>{
  const request=vi.fn<FreshIpcTraceRequest>(async()=>({...receipt,status:'0x0'}));await expect(createFreshIpcTrace({...socket,request})(tx)).resolves.toBeNull();expect(request).toHaveBeenCalledTimes(1);
 });
 it.each([{...tree,value:'0x20'},{...tree,input:'0x5678'},{...tree,from:address('3')},{...tree,type:'CREATE'}])('rejects a different root execution',async changed=>{
  const request:FreshIpcTraceRequest=async(_path,method)=>method==='debug_traceTransaction'?changed:receipt;await expect(createFreshIpcTrace({...socket,request})(tx)).resolves.toBeNull();
 });
 it('rejects network endpoints and invalid socket permissions before any RPC',async()=>{
  const request=vi.fn<FreshIpcTraceRequest>();await expect(createFreshIpcTrace({...socket,path:'http://127.0.0.1:8545',request})(tx)).resolves.toBeNull();
  await expect(createFreshIpcTrace({...socket,verifySocket:async()=>{throw Error('trace_socket_permissions_invalid');},request})(tx)).resolves.toBeNull();expect(request).not.toHaveBeenCalled();
 });
 it('gives urgent tracing one active request and zero queued requests',async()=>{
  let release!:()=>void;const hold=new Promise<void>(r=>release=r);const request:FreshIpcTraceRequest=async(_path,method)=>{if(method==='debug_traceTransaction'){await hold;return tree;}return receipt;};
  const loader=createFreshIpcTrace({...socket,request,maxQueued:0}),first=loader(tx);await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  await expect(loader(tx)).resolves.toBeNull();release();await expect(first).resolves.toMatchObject(tree);
 });
 it('settles cancellation before starting the next queued job',async()=>{
  const controller=new AbortController();let started=0,active=0,maxActive=0;
  const request:FreshIpcTraceRequest=async(_path,method,_params,signal)=>{if(method!=='debug_traceTransaction')return receipt;started++;active++;maxActive=Math.max(maxActive,active);
   if(started===1)await new Promise<void>(resolve=>signal.addEventListener('abort',()=>setTimeout(resolve,5),{once:true}));active--;return tree;};
  const loader=createFreshIpcTrace({...socket,request,maxQueued:1}),first=loader(tx,controller.signal);await vi.waitFor(()=>expect(started).toBe(1));const second=loader(tx);controller.abort();
  await expect(first).resolves.toBeNull();await expect(second).resolves.toMatchObject(tree);expect(maxActive).toBe(1);
 });
 it('bounds a timed-out transport and removes canceled queued work',async()=>{
  let calls=0;const request:FreshIpcTraceRequest=async(_path,_method,_params,signal)=>{calls++;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));};
  const loader=createFreshIpcTrace({...socket,request,timeoutMs:25,maxQueued:1}),first=loader(tx),controller=new AbortController(),second=loader(tx,controller.signal);controller.abort();
  await expect(second).resolves.toBeNull();await expect(first).resolves.toBeNull();expect(calls).toBe(1);
 });
 it.each(['valid','wrong_id','truncated','timeout'])('exercises the real local socket transport: %s',async mode=>{
  const path=process.platform==='win32'?`\\\\.\\pipe\\fresh-ipc-test-${randomUUID()}`:join(tmpdir(),`fresh-ipc-${randomUUID()}.sock`),methods:string[]=[],sockets=new Set<net.Socket>();
  const server=net.createServer(client=>{sockets.add(client);client.on('error',()=>{});client.on('close',()=>sockets.delete(client));let raw='';client.on('data',chunk=>{
   raw+=chunk.toString();if(!raw.endsWith('\n'))return;const request=JSON.parse(raw);methods.push(request.method);
   if(mode==='timeout')return;if(mode==='truncated'){client.end('{"jsonrpc":');return;}
   client.end(JSON.stringify({jsonrpc:'2.0',id:mode==='wrong_id'?2:request.id,result:request.method==='debug_traceTransaction'?tree:receipt}));
  });});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,()=>resolve());});
  try{const loader=createFreshIpcTrace({path,verifySocket:async()=>{},timeoutMs:mode==='timeout'?40:1000}),result=await loader(tx);
   if(mode==='valid'){expect(result).toMatchObject(tree);expect(methods).toEqual(['eth_getTransactionReceipt','debug_traceTransaction','eth_getTransactionReceipt']);}
   else{expect(result).toBeNull();expect(methods).toEqual(['eth_getTransactionReceipt']);}
  }finally{for(const client of sockets)client.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));if(process.platform!=='win32')await unlink(path).catch(()=>{});}
 });
});
