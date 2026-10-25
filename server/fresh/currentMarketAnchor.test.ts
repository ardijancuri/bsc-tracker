import{afterEach,describe,expect,it,vi}from'vitest';
import{Interface,ZeroAddress}from'ethers';
import{PCS_V2_FACTORY,PCS_V3_FACTORY,WBNB}from'../launchpad.js';
import{TRUSTED_QUOTE_FEEDS,oracleMarketAbi,poolMarketAbi}from'../nodeMarketProtocols.js';
import{FRESH_EVIDENCE_TTL_MS}from'./capture.js';
import{anchorFreshMarketInitialization,createFreshCurrentMarketCanonicalHash,freshMarketIdentityInvalid}from'./currentMarketAnchor.js';
import*as market from'./stockwaveMarket.js';
import{freshCurrentQuote}from'./pricing.js';
import{freshStockwaveCreate2Address,FRESH_BSC_GENESIS_HASH,FRESH_STOCKWAVE_FACTORY,FRESH_STOCKWAVE_DEPLOYER,FRESH_STOCKWAVE_LAUNCH_TOPIC,FRESH_STOCKWAVE_FACTORY_CODE_HASH,FRESH_STOCKWAVE_DEPLOYER_CODE_HASH,FRESH_STOCKWAVE_CREATION_CODE_HASH}from'./factoryLaunch.js';
import type{Rpc}from'../rpc.js';
const hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`,token=`0x${'7'.repeat(40)}`,quote='0x55d398326f99059ff775485246999027b3197955';
const at=Date.parse('2026-10-27T00:00:00Z'),initialAt=new Date(at-FRESH_EVIDENCE_TTL_MS-120_000).toISOString();
function fixture(){
 const poolKey={currency0:quote,currency1:token,fee:500,tickSpacing:10,hooks:ZeroAddress};
 const identity:market.FreshStockwaveMarketIdentity={version:1,manager:market.FRESH_UNISWAP_V4_BSC_MANAGER,poolId:market.freshStockwavePoolId(poolKey),poolKey,tokenAddress:token,quoteAddress:quote,
  initial:{sqrtPriceX96:String(1n<<96n),tick:0,blockNumber:100,blockHash:hash(100),transactionHash:hash(900),logIndex:1}};
 const fact:any={token_address:token,protocol:'evm_creation',block_number:95,block_hash:hash(95),tx_hash:hash(895),status:'eligible',launched_at:new Date(Date.parse(initialAt)-1000).toISOString(),proof:{creation:'top_level'}};
 const boundary={number:90,hash:hash(90)},anchored=anchorFreshMarketInitialization(identity,fact,{boundary,captureRevision:'1',initialOccurredAt:initialAt,
  confirmedThrough:{number:101,hash:hash(101),occurredAt:new Date(Date.parse(initialAt)+1000).toISOString()}});
 const block={number:9000,hash:hash(9000),timestamp:new Date(at).toISOString()};
 const capture:any={block_number:9000,block_hash:block.hash,revision:'1',value:{startBlock:boundary.number,startHash:boundary.hash},occurred_at:new Date(at-1000),capture_ok:'true',health_at:new Date(at-1000)};
 const rows:any[]=[{identity:{market:anchored}}],recent=new Map<number,string>();
 const query=vi.fn(async(sql:string,params:unknown[]=[])=>{
  expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/);
  if(sql.startsWith('SELECT block_hash'))return{rows:recent.has(Number(params[0]))?[{block_hash:recent.get(Number(params[0]))}]:[]};
  if(sql.startsWith('SELECT c.block_number'))return{rows:[capture]};
  if(sql.startsWith('SELECT to_jsonb'))return{rows:fact?[{fact}]:[]};
  if(sql.startsWith('SELECT identity'))return{rows};
  throw Error('unexpected_anchor_query');
 });
 return{identity,anchored,fact,boundary,block,capture,rows,recent,query,hashReader:()=>createFreshCurrentMarketCanonicalHash({query}as any,{token:fact.token_address,block,now:()=>at})};
}
afterEach(()=>vi.restoreAllMocks());
describe('durable identity anchors for CURRENT market valuation only',()=>{
 it('continues exact current V4 quotes after the original header expires without any historical RPC/state fallback',async()=>{
  const f=fixture(),abi=new Interface(['function decimals()view returns(uint8)','function totalSupply()view returns(uint256)','function name()view returns(string)','function symbol()view returns(string)']);
  const current=vi.spyOn(market,'readFreshStockwaveMarket').mockResolvedValue({sqrtPriceX96:String(1n<<96n),liquidityRaw:'100',rawQuoteRatio:{numerator:'1',denominator:'1'},virtualQuoteLiquidityRaw:{numerator:String(100n*10n**18n),denominator:'1'}}as any);
  const rpc=vi.fn(async(method:string,params:any[])=>{
   expect(method).toBe('eth_call');expect(params[1]).toEqual({blockHash:f.block.hash,requireCanonical:true});const call=params[0];
   if([PCS_V2_FACTORY,PCS_V3_FACTORY].includes(call.to)){const name=poolMarketAbi.parseTransaction(call)!.name;return poolMarketAbi.encodeFunctionResult(name,[ZeroAddress]);}
   const feed=Object.entries(TRUSTED_QUOTE_FEEDS).find(([,value])=>value.feed===call.to);
   if(feed){const name=oracleMarketAbi.parseTransaction(call)!.name;return oracleMarketAbi.encodeFunctionResult(name,name==='decimals'?[8]:name==='description'?[feed[1].description]:[1n,(feed[0]===WBNB?600n:1n)*10n**8n,1n,BigInt(at/1000),1n]);}
   if([token,...Object.keys(TRUSTED_QUOTE_FEEDS)].includes(call.to)){const name=abi.parseTransaction(call)!.name;return abi.encodeFunctionResult(name,name==='decimals'?[18]:name==='totalSupply'?[1_000_000n*10n**18n]:['Meme']);}
   throw Error('unsupported_current_route');
  })as unknown as Rpc;
  const result=await freshCurrentQuote(token,{rpc,block:f.block,marketIdentities:[f.anchored],canonicalHash:f.hashReader()});
  expect(result.priceUsd).toBe('1');expect(result.marketCapUsd).toBe('1000000');expect(current).toHaveBeenCalledTimes(1);expect(result.market.identity.market).toEqual(f.anchored);
  expect((rpc as any).mock.calls.every(([method]:[string])=>method==='eth_call')).toBe(true);
 });
 it('prefers an available canonical recent header and cannot answer unrelated numbers from a marker',async()=>{
  const f=fixture();f.recent.set(100,hash(999));const read=f.hashReader();expect(await read(100)).toBe(hash(999));expect(f.query).toHaveBeenCalledTimes(1);
  expect(await f.hashReader()(102)).toBeNull();expect(await f.hashReader()(9000)).toBeNull();
 });
 it('refuses early header loss, mismatched initialization/boundary and invalidated pending or ready identities',async()=>{
  for(const change of['early','initial','boundary','pending_orphan','ready_orphan']as const){
   const f=fixture();
   if(change==='early')f.anchored.canonicalInitialization.initialOccurredAt=new Date(at-60_000).toISOString();
   if(change==='initial')f.anchored.canonicalInitialization.initialHash=hash(999);
   if(change==='boundary')f.capture.value.startHash=hash(999);
   if(change.includes('orphan')){f.rows[0].identity.canonicalIdentityInvalid=true;f.rows[0].status=change==='ready_orphan'?'ready':'pending';}
   expect(await f.hashReader()(100)).toBeNull();
  }
 });
 it('fails closed during stale/deep-reorg capture, changed creation, impossible revision or a dated historical request',async()=>{
  for(const change of['capture_failed','stale','behind','future_revision','creation_changed','historical_request']as const){
   const f=fixture();if(change==='capture_failed')f.capture.capture_ok='false';if(change==='stale')f.capture.health_at=new Date(at-100_000);
   if(change==='behind')f.capture.block_number=8000;if(change==='future_revision')f.capture.revision='0';
   if(change==='creation_changed')f.fact.block_hash=hash(999);if(change==='historical_request')f.block.timestamp=initialAt;
   expect(await f.hashReader()(100)).toBeNull();
  }
 });
 it('authenticates exact permanent Stockwave creation proof after expiry, rejecting altered constructor proof',async()=>{
  const f=fixture(),creator=`0x${'1'.repeat(40)}`,salt=hash(123),derived=freshStockwaveCreate2Address({name:'Anchored Stockwave',symbol:'AS',creator,salt});
  const currencies=[derived.address,quote].sort(),poolKey={currency0:currencies[0],currency1:currencies[1],fee:500,tickSpacing:10,hooks:ZeroAddress};
  const identity={...f.identity,poolKey,poolId:market.freshStockwavePoolId(poolKey),tokenAddress:derived.address};
  Object.assign(f.fact,{token_address:derived.address,protocol:'stockwave',block_number:100,block_hash:hash(100),tx_hash:hash(900),log_index:2,launched_at:initialAt,
   proof:{version:1,classification:'authenticated_factory_create2',controller:FRESH_STOCKWAVE_FACTORY,deployer:FRESH_STOCKWAVE_DEPLOYER,topic:FRESH_STOCKWAVE_LAUNCH_TOPIC,
    historicalCodeBasis:'bsc_bep344_persistent_runtime_inference',creator,salt,name:'Anchored Stockwave',symbol:'AS',initcodeHash:derived.initcodeHash,calldataHash:hash(300),launchHash:hash(301),market:identity,
    codeEvidence:{version:1,chainId:56,genesisHash:FRESH_BSC_GENESIS_HASH,observedBlock:{number:100,hash:hash(100),timestamp:Date.parse(initialAt)/1000},factoryRuntimeHash:FRESH_STOCKWAVE_FACTORY_CODE_HASH,
     deployerRuntimeHash:FRESH_STOCKWAVE_DEPLOYER_CODE_HASH,tokenCreationCodeHash:FRESH_STOCKWAVE_CREATION_CODE_HASH,immutabilityRule:'bsc_bep344_eip6780'}}});
  f.rows.splice(0);expect(await f.hashReader()(100)).toBe(hash(100));f.fact.proof.initcodeHash=hash(999);expect(await f.hashReader()(100)).toBeNull();
 });
 it('recognizes invalidation on either a direct identity or its ready envelope',()=>{
  expect(freshMarketIdentityInvalid({canonicalIdentityInvalid:true})).toBe(true);expect(freshMarketIdentityInvalid({market:{canonicalIdentityInvalid:true}})).toBe(true);
  expect(freshMarketIdentityInvalid({market:fixture().anchored})).toBe(false);
 });
});
