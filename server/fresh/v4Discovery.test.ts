import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { Rpc } from '../rpc.js';
import type { FreshBlock, FreshLog, FreshReceipt } from './capture.js';
import { FRESH_UNISWAP_V4_BSC_MANAGER as manager, FRESH_UNISWAP_V4_INITIALIZE_TOPIC as topic, freshStockwavePoolId, stockwavePoolManagerInterface } from './stockwaveMarket.js';
import { collectFreshV4DiscoveryPage, freshV4DiscoveryProgress, readFreshV4MarketIdentities, runFreshV4MarketDiscovery } from './v4Discovery.js';
import{freshInfinityClInterface,freshInfinityClPoolId}from'./infinityClMarket.js';import{INFINITY_CL}from'../nodeMarketProtocols.js';import{AbiCoder,keccak256}from'ethers';

const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`,hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
const token=address(4),quote=address(8),wallet=address(3),Q96=1n<<96n;
function fixture(){
 const number=101,blockHash=hash(101),txHash=hash(111),blockNumber='0x65';
 const logs:FreshLog[]=[0,3000].map((fee,index)=>{
   const key={currency0:token,currency1:quote,fee,tickSpacing:200,hooks:address(0)};
   return{address:manager,...stockwavePoolManagerInterface.encodeEventLog('Initialize',[freshStockwavePoolId(key),token,quote,fee,200,address(0),Q96,0]),
    blockHash,blockNumber,transactionHash:txHash,transactionIndex:'0x0',logIndex:`0x${index.toString(16)}`};
 });
 const block:FreshBlock={number:blockNumber,hash:blockHash,parentHash:hash(100),timestamp:'0x69000000',transactions:[{hash:txHash,from:wallet,to:manager,value:'0x0',gasPrice:'0x1',blockHash,blockNumber,transactionIndex:'0x0'}]};
 const receipt:FreshReceipt={transactionHash:txHash,transactionIndex:'0x0',blockHash,blockNumber,status:'0x1',gasUsed:'0x5208',effectiveGasPrice:'0x1',logs};
 const rpc=vi.fn(async(method:string,params:unknown[])=>{
  if(method==='eth_getLogs'){const request=params[0]as any;if(request.address!==manager)return[];return request.topics[2]?logs:[];}
  if(method==='eth_getBlockByNumber'){const n=Number(BigInt(params[0]as string));return n===number?block:{...block,number:`0x${n.toString(16)}`,hash:hash(n),parentHash:hash(n-1),transactions:[]};}
  if(method==='eth_getTransactionReceipt')return receipt;
  throw Error('unexpected_fixture_rpc');
 })as unknown as Rpc;
 const canonicalHash=async(n:number)=>hash(n);
 return{logs,block,receipt,rpc,canonicalHash};
}
describe('bounded background Uniswap v4 market discovery',()=>{
 it('discovers a supported native Infinity pool while retaining a bounded diagnostic for another authentic unsupported key',async()=>{
  const f=fixture(),native='0x'+'0'.repeat(40),parameters='0x'+(1n<<16n).toString(16).padStart(64,'0'),key={currency0:native,currency1:token,hooks:native,poolManager:INFINITY_CL,fee:100,parameters},unsupported={...key,currency0:token,currency1:quote},unsupportedId=keccak256(AbiCoder.defaultAbiCoder().encode(['address','address','address','address','uint24','bytes32'],Object.values(unsupported)));
  const extra=[{id:unsupportedId,key:unsupported},{id:freshInfinityClPoolId(key),key}].map((p,index)=>({address:INFINITY_CL,...freshInfinityClInterface.encodeEventLog('Initialize',[p.id,p.key.currency0,p.key.currency1,p.key.hooks,p.key.fee,p.key.parameters,Q96,0]),blockHash:f.block.hash,blockNumber:f.block.number,transactionHash:f.receipt.transactionHash,transactionIndex:'0x0',logIndex:'0x'+(index+2).toString(16)}));
  f.logs.push(...extra);const rpc:Rpc=async<T>(method:string,params:unknown[]):Promise<T>=>{if(method==='eth_getLogs'){const req=params[0]as any;return f.logs.filter(l=>l.address===req.address&&l.topics[req.topics[2]?2:3]===req.topics[req.topics[2]?2:3])as T;}return f.rpc<T>(method,params);};
  const page=await collectFreshV4DiscoveryPage({...f,rpc,token,fromBlock:100,toBlock:200});expect(page.identities).toHaveLength(3);expect(page.identities.some(m=>m.manager===INFINITY_CL&&m.quoteAddress!==native)).toBe(true);expect(page.unsupportedPools).toEqual([{manager:INFINITY_CL,poolId:unsupportedId,blockNumber:101,blockHash:hash(101),reason:'infinity_cl_pool_key_unsupported'}]);
 });
 it('authenticates two pools sharing the same manager using complete canonical transaction and receipt evidence',async()=>{
  const f=fixture(),page=await collectFreshV4DiscoveryPage({...f,token,fromBlock:100,toBlock:200});
  expect(page.identities).toHaveLength(2);expect(new Set(page.identities.map(m=>m.poolId)).size).toBe(2);expect(page.identities.every(m=>m.manager===manager&&m.tokenAddress===token)).toBe(true);
  expect(page.receipts).toBe(1);expect(page.headers.map(h=>h.number)).toEqual([101,200]);
  const calls=(f.rpc as any).mock.calls;expect(calls.filter(([method]:[string])=>method==='eth_getLogs')).toHaveLength(4);
  expect(calls.filter(([method]:[string])=>method==='eth_getTransactionReceipt')).toHaveLength(1);
  expect(calls.find(([method,params]:[string,unknown[]])=>method==='eth_getBlockByNumber'&&params[0]==='0x65')[1][1]).toBe(true);
 });
 it('keeps an empty complete page compact without downloading unrelated trader receipts',async()=>{
  const f=fixture(),rpc=vi.fn(async(method:string,params:unknown[])=>method==='eth_getLogs'?[]:await f.rpc(method,params))as unknown as Rpc;
  const page=await collectFreshV4DiscoveryPage({...f,rpc,token,fromBlock:100,toBlock:200});expect(page.identities).toEqual([]);expect(page.receipts).toBe(0);
  expect((rpc as any).mock.calls).toHaveLength(5);expect(page.headers).toHaveLength(1);
 });
 it('requires exact indexed-token orientation and authenticates receipt bodies instead of trusting discovery logs',async()=>{
  const f=fixture(),wrong=vi.fn(async(method:string,params:unknown[])=>method==='eth_getLogs'?f.logs:await f.rpc(method,params))as unknown as Rpc;
  await expect(collectFreshV4DiscoveryPage({...f,rpc:wrong,token,fromBlock:100,toBlock:200})).rejects.toThrow('v4_discovery_filter_mismatch');
  const altered=vi.fn(async(method:string,params:unknown[])=>method==='eth_getTransactionReceipt'?{...f.receipt,logs:[]}:await f.rpc(method,params))as unknown as Rpc;
  await expect(collectFreshV4DiscoveryPage({...f,rpc:altered,token,fromBlock:100,toBlock:200})).rejects.toThrow('v4_discovery_receipt_log_mismatch');
 });
 it('rejects spoofed managers, pool-key hashes, removed logs and noncanonical or missing block/receipt evidence',async()=>{
  for(const kind of ['manager','pool','removed','orphan','missing_receipt']as const){
   const f=fixture(),rpc:Rpc=async<T>(method:string,params:unknown[]):Promise<T>=>{
    const result=await f.rpc<any>(method,params);
    if(method==='eth_getLogs'&&(params[0]as any).topics[2])return result.map((log:FreshLog)=>kind==='manager'?{...log,address:quote}:kind==='pool'?{...log,topics:[topic,hash(999),...log.topics.slice(2)]}:kind==='removed'?{...log,removed:true}:log)as T;
    if(method==='eth_getTransactionReceipt'&&kind==='missing_receipt')return null as T;
    return result as T;
   };
   await expect(collectFreshV4DiscoveryPage({...f,rpc,canonicalHash:kind==='orphan'?async()=>hash(999):f.canonicalHash,token,fromBlock:100,toBlock:200})).rejects.toThrow();
  }
 });
 it('bounds queried ranges and matching receipts before full body requests',async()=>{
  const f=fixture();await expect(collectFreshV4DiscoveryPage({...f,token,fromBlock:100,toBlock:4196})).rejects.toThrow('v4_discovery_range_invalid');expect(f.rpc).not.toHaveBeenCalled();
  const rpc=vi.fn(async(_method:string,params:unknown[])=>(params[0]as any).address===manager&&(params[0]as any).topics[2]?Array.from({length:17},(_,i)=>({...f.logs[0],transactionHash:hash(200+i)})):[])as unknown as Rpc;
  await expect(collectFreshV4DiscoveryPage({...f,rpc,token,fromBlock:100,toBlock:200})).rejects.toThrow('v4_discovery_log_limit');expect(rpc).toHaveBeenCalledTimes(4);
 });
 it('deduplicates identical log delivery without copying transaction receipts or financial facts',async()=>{
  const f=fixture(),rpc:Rpc=async<T>(method:string,params:unknown[]):Promise<T>=>method==='eth_getLogs'&&(params[0]as any).address===manager&&(params[0]as any).topics[2]?[...f.logs,...f.logs]as T:await f.rpc<T>(method,params);
  const page=await collectFreshV4DiscoveryPage({...f,rpc,token,fromBlock:100,toBlock:200});expect(page.identities).toHaveLength(2);expect(page.receipts).toBe(1);
 });
 it('rewinds cursors when canonical evidence, capture revision or creation identity changes without losing prior audit evidence',()=>{
  const fact={block_number:'100',block_hash:hash(100),tx_hash:hash(900),status:'eligible'},capture={block_number:'300',revision:'1'};
  const initial=freshV4DiscoveryProgress(fact,capture,{},null),saved={...initial,throughBlock:200,throughHash:hash(200),rangeSize:64};
  expect(freshV4DiscoveryProgress(fact,capture,saved,hash(200))).toEqual(saved);
  for(const [changedFact,changedCapture,canonical]of[[fact,capture,hash(999)],[fact,{...capture,revision:'2'},hash(200)],[{...fact,tx_hash:hash(901)},capture,hash(200)]]as const)
    expect(freshV4DiscoveryProgress(changedFact,changedCapture,saved,canonical).throughBlock).toBe(99);
  expect(freshV4DiscoveryProgress(fact,capture,{...saved,throughHash:null},null).throughBlock).toBe(99);
  expect(saved.throughBlock).toBe(200);
 });
 it('reads bounded ready identity envelopes without historical RPC or accepting a foreign token market',async()=>{
  const page=await collectFreshV4DiscoveryPage({...fixture(),token,fromBlock:100,toBlock:200}),identity=page.identities[0];
  const query=vi.fn(async(_sql:string,_params?:unknown[])=>({rows:[{token_address:token,identity:{market:identity,conversion:'retained'}},{token_address:token,identity:page.identities[1]},{token_address:quote,identity}]}));
  const rows=await readFreshV4MarketIdentities({query}as any,[token,quote]);expect(rows.get(token)).toHaveLength(2);expect(rows.has(quote)).toBe(false);expect(query.mock.calls[0][0]).toMatch(/rank<=8/);
 });
 it('yields to fresh urgent backlog, capture failures or stale coverage before claiming jobs or making node requests',async()=>{
  for(const changes of[{urgent_pending:33},{capture_ok:'false'},{occurred_at:new Date(Date.now()-30_000)}]){
   const query=vi.fn(async()=>({rows:[{block_number:'100',revision:'1',occurred_at:new Date(),capture_ok:'true',urgent_pending:false,...changes}]})),rpc=vi.fn()as unknown as Rpc;
   const result=await runFreshV4MarketDiscovery({query}as unknown as Pool,rpc);expect(result.yielded).toBe(true);expect(rpc).not.toHaveBeenCalled();expect(query).toHaveBeenCalledTimes(1);
  }
 });
 it('permits a small fresh backlog, seeds only missing traded valuations and claims older due work before priority',async()=>{
  const calls:string[]=[],query=vi.fn(async(sql:string)=>{calls.push(sql);return{rows:sql.startsWith('SELECT c.block_number')?[{block_number:'100',revision:'1',occurred_at:new Date(),capture_ok:'true',urgent_pending:1}]:[]};});
  const rpc=vi.fn(async()=>`0x${(100+6).toString(16)}`)as unknown as Rpc;
  const result=await runFreshV4MarketDiscovery({query}as unknown as Pool,rpc);expect(result.yielded).not.toBe(true);expect(rpc).toHaveBeenCalledTimes(1);
  const seed=calls.find(sql=>sql.startsWith('INSERT INTO fresh.jobs'))!;expect(seed).toContain("t.valuation_status<>'ready'");expect(seed).toContain('r.scope_id=p.scope_id');expect(seed).toContain("e.kind IN('buy','sell')");
  expect(calls.find(sql=>sql.startsWith('UPDATE fresh.jobs'))).toContain('ORDER BY due_at,priority DESC,id');
 });
 it('does not claim historical work while live capture is more than 32 confirmed blocks behind',async()=>{
  const query=vi.fn(async()=>({rows:[{block_number:'100',revision:'1',occurred_at:new Date(),capture_ok:'true',urgent_pending:false}]})),rpc=vi.fn(async()=>`0x${(100+6+33).toString(16)}`)as unknown as Rpc;
  expect((await runFreshV4MarketDiscovery({query}as unknown as Pool,rpc)).yielded).toBe(true);expect(query).toHaveBeenCalledTimes(1);
 });
});
