import {AbiCoder,Interface,getCreate2Address,keccak256} from 'ethers';
import type {Rpc} from '../rpc.js';
import {PCS_V3_FACTORY} from '../launchpad.js';
import {v3MarketAbi,TRUSTED_QUOTE_FEEDS} from '../nodeMarketProtocols.js';
import {freshAddress,freshHash,freshInteger,type FreshLog} from './capture.js';
import {FRESH_PCS_V3_DEPLOYER,FRESH_PCS_V3_INITCODE_HASH} from './currentV3Quote.js';
import {FreshRational} from './accounting.js';
import type {FreshPriceBlock} from './pricing.js';
import {createFreshStateEvidenceRpc,type FreshStateReadEvidence} from './stateEvidence.js';
import {recoverFreshHistoricalQuote,type FreshHistoricalQuoteEvidence} from './historicalQuote.js';

const abi=new Interface(['function getPool(address,address,uint24)view returns(address)','function poolDeployer()view returns(address)',
  'function factory()view returns(address)','function token0()view returns(address)','function token1()view returns(address)','function fee()view returns(uint24)','function decimals()view returns(uint8)']);
const stable=(value:unknown):string=>JSON.stringify(value,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const validBlock=(v:FreshPriceBlock)=>v&&Number.isSafeInteger(v.number)&&v.number>=0&&freshHash(v.hash)===v.hash&&Number.isFinite(Date.parse(v.timestamp))&&new Date(v.timestamp).toISOString()===v.timestamp;
const equal=(a:unknown,b:unknown)=>stable(a)===stable(b);
const toNumber=(v:unknown)=>{const n=Number(freshInteger(v));if(!Number.isSafeInteger(n)||n<0||n>=2**32)throw Error('historical_v3_log_invalid');return n;};
export function freshHistoricalV3Pool(quote:string,settlement:string,fee:number){
  if(!freshAddress(quote)||!freshAddress(settlement)||quote===settlement||![100,500,2500,10000].includes(fee))throw Error('historical_v3_identity_invalid');
  return getCreate2Address(FRESH_PCS_V3_DEPLOYER,keccak256(AbiCoder.defaultAbiCoder().encode(['address','address','uint24'],[...[quote,settlement].sort(),fee])),FRESH_PCS_V3_INITCODE_HASH).toLowerCase();
}
export interface FreshHistoricalV3QuoteEvidence{
  version:1;kind:'historical_raw_pool_trusted_v3';quoteAddress:string;settlementAddress:string;fee:number;target:FreshPriceBlock;transactionIndex:number;
  observation:'before_execution'|'block_end';anchor:FreshPriceBlock;source:FreshPriceBlock;fromBlock:number;toBlock:number;
  identity:{factory:typeof PCS_V3_FACTORY;deployer:typeof FRESH_PCS_V3_DEPLOYER;poolInitcodeHash:typeof FRESH_PCS_V3_INITCODE_HASH;pool:string;token0:string;token1:string};
  codes:{address:string;code:string}[];calls:{to:string;data:string;result:string}[];lastSwap:FreshLog;ratio:{numerator:string;denominator:string};
}

/** The official immutable CREATE2 initcode authenticates the historical pool
 * address independently of current getters. A genuine canonical Swap strictly
 * before the target execution supplies its historical raw-unit spot price.
 * Current slot0, current decimals and same-transaction prices are never used. */
export async function recoverFreshHistoricalV3Quote(options:{rpc:Rpc;quoteAddress:string;settlementAddress:string;fee:number;target:FreshPriceBlock;
  transactionIndex:number;anchor:FreshPriceBlock;canonicalHash:(number:number)=>Promise<string|null>;prior?:FreshHistoricalV3QuoteEvidence;observation?:'before_execution'|'block_end';lookbackBlocks?:16|64|256}):Promise<FreshHistoricalV3QuoteEvidence>{
  const {rpc,target,transactionIndex,canonicalHash,prior}=options,quote=freshAddress(options.quoteAddress),settlement=freshAddress(options.settlementAddress),anchor=prior?.anchor??options.anchor;
  const observation=options.observation??'before_execution',lookback=options.lookbackBlocks??256;
  if(!quote||!settlement||!TRUSTED_QUOTE_FEEDS[settlement]||!validBlock(target)||!validBlock(anchor)||!validBlock(options.anchor)
    ||anchor.number<target.number||anchor.number>options.anchor.number||Date.parse(anchor.timestamp)<Date.parse(target.timestamp)
    ||!Number.isSafeInteger(transactionIndex)||transactionIndex<0||transactionIndex>=2**32||!['before_execution','block_end'].includes(observation)||![16,64,256].includes(lookback))throw Error('historical_v3_identity_invalid');
  const pool=freshHistoricalV3Pool(quote,settlement,options.fee),[token0,token1]=[quote,settlement].sort();
  if(await canonicalHash(target.number)!==target.hash||await canonicalHash(anchor.number)!==anchor.hash)throw Error('historical_v3_noncanonical');
  if(prior&&(Buffer.byteLength(stable(prior))>256*1024||prior.version!==1||prior.kind!=='historical_raw_pool_trusted_v3'||prior.quoteAddress!==quote||prior.settlementAddress!==settlement
    ||prior.fee!==options.fee||!equal(prior.target,target)||prior.transactionIndex!==transactionIndex||prior.observation!==observation
    ||!Array.isArray(prior.codes)||prior.codes.length!==3||!Array.isArray(prior.calls)||prior.calls.length!==6))throw Error('historical_v3_prior_invalid');
  if(!prior&&(Date.now()-Date.parse(anchor.timestamp)>30_000||Date.now()-Date.parse(anchor.timestamp)<-5_000))throw Error('historical_v3_anchor_stale');
  if(!prior&&await rpc<string>('eth_chainId',[])!=='0x38')throw Error('historical_v3_chain_invalid');
  const at={blockHash:anchor.hash,requireCanonical:true},codes:FreshHistoricalV3QuoteEvidence['codes']=[],calls:FreshHistoricalV3QuoteEvidence['calls']=[];
  for(const address of [PCS_V3_FACTORY,FRESH_PCS_V3_DEPLOYER,pool]){
    const saved=prior?.codes.find(c=>c.address===address)?.code;if(prior&&saved===undefined)throw Error('historical_v3_prior_invalid');
    const code=saved??await rpc<string>('eth_getCode',[address,at]);
    if(typeof code!=='string'||!/^0x(?:[\da-f]{2})+$/.test(code)||code.length>2+64*1024*2||address===pool&&code.length<2050)throw Error('historical_v3_code_invalid');
    codes.push({address,code});
  }
  const call=async(to:string,method:string,args:unknown[]=[])=>{
    const data=abi.encodeFunctionData(method,args),saved=prior?.calls.find(c=>c.to===to&&c.data===data)?.result;
    if(prior&&saved===undefined)throw Error('historical_v3_prior_invalid');const result=saved??await rpc<string>('eth_call',[{to,data},at]);
    if(typeof result!=='string'||!/^0x[\da-f]{64}$/.test(result))throw Error('historical_v3_identity_response_invalid');
    const decoded=abi.decodeFunctionResult(method,result);if(abi.encodeFunctionResult(method,[...decoded])!==result)throw Error('historical_v3_identity_response_invalid');
    calls.push({to,data,result});return decoded;
  };
  const [registered,deployer,factory,first,second,fee]=await Promise.all([
    call(PCS_V3_FACTORY,'getPool',[quote,settlement,options.fee]),call(PCS_V3_FACTORY,'poolDeployer'),call(pool,'factory'),call(pool,'token0'),call(pool,'token1'),call(pool,'fee')]);
  // Asset precision is deliberately retained at the historical target separately.
  if(String(registered[0]).toLowerCase()!==pool||String(deployer[0]).toLowerCase()!==FRESH_PCS_V3_DEPLOYER||String(factory[0]).toLowerCase()!==PCS_V3_FACTORY
    ||String(first[0]).toLowerCase()!==token0||String(second[0]).toLowerCase()!==token1||Number(fee[0])!==options.fee)throw Error('historical_v3_identity_mismatch');
  const fromBlock=Math.max(0,target.number-lookback),toBlock=target.number;
  if(prior&&(prior.fromBlock!==fromBlock||prior.toBlock!==toBlock))throw Error('historical_v3_prior_invalid');
  const logs=prior?[prior.lastSwap]:await rpc<FreshLog[]>('eth_getLogs',[{address:pool,fromBlock:'0x'+fromBlock.toString(16),toBlock:'0x'+toBlock.toString(16),topics:[v3MarketAbi.getEvent('Swap')!.topicHash]}]);
  if(!Array.isArray(logs)||!logs.length||logs.length>512)throw Error('historical_v3_swap_unavailable');
  let previous=-1n,selected:FreshLog|undefined;
  for(const log of logs){
    if(!log||log.removed||log.address!==pool||!freshHash(log.blockHash)||!freshHash(log.transactionHash)||!Array.isArray(log.topics)||log.topics.length!==3||log.topics.some(t=>freshHash(t)!==t)
      ||log.topics[0]!==v3MarketAbi.getEvent('Swap')!.topicHash||!/^0x[\da-f]{448}$/.test(log.data))throw Error('historical_v3_log_invalid');
    const bn=toNumber(log.blockNumber),ti=toNumber(log.transactionIndex),li=toNumber(log.logIndex),position=BigInt(bn)*(1n<<64n)+BigInt(ti)*(1n<<32n)+BigInt(li);
    if(bn<fromBlock||bn>toBlock||position<=previous)throw Error('historical_v3_log_invalid');previous=position;
    const parsed=v3MarketAbi.parseLog(log);if(!parsed)throw Error('historical_v3_log_invalid');
    const encoded=v3MarketAbi.encodeEventLog(parsed.fragment,parsed.args);if(encoded.data!==log.data||!equal(encoded.topics,log.topics))throw Error('historical_v3_log_invalid');
    const a=BigInt(parsed.args.amount0),b=BigInt(parsed.args.amount1),sqrt=BigInt(parsed.args.sqrtPriceX96),liquidity=BigInt(parsed.args.liquidity),tick=Number(parsed.args.tick);
    if(!a||!b||(a>0n)===(b>0n)||sqrt<4295128739n||sqrt>=1461446703485210103287273052203988822378723970342n||!liquidity||Math.abs(tick)>887272)throw Error('historical_v3_swap_invalid');
    if(observation==='block_end'||bn<target.number||ti<transactionIndex)selected=log;
  }
  if(!selected)throw Error('historical_v3_preceding_swap_unavailable');
  const raw=prior?null:await rpc<any>('eth_getBlockByNumber',[selected.blockNumber,false]);
  const source=prior?.source??{number:toNumber(raw?.number),hash:raw?.hash,timestamp:new Date(Number(freshInteger(raw?.timestamp))*1000).toISOString()};
  const age=Date.parse(target.timestamp)-Date.parse(source.timestamp);
  if(!validBlock(source)||source.number!==toNumber(selected.blockNumber)||source.hash!==selected.blockHash||age<0||age>120_000||await canonicalHash(source.number)!==source.hash)throw Error('historical_v3_source_invalid');
  const sqrt=BigInt(v3MarketAbi.parseLog(selected)!.args.sqrtPriceX96),numerator=quote===token0?sqrt*sqrt:1n<<192n,denominator=quote===token0?1n<<192n:sqrt*sqrt;
  calls.sort((a,b)=>a.to.localeCompare(b.to)||a.data.localeCompare(b.data));
  const result:FreshHistoricalV3QuoteEvidence={version:1,kind:'historical_raw_pool_trusted_v3',quoteAddress:quote,settlementAddress:settlement,fee:options.fee,target:{...target},transactionIndex,
    observation,anchor:{...anchor},source:{...source},fromBlock,toBlock,identity:{factory:PCS_V3_FACTORY,deployer:FRESH_PCS_V3_DEPLOYER,poolInitcodeHash:FRESH_PCS_V3_INITCODE_HASH,pool,token0,token1},codes,calls,lastSwap:structuredClone(selected),ratio:{numerator:String(numerator),denominator:String(denominator)}};
  if(prior&&!equal(prior,result))throw Error('historical_v3_prior_invalid');return result;
}

/** Caller first authenticates the pool proof with the function above. Exact
 * historical settlement precision and bracketed historical feed are required;
 * no symbol peg, current decimals or dollar quote can enter the calculation. */
export async function valueFreshHistoricalV3QuoteRaw(quoteRaw:string,conversion:FreshHistoricalV3QuoteEvidence,precision:FreshStateReadEvidence,feed:FreshHistoricalQuoteEvidence){
  if(!/^[1-9]\d{0,77}$/.test(quoteRaw)||!equal(feed.target,conversion.target)||feed.tokenAddress!==conversion.settlementAddress)throw Error('historical_v3_value_identity_invalid');
  const unavailable=(async()=>{throw Error('historical_v3_retained_precision_missing');}) as Rpc;
  const saved=createFreshStateEvidenceRpc(unavailable,{number:conversion.target.number,hash:conversion.target.hash},precision);
  if(saved.rejectedPrior)throw Error('historical_v3_retained_precision_invalid');
  const result=await saved.rpc<string>('eth_call',[{to:conversion.settlementAddress,data:abi.encodeFunctionData('decimals')},{blockHash:conversion.target.hash,requireCanonical:true}]);
  const decoded=abi.decodeFunctionResult('decimals',result),decimals=Number(decoded[0]);
  if(!Number.isInteger(decimals)||decimals<0||decimals>255||abi.encodeFunctionResult('decimals',[decimals])!==result)throw Error('historical_v3_retained_precision_invalid');
  const validated=await recoverFreshHistoricalQuote({rpc:unavailable,tokenAddress:feed.tokenAddress,target:feed.target,anchor:feed.anchor,prior:feed});
  const raw=FreshRational.parse(quoteRaw),ratio=new FreshRational(BigInt(conversion.ratio.numerator),BigInt(conversion.ratio.denominator));
  if(ratio.n<=0n||ratio.d<=0n)throw Error('historical_v3_ratio_invalid');
  const value=raw.mul(ratio).div(new FreshRational(10n**BigInt(decimals))).mul(FreshRational.parse(validated.priceUsd));
  return{amountUsd:value.decimal(),amountQ:value.exact(),settlementDecimals:decimals,settlementPriceUsd:validated.priceUsd};
}
