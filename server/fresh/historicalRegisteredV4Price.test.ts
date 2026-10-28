import{afterEach,describe,expect,it,vi}from'vitest';
import{ZeroAddress,toBeHex}from'ethers';
import type{Rpc}from'../rpc.js';import{WBNB}from'../launchpad.js';
import{anchorFreshMarketInitialization}from'./currentMarketAnchor.js';
import{freshStockwavePoolId,FRESH_UNISWAP_V4_BSC_MANAGER,stockwavePoolManagerInterface}from'./stockwaveMarket.js';
import{recoverFreshRegisteredV4Price}from'./historicalRegisteredV4Price.js';
import*as v3 from'./historicalV3Quote.js';
import{readFileSync}from'node:fs';import{gunzipSync}from'node:zlib';
import{createFreshReceiptRecovery}from'./recovery.js';import{normalizeFreshReceipt}from'./decode.js';import{createFreshStateEvidenceRpc}from'./stateEvidence.js';import{freshTokenMetadata,freshQuoteUsd}from'./pricing.js';import{MarketDecimal}from'../nodeMarketMath.js';
const h=(n:number)=>'0x'+n.toString(16).padStart(64,'0'),token='0x'+'9'.repeat(40),USDT='0x55d398326f99059ff775485246999027b3197955';
function fixture(quote=WBNB){
 const time=(n:number)=>new Date(Date.now()-60000+(n-120)*1000).toISOString(),target={number:120,hash:h(120),timestamp:time(120)},anchor={number:140,hash:h(140),timestamp:new Date().toISOString()},boundary={number:50,hash:h(50)};
 const fact={token_address:token,status:'eligible',protocol:'evm_creation',block_number:'80',block_hash:h(80),launched_at:time(80),proof:{creation:'canonical_token_birth_v1'}};
 const assets=[token,quote].sort(),poolKey={currency0:assets[0],currency1:assets[1],fee:500,tickSpacing:10,hooks:ZeroAddress};
 const identity=anchorFreshMarketInitialization({version:1,manager:FRESH_UNISWAP_V4_BSC_MANAGER,poolId:freshStockwavePoolId(poolKey),poolKey,tokenAddress:token,quoteAddress:quote,
  initial:{sqrtPriceX96:String(1n<<96n),tick:0,blockNumber:100,blockHash:h(100),transactionHash:h(999),logIndex:1}},fact,{boundary,captureRevision:'1',initialOccurredAt:time(100),confirmedThrough:{number:110,hash:h(110),occurredAt:time(110)}});
 let liquidity=10n**18n;
 const rpc=vi.fn(async(method:string,params:unknown[])=>{expect(method).toBe('eth_call');expect(params[1]).toEqual({blockHash:target.hash,requireCanonical:true});return stockwavePoolManagerInterface.encodeFunctionResult('extsload',[[toBeHex(1n<<96n,32),toBeHex(liquidity,32)]]);})as unknown as Rpc;
 return{rpc,target,anchor,tokenAddress:token,verifiedMetadata:{address:token,name:null,symbol:null,decimals:18,supplyRaw:null,block:target},identity,launchFact:fact,boundary,captureRevision:'1',captureNumber:140,canonicalHash:async(n:number)=>h(n),setLiquidity:(v:bigint)=>{liquidity=v;}};
}
afterEach(()=>vi.restoreAllMocks());
describe('canonical registered V4 historical transfer prices',()=>{
 it('uses only actual target state and preserves a compact exact raw ratio',async()=>{const f=fixture(),p=await recoverFreshRegisteredV4Price(f);expect(p.priceNative).toBe('1');expect(p.state.calls).toHaveLength(1);expect(p.target).toEqual(f.target);expect(p.conversion).toBeNull();expect(f.rpc).toHaveBeenCalledTimes(1);});
 it('re-decodes its raw proof with zero RPC and rejects altered derived amounts',async()=>{const f=fixture(),p=await recoverFreshRegisteredV4Price(f),rpc=vi.fn(async()=>{throw Error('no_network');})as unknown as Rpc;expect(await recoverFreshRegisteredV4Price({...f,rpc,prior:p})).toEqual(p);expect(rpc).not.toHaveBeenCalled();await expect(recoverFreshRegisteredV4Price({...f,rpc,prior:{...p,priceNative:'2'}})).rejects.toThrow('prior_invalid');});
 it.each(['future','creation','launch','marker','pool','boundary','revision','initial_time','invalid']as const)('rejects %s identity before any state read',async(change)=>{const f=fixture();if(change==='future')f.identity.initial.blockNumber=121;if(change==='creation')f.launchFact.block_number='101';if(change==='launch')f.launchFact.status='pending';if(change==='marker')f.identity.canonicalInitialization.launchDigest='0'.repeat(64);if(change==='pool')f.identity.poolId=h(9);if(change==='boundary')f.boundary={number:49,hash:h(49)};if(change==='revision')f.captureRevision='0';if(change==='initial_time')f.identity.canonicalInitialization.initialOccurredAt=new Date(Date.parse(f.target.timestamp)+1).toISOString();if(change==='invalid')(f.identity as any).canonicalIdentityInvalid=true;await expect(recoverFreshRegisteredV4Price(f)).rejects.toThrow('identity_invalid');expect(f.rpc).not.toHaveBeenCalled();});
 it.each([80,100,110,120])('rejects orphaned canonical header %s',async(orphan)=>{const f=fixture();await expect(recoverFreshRegisteredV4Price({...f,canonicalHash:async n=>n===orphan?h(999):h(n)})).rejects.toThrow('noncanonical');expect(f.rpc).not.toHaveBeenCalled();});
 it('does not replace a genuine unavailable or empty state with initialization or current prices',async()=>{const f=fixture();f.setLiquidity(0n);await expect(recoverFreshRegisteredV4Price(f)).rejects.toThrow('state_invalid');await expect(recoverFreshRegisteredV4Price({...f,rpc:async()=>{throw Error('historical_state_unavailable');}})).rejects.toThrow('historical_state_unavailable');});
 it.each(['missing','current','wrong_token'])('requires independently verified target precision: %s',async change=>{const f=fixture();if(change==='missing')(f.verifiedMetadata as any).decimals=null;if(change==='current')f.verifiedMetadata.block={...f.anchor};if(change==='wrong_token')f.verifiedMetadata.address=WBNB;await expect(recoverFreshRegisteredV4Price(f)).rejects.toThrow('identity_invalid');expect(f.rpc).not.toHaveBeenCalled();});
 it('rejects a separately captured contradictory raw slot observation',async()=>{const f=fixture(),p=await recoverFreshRegisteredV4Price(f),state=structuredClone(p.state);state.calls[0].result=stockwavePoolManagerInterface.encodeFunctionResult('extsload',[[toBeHex(2n<<96n,32),toBeHex(10n**18n,32)]]);await expect(recoverFreshRegisteredV4Price({...f,source:state,prior:p})).rejects.toThrow('state_conflict');});
 it('composes the exact historical USDT raw ratio with a dated block-end native conversion without assuming a peg or decimals',async()=>{const f=fixture(USDT),conversion={kind:'historical_raw_pool_trusted_v3',anchor:f.anchor,fromBlock:f.target.number-16,ratio:{numerator:'3',denominator:'2'}}as v3.FreshHistoricalV3QuoteEvidence;const spy=vi.spyOn(v3,'recoverFreshHistoricalV3Quote').mockResolvedValue(conversion),p=await recoverFreshRegisteredV4Price(f);expect(p.priceNative).toBe('1.5');expect(spy).toHaveBeenCalledWith(expect.objectContaining({quoteAddress:USDT,settlementAddress:WBNB,target:f.target,observation:'block_end',transactionIndex:0,lookbackBlocks:16}));});
});

describe('real registered V4 transfer repair and normalizer wiring',()=>{
 const actual=()=>JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/registered-v4-historical-transfers.json.gz',import.meta.url))).toString());
 it('revalidates all three actual historical slot/conversion proofs with zero RPC',async()=>{const f=actual(),rpc=vi.fn(async()=>{throw Error('no_network');})as unknown as Rpc,canonicalHash=async(n:number)=>f.headers.find((h:any)=>h.number===n)?.hash??null;expect(f.cases).toHaveLength(3);for(const c of f.cases){expect(c.error).toBeUndefined();expect(await recoverFreshRegisteredV4Price({...c.input,rpc,canonicalHash,prior:c.proof})).toEqual(c.proof);}expect(rpc).not.toHaveBeenCalled();});
 it('normal decoding fills both real NULL transfer values from the same shared proof, retains original fees and reuses the frozen raw observations',async()=>{
  const f=actual(),rpc=vi.fn(async()=>{throw Error('no_network');})as unknown as Rpc;
  for(const token of [...new Set(f.cases.map((c:any)=>c.input.tokenAddress))]){
   const cases=f.cases.filter((c:any)=>c.input.tokenAddress===token),chosen=[...cases].sort((a:any,b:any)=>MarketDecimal.parse(b.proof.quoteLiquidityNative).compare(MarketDecimal.parse(a.proof.quoteLiquidityNative)))[0],input=chosen.input,entry=structuredClone(chosen.entry);
   entry.recoveryEvidence={version:1,target:input.target,metadata:{},quotes:[],pools:[],registeredV4Prices:cases.map((c:any)=>c.proof)};
   const db:any={query:async(sql:string,args:any[])=>{
    if(sql==='SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1')return{rows:[{block_hash:f.headers.find((h:any)=>h.number===Number(args[0]))?.hash}]};
    if(sql==='SELECT * FROM fresh.launch_facts WHERE token_address=$1')return{rows:[input.launchFact]};
    if(sql.startsWith('SELECT to_jsonb(lf)'))return{rows:[{fact:input.launchFact}]};
    if(sql.startsWith('SELECT s.block_number AS start_number'))return{rows:[{start_number:input.boundary.number,start_hash:input.boundary.hash,capture_number:input.captureNumber,revision:input.captureRevision}]};
    if(sql.startsWith('SELECT identity FROM fresh.markets'))return{rows:cases.map((c:any)=>({identity:{market:c.input.identity},status:'pending'}))};
    throw Error('unexpected_database_query');
   }},state=createFreshStateEvidenceRpc(rpc,input.target,entry.stateEvidence),recovery=createFreshReceiptRecovery(db,rpc,entry,input.target,{state:()=>state.snapshot()});
   const price=MarketDecimal.parse(chosen.proof.priceNative).mul(MarketDecimal.parse(chosen.nativeUsd)).text();expect(await recovery.priceUsd(String(token))).toBe(price);
   const decoded=await normalizeFreshReceipt(entry,{number:'0x'+input.target.number.toString(16),hash:input.target.hash,timestamp:'0x'+Math.floor(Date.parse(input.target.timestamp)/1000).toString(16)}as any,{
    knownLaunch:async t=>t===token,eligible:async t=>t.address===token,metadata:async t=>t===token?input.verifiedMetadata:freshTokenMetadata(t,{rpc:state.rpc,block:input.target,requireSupply:false}),priceUsd:t=>t===WBNB?freshQuoteUsd(t,{rpc:state.rpc,block:input.target}):recovery.priceUsd(t)});
   const event=decoded.events.find(e=>e.tokenAddress===token&&e.kind.startsWith('transfer_'));expect(event).toBeDefined();expect(event!.amountUsd).toBe(MarketDecimal.parse(event!.quantity).mul(MarketDecimal.parse(price)).text());expect(event!.feeUsd).not.toBeNull();expect(recovery.snapshot()?.registeredV4Prices).toEqual([chosen.proof]);
  }
  expect(rpc).not.toHaveBeenCalled();
 });
});
