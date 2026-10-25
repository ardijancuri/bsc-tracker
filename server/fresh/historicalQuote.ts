import {Interface} from 'ethers';
import type {Rpc} from '../rpc.js';
import {TRUSTED_QUOTE_FEEDS} from '../nodeMarketProtocols.js';
import {MarketDecimal} from '../nodeMarketMath.js';
import type {FreshPriceBlock} from './pricing.js';

// Historical rounds are durable oracle observations, even when the node no
// longer exposes the old EVM state. These reads happen at a *new* canonical
// anchor and retain that identity; they never masquerade as old eth_call data.
// https://docs.chain.link/data-feeds/price-feeds/historical-data
const abi=new Interface(['function decimals() view returns(uint8)','function description() view returns(string)',
  'function latestRoundData() view returns(uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)',
  'function getRoundData(uint80) view returns(uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)']);
const hash=(s:unknown):s is string=>typeof s==='string'&&/^0x[\da-f]{64}$/.test(s);
const address=(s:unknown):s is string=>typeof s==='string'&&/^0x[\da-f]{40}$/.test(s);
const MAX_CALLS=48,MAX_BYTES=32*1024,DEADLINE_MS=8000;
const time=(b:FreshPriceBlock)=>Date.parse(b.timestamp)/1000;
const sameBlock=(a:FreshPriceBlock,b:FreshPriceBlock)=>a.number===b.number&&a.hash===b.hash&&a.timestamp===b.timestamp;
export interface FreshHistoricalQuoteEvidence {
  version:1;kind:'historical_oracle_round';tokenAddress:string;feed:string;target:FreshPriceBlock;anchor:FreshPriceBlock;
  selectedRound:string;nextRound:string|null;priceUsd:string;calls:{data:string;result:string}[];
}
type Round={id:bigint;answer:bigint;started:number;updated:number;answered:bigint};
function round(result:ReturnType<Interface['decodeFunctionResult']>):Round {
  const r={id:BigInt(result[0]),answer:BigInt(result[1]),started:Number(result[2]),updated:Number(result[3]),answered:BigInt(result[4])};
  if(r.id<=0n||r.answer<=0n||!Number.isSafeInteger(r.started)||!Number.isSafeInteger(r.updated)||r.started<=0||r.started>r.updated||r.answered<r.id)throw Error('historical_oracle_round_invalid');
  return r;
}
function block(b:FreshPriceBlock){if(!Number.isSafeInteger(b.number)||b.number<0||!hash(b.hash)||!Number.isSafeInteger(time(b)))throw Error('historical_oracle_block_invalid');}
/** The ingestion caller must independently verify both headers are canonical
 * before admitting retained proof. A reused proof must match its exact target.
 * Only a dense, same-phase interval with consecutive bracketing rounds passes.
 * Missing rounds, phase crossings and non-monotonic observations fail closed. */
export async function recoverFreshHistoricalQuote(options:{rpc:Rpc;tokenAddress:string;target:FreshPriceBlock;anchor:FreshPriceBlock;
  prior?:FreshHistoricalQuoteEvidence;now?:()=>number}):Promise<FreshHistoricalQuoteEvidence>{
  const {rpc,target,anchor}=options,token=options.tokenAddress.toLowerCase(),feed=TRUSTED_QUOTE_FEEDS[token],now=options.now??Date.now;
  block(target);block(anchor);
  if(!address(token)||!feed||anchor.number<target.number||time(anchor)<time(target))throw Error('historical_oracle_identity_invalid');
  const start=now(),calls:FreshHistoricalQuoteEvidence['calls']=[],pending=new Map<string,Promise<string>>();
  const prior=options.prior;
  if(prior&&(prior.version!==1||prior.kind!=='historical_oracle_round'||prior.tokenAddress!==token||prior.feed!==feed.feed
    ||!sameBlock(prior.target,target)||!sameBlock(prior.anchor,anchor)||!Array.isArray(prior.calls)||prior.calls.length>MAX_CALLS
    ||Buffer.byteLength(JSON.stringify(prior))>MAX_BYTES))throw Error('historical_oracle_prior_invalid');
  const saved=new Map<string,string>();
  for(const c of prior?.calls??[]){if(!/^0x[\da-f]*$/.test(c.data)||!/^0x(?:[\da-f]{2}){1,1024}$/.test(c.result)||saved.has(c.data))throw Error('historical_oracle_prior_invalid');saved.set(c.data,c.result);}
  const read=async(method:string,args:unknown[]=[]):Promise<ReturnType<Interface['decodeFunctionResult']>>=>{
    const data=abi.encodeFunctionData(method,args);let work=pending.get(data);
    if(!work){if(pending.size>=MAX_CALLS||now()-start>DEADLINE_MS)throw Error('historical_oracle_work_bounds');
      work=(async()=>{const result=saved.get(data)??await rpc<string>('eth_call',[{to:feed.feed,data},{blockHash:anchor.hash,requireCanonical:true}]);
        if(typeof result!=='string'||!/^0x(?:[\da-f]{2}){1,1024}$/i.test(result))throw Error('historical_oracle_response_invalid');
        calls.push({data,result:result.toLowerCase()});if(Buffer.byteLength(JSON.stringify(calls))>MAX_BYTES)throw Error('historical_oracle_work_bounds');return result;})();pending.set(data,work);}
    return abi.decodeFunctionResult(method,await work);
  };
  const [precision,description,current]=await Promise.all([read('decimals'),read('description'),read('latestRoundData')]);
  const decimals=Number(precision[0]),latest=round(current),timestamp=time(target),anchorTime=time(anchor);
  if(String(description[0])!==feed.description||!Number.isInteger(decimals)||decimals<0||decimals>36||latest.updated>anchorTime)throw Error('historical_oracle_feed_unverified');
  const phase=latest.id>>64n,mask=(1n<<64n)-1n,last=latest.id&mask;
  if(phase<=0n||last<=0n)throw Error('historical_oracle_phase_unsupported');
  const cache=new Map<bigint,Round>([[last,latest]]);
  const get=async(n:bigint)=>{let r=cache.get(n);if(!r){r=round(await read('getRoundData',[(phase<<64n)|n]));if(r.id!==((phase<<64n)|n)||r.updated>anchorTime)throw Error('historical_oracle_round_identity');
      for(const [at,seen] of cache)if(at<n&&seen.updated>r.updated||at>n&&seen.updated<r.updated)throw Error('historical_oracle_nonmonotonic');cache.set(n,r);}return r;};
  let selected:Round,next:Round|null=null;
  if(latest.updated<=timestamp)selected=latest;
  else{
    let low=1n,high=last;const first=await get(low);
    if(first.updated>timestamp)throw Error('historical_oracle_phase_unsupported');
    while(high-low>1n){const middle=(low+high)/2n,candidate=await get(middle);if(candidate.updated<=timestamp)low=middle;else high=middle;}
    selected=await get(low);next=await get(high);
    if(next.id!==selected.id+1n||next.updated<=timestamp||selected.updated>timestamp)throw Error('historical_oracle_bracket_invalid');
  }
  if(timestamp-selected.updated>feed.maxAgeSeconds||selected.updated>timestamp)throw Error('historical_oracle_stale');
  const proof:FreshHistoricalQuoteEvidence={version:1,kind:'historical_oracle_round',tokenAddress:token,feed:feed.feed,target:{...target},anchor:{...anchor},
    selectedRound:String(selected.id),nextRound:next?String(next.id):null,priceUsd:MarketDecimal.raw(selected.answer,decimals).text(),calls};
  if(prior&&(prior.selectedRound!==proof.selectedRound||prior.nextRound!==proof.nextRound||prior.priceUsd!==proof.priceUsd))throw Error('historical_oracle_prior_invalid');
  if(now()-start>DEADLINE_MS)throw Error('historical_oracle_work_bounds');return proof;
}
