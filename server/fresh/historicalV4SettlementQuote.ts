import{RpcRequestError,type Rpc}from'../rpc.js';import{TRUSTED_QUOTE_FEEDS}from'../nodeMarketProtocols.js';import{WBNB}from'../launchpad.js';
import{FreshRational}from'./accounting.js';import{freshAddress,freshHash,freshInteger,type FreshLog}from'./capture.js';import type{FreshPriceBlock}from'./pricing.js';
import{freshStockwavePoolId,stockwavePoolManagerInterface,FRESH_UNISWAP_V4_BSC_MANAGER as manager,FRESH_UNISWAP_V4_SWAP_TOPIC,type FreshStockwavePoolKey}from'./stockwaveMarket.js';
import{recoverFreshHistoricalV3Quote,type FreshHistoricalV3QuoteEvidence}from'./historicalV3Quote.js';import{isFreshSettlementQuote}from'./settlementQuote.js';
const USDT='0x55d398326f99059ff775485246999027b3197955',zero='0x'+'0'.repeat(40),Q192=1n<<192n;
const stable=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x),same=(a:unknown,b:unknown)=>stable(a)===stable(b);
const validBlock=(v:FreshPriceBlock)=>!!v&&Number.isSafeInteger(v.number)&&v.number>=0&&freshHash(v.hash)===v.hash&&Number.isFinite(Date.parse(v.timestamp))&&new Date(v.timestamp).toISOString()===v.timestamp;
const number=(v:unknown)=>{const n=Number(freshInteger(v));if(!Number.isSafeInteger(n)||n<0||n>=2**32)throw Error('historical_v4_quote_log_invalid');return n;};
type NativeLeg=Omit<FreshHistoricalV3QuoteEvidence,'codes'>;
export interface FreshHistoricalV4SettlementQuote{
 version:1;kind:'historical_registered_quote_native_v4_bridge';quoteAddress:string;target:FreshPriceBlock;transactionIndex:number;observation:'before_execution'|'block_end';
 codes:{address:string;code:string}[];quote:{anchor:FreshPriceBlock;fee:50000;identity:{manager:typeof manager;poolId:string;poolKey:FreshStockwavePoolKey};source:FreshPriceBlock;fromBlock:number;toBlock:number;logs:FreshLog[];lastSwap:FreshLog;ratio:{numerator:string;denominator:string}};
 native:NativeLeg;rawNativeRatio:{numerator:string;denominator:string};capturedV2Authorization?:never;
}
type Options={rpc:Rpc;quoteAddress:string;target:FreshPriceBlock;transactionIndex:number;observation:'before_execution'|'block_end';anchor:FreshPriceBlock;canonicalHash:(n:number)=>Promise<string|null>;prior?:FreshHistoricalV4SettlementQuote};
/** A fixed, hook-free registered settlement quote/USDT v4 market. The full
 * five-word key hashes to the genuine official manager's indexed Swap ID;
 * neither a token name nor a chart infers its pair. This supplies a dated raw
 * market ratio, never wallet acquisition cost or token-launch eligibility. */
export async function recoverFreshHistoricalV4SettlementQuote(o:Options):Promise<FreshHistoricalV4SettlementQuote>{
 const quote=freshAddress(o.quoteAddress),t=o.target,p=o.prior,anchor=p?.quote.anchor??o.anchor;
 if(!quote||!isFreshSettlementQuote(quote)||TRUSTED_QUOTE_FEEDS[quote]||quote===WBNB||!validBlock(t)||!validBlock(anchor)||!validBlock(o.anchor)||anchor.number<t.number||anchor.number>o.anchor.number
  ||Date.parse(anchor.timestamp)<Date.parse(t.timestamp)||!Number.isSafeInteger(o.transactionIndex)||o.transactionIndex<0||o.transactionIndex>=2**32||!['before_execution','block_end'].includes(o.observation))throw Error('historical_v4_quote_identity_invalid');
 if(await o.canonicalHash(t.number)!==t.hash||await o.canonicalHash(anchor.number)!==anchor.hash)throw Error('historical_v4_quote_noncanonical');
 const[currency0,currency1]=[quote,USDT].sort(),key:FreshStockwavePoolKey={currency0,currency1,fee:50000,tickSpacing:500,hooks:zero},poolId=freshStockwavePoolId(key),identity={manager,poolId,poolKey:key}as const;
 if(p&&(p.version!==1||p.kind!=='historical_registered_quote_native_v4_bridge'||p.quoteAddress!==quote||!same(p.target,t)||p.transactionIndex!==o.transactionIndex||p.observation!==o.observation
  ||!same(p.quote.identity,identity)||!Array.isArray(p.codes)||p.codes.length!==3||new Set(p.codes.map(c=>c.address)).size!==3||!Array.isArray(p.quote.logs)||Buffer.byteLength(stable(p))>256*1024))throw Error('historical_v4_quote_prior_invalid');
 const nativeLeg=async()=>{const oldNative=p?{...p.native,codes:p.codes}:undefined,windows=p?[t.number-p.native.fromBlock]:[16,64,256];let last:unknown;
  for(const lookback of windows){if(![16,64,256].includes(lookback))throw Error('historical_v4_quote_prior_invalid');try{return await recoverFreshHistoricalV3Quote({rpc:o.rpc,quoteAddress:USDT,settlementAddress:WBNB,fee:100,target:t,transactionIndex:o.transactionIndex,observation:o.observation,anchor:o.anchor,canonicalHash:o.canonicalHash,prior:oldNative,lookbackBlocks:lookback as 16|64|256});}catch(e){last=e;if(p||e instanceof RpcRequestError||!(e instanceof Error)||!['historical_v3_swap_unavailable','historical_v3_preceding_swap_unavailable'].includes(e.message))throw e;}}throw last;};
 const windows=p?[t.number-p.quote.fromBlock]:[16,64,256];if(windows.some(w=>![16,64,256].includes(w)))throw Error('historical_v4_quote_prior_invalid');
 for(const window of windows){
  const fromBlock=Math.max(0,t.number-window),toBlock=t.number;if(p&&(p.quote.fromBlock!==fromBlock||p.quote.toBlock!==toBlock))throw Error('historical_v4_quote_prior_invalid');
  const logs=p?p.quote.logs:await o.rpc<FreshLog[]>('eth_getLogs',[{address:manager,fromBlock:'0x'+fromBlock.toString(16),toBlock:'0x'+toBlock.toString(16),topics:[FRESH_UNISWAP_V4_SWAP_TOPIC,poolId]}]);
  if(!Array.isArray(logs)||logs.length>128)throw Error('historical_v4_quote_work_bounds');let selected:FreshLog|undefined,previous=-1n;const hashes=new Map<number,string|null>();
  for(const l of logs){
   if(!l||l.removed||l.address!==manager||l.topics?.length!==3||l.topics[0]!==FRESH_UNISWAP_V4_SWAP_TOPIC||l.topics[1]!==poolId||l.topics.some(x=>freshHash(x)!==x)||freshHash(l.blockHash)!==l.blockHash||freshHash(l.transactionHash)!==l.transactionHash||!/^0x[0-9a-f]{384}$/.test(l.data))throw Error('historical_v4_quote_log_invalid');
   const bn=number(l.blockNumber),ti=number(l.transactionIndex),li=number(l.logIndex),position=BigInt(bn)*(1n<<64n)+BigInt(ti)*(1n<<32n)+BigInt(li);
   if(bn<fromBlock||bn>toBlock||position<=previous)throw Error('historical_v4_quote_log_invalid');previous=position;
   if(!hashes.has(bn))hashes.set(bn,await o.canonicalHash(bn));if(hashes.get(bn)!==l.blockHash)throw Error('historical_v4_quote_noncanonical');
   const event=stockwavePoolManagerInterface.parseLog(l);if(!event||event.name!=='Swap')throw Error('historical_v4_quote_log_invalid');const encoded=stockwavePoolManagerInterface.encodeEventLog(event.fragment,event.args);
   if(encoded.data!==l.data||!same(encoded.topics,l.topics))throw Error('historical_v4_quote_log_invalid');const a=BigInt(event.args.amount0),b=BigInt(event.args.amount1),sqrt=BigInt(event.args.sqrtPriceX96),liquidity=BigInt(event.args.liquidity),tick=Number(event.args.tick),fee=Number(event.args.fee);
   if(!a||!b||(a>0n)===(b>0n)||sqrt<4295128739n||sqrt>=1461446703485210103287273052203988822378723970342n||liquidity<=0n||Math.abs(tick)>887272||fee<key.fee||fee>=1_000_000)throw Error('historical_v4_quote_swap_invalid');
   if(o.observation==='block_end'||bn<t.number||ti<o.transactionIndex)selected=l;
  }
  if(!selected){if(p)throw Error('historical_v4_quote_prior_invalid');continue;}
  const raw=p?null:await o.rpc<any>('eth_getBlockByNumber',[selected.blockNumber,false]),source=p?.quote.source??{number:number(raw?.number),hash:raw?.hash,timestamp:new Date(Number(freshInteger(raw?.timestamp))*1000).toISOString()},age=Date.parse(t.timestamp)-Date.parse(source.timestamp);
  if(!validBlock(source)||source.number!==number(selected.blockNumber)||source.hash!==selected.blockHash||age<0||age>120_000||await o.canonicalHash(source.number)!==source.hash)throw Error('historical_v4_quote_source_invalid');
  const native=await nativeLeg(),sqrt=BigInt(stockwavePoolManagerInterface.parseLog(selected)!.args.sqrtPriceX96),ratio={numerator:String(quote===currency0?sqrt*sqrt:Q192),denominator:String(quote===currency0?Q192:sqrt*sqrt)},nativeRatio=native.ratio,combined=new FreshRational(BigInt(ratio.numerator)*BigInt(nativeRatio.numerator),BigInt(ratio.denominator)*BigInt(nativeRatio.denominator)),{codes,...leg}=native;
  const proof:FreshHistoricalV4SettlementQuote={version:1,kind:'historical_registered_quote_native_v4_bridge',quoteAddress:quote,target:{...t},transactionIndex:o.transactionIndex,observation:o.observation,codes:structuredClone(codes),quote:{anchor:{...anchor},fee:50000,identity,source:{...source},fromBlock,toBlock,logs:structuredClone(logs),lastSwap:structuredClone(selected),ratio},native:leg,rawNativeRatio:{numerator:String(combined.n),denominator:String(combined.d)}};
  if(Buffer.byteLength(stable(proof))>256*1024||p&&!same(p,proof))throw Error('historical_v4_quote_prior_invalid');return proof;
 }
 throw Error('historical_v4_quote_swap_unavailable');
}
