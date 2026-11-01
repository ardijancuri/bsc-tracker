import {readFileSync} from 'node:fs';import {gunzipSync} from 'node:zlib';
import {describe,it,expect} from 'vitest';
import {createFreshTokenDiscoveryResolver,validateFreshTokenCreationProof} from './discovery.js';
import {RpcRequestError,type Rpc} from '../rpc.js';
const fixture=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/census-creation-discovery.json.gz',import.meta.url))).toString());
function setup(change?:(value:any)=>void){
 const f=structuredClone(fixture);change?.(f);const traceRequests:string[]=[];
 const headers=new Map(f.search.observations.map((o:any)=>[o.block.number,{number:'0x'+o.block.number.toString(16),hash:o.block.hash,parentHash:o.block.parentHash,timestamp:'0x'+Math.floor(Date.parse(o.block.timestamp)/1000).toString(16),transactions:[]}]));
 const own:Rpc=async<T>(m:string,a:unknown[])=>{
  if(m==='eth_chainId')return'0x38'as T;
  if(m==='eth_getBlockByNumber'){const n=Number(BigInt(String(a[0])));if(n===f.search.start.number)throw new RpcRequestError('RPC eth_getBlockByNumber unavailable','invalid_response',{nullResult:true});const h=headers.get(n);if(!h)throw Error('unrecorded_header');return h as T;}
  throw Error('unexpected_node_request:'+m);
 };
 const archive:Rpc=async<T>(m:string,a:unknown[])=>{
  if(m==='eth_chainId')return'0x38'as T;
  if(m==='eth_getBlockByNumber'&&a[1]===true)return f.fullBlock as T;
  if(m==='eth_getLogs')return[]as T;
  if(m==='eth_getTransactionReceipt'&&a[0]===f.transaction.hash)return f.receipt as T;
  if(m==='debug_traceTransaction'&&a[0]===f.transaction.hash){traceRequests.push(String(a[0]));expect(a[1]).toEqual({tracer:'callTracer',tracerConfig:{onlyTopCall:false,withLog:false}});return f.trace as T;}
  throw Error('unexpected_archive_request:'+m);
 };
 const resolve=(creationTraces=true)=>createFreshTokenDiscoveryResolver(own,{archiveRpc:archive,creationTraces,boundaryFirst:true,mintHints:false,trustedBoundary:{...f.search.start,timestamp:'2026-10-25T02:42:03Z'},maxCalls:96})({tokenAddress:f.tokenAddress,start:f.search.start,observed:f.search.observed,search:f.search});
 return{f,resolve,traceRequests};
}
describe('constructor-created tokens with no mint at birth',()=>{
 it('authenticates the real CENSUS internal CREATE from retained canonical evidence only',async()=>{
  const {f,resolve,traceRequests}=setup(),before=structuredClone(f),proof=await resolve();
  expect(proof).toMatchObject({kind:'canonical_token_birth_v1',mode:'internal_creation',tokenAddress:f.tokenAddress,source:'explicit_archive',parentCode:'0x'});
  if(!proof||proof.kind!=='canonical_token_birth_v1')throw Error('creation_proof_missing');
  expect(Number(BigInt(proof.block.number))).toBe(130665915);expect(proof.entry.transaction.hash).toBe('0xa3ceba6babee4bb5afbbbdf12d4037de1f885d89d0f309e06087ef4e70a5605f');
  expect(proof.entry.completeTraceProof?.onlyTopCall).toBe(false);expect(traceRequests).toHaveLength(1);expect(f).toEqual(before);
  const observations=new Map<number,any>(f.search.observations.map((o:any)=>[o.block.number,o])),codes=new Map<string,string>(f.search.codes.map((c:any)=>[c.sha256,c.code]));
  const fact=await validateFreshTokenCreationProof(proof,f.search.start,async n=>observations.get(n)?.block??null,async(token,block)=>token===f.tokenAddress&&observations.get(block.number)?.block.hash===block.hash?codes.get(observations.get(block.number).codeSha256)??null:null);
  expect(fact).toMatchObject({status:'eligible',blockNumber:130665915,tokenAddress:f.tokenAddress,proof:{creation:'internal_creation',creationTransactionKnown:true}});
 });
 it('does not issue a constructor trace without the explicit resolver capability',async()=>{
  const {resolve,traceRequests}=setup();expect(await resolve(false)).toBe(null);expect(traceRequests).toHaveLength(0);
 });
 it.each(['missing_child','wrong_runtime','wrong_child','reverted_child']as const)('does not approve %s',async reason=>{
  const {resolve}=setup(f=>{const walk=(c:any):any=>{if(c.to===f.tokenAddress&&['CREATE','CREATE2'].includes(c.type))return c;for(const child of c.calls??[]){const found=walk(child);if(found)return found;}};
   const child=walk(f.trace);if(!child)throw Error('fixture_child_missing');
   if(reason==='missing_child')delete f.trace.calls;
   if(reason==='wrong_runtime')child.output='0x6000';if(reason==='wrong_child')child.to='0x'+'1'.repeat(40);if(reason==='reverted_child')child.error='execution reverted';
  });expect(await resolve()).toBe(null);
 });
 it('rejects a truncated constructor input before approving a trace certificate',async()=>{
  const {resolve}=setup(f=>{f.trace.input='0x';});await expect(resolve()).rejects.toThrow('complete_trace_context_invalid');
 });
});
