import {Interface} from 'ethers';
import type {Rpc} from '../rpc.js';
import {PCS_V2_FACTORY,WBNB} from '../launchpad.js';
import {ratioPrice} from '../nodeMarketMath.js';
import type {FreshStateReadEvidence} from './stateEvidence.js';
import type {FreshPriceBlock} from './pricing.js';
import type {FreshLog} from './capture.js';
const abi=new Interface(['function decimals() view returns(uint8)','function factory() view returns(address)',
 'function token0() view returns(address)','function token1() view returns(address)','function getPair(address,address) view returns(address)',
 'function getReserves() view returns(uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)','event Sync(uint112 reserve0,uint112 reserve1)']);
const topic=abi.getEvent('Sync')!.topicHash;
const address=(v:unknown):v is string=>typeof v==='string'&&/^0x[\da-f]{40}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^0x[\da-f]{64}$/.test(v);
export interface FreshHistoricalPoolEvidence {
 version:1;kind:'historical_v2_reserves';tokenAddress:string;pool:string;quoteAddress:string;tokenDecimals:number;quoteDecimals:number;
 source:FreshStateReadEvidence;target:FreshPriceBlock;fromBlock:number;toBlock:number;lastSync:FreshLog|null;priceQuote:string;
}
/** Reserves are event-sourced between a genuinely observed earlier pool state
 * and the target. A current price/current token row cannot seed this repair.
 * Only the existing authenticated PCS V2/WBNB route is supported here. */
export async function recoverFreshHistoricalPool(options:{rpc:Rpc;tokenAddress:string;tokenDecimals:number;target:FreshPriceBlock;source:FreshStateReadEvidence;
 canonicalHash:(number:number)=>Promise<string|null>;prior?:FreshHistoricalPoolEvidence}):Promise<FreshHistoricalPoolEvidence>{
 const {source,target,rpc,canonicalHash}=options,token=options.tokenAddress.toLowerCase();
 if(!address(token)||!hash(target.hash)||!Number.isSafeInteger(target.number)||!Number.isInteger(options.tokenDecimals)||options.tokenDecimals<0||options.tokenDecimals>255
  ||source.version!==1||!hash(source.blockHash)||!Number.isSafeInteger(source.blockNumber)||source.blockNumber>target.number
  ||target.number-source.blockNumber>4096||!Array.isArray(source.calls)||source.calls.length>128)throw Error('historical_pool_identity_invalid');
 if(await canonicalHash(source.blockNumber)!==source.blockHash||await canonicalHash(target.number)!==target.hash)throw Error('historical_pool_noncanonical');
 const calls=new Map<string,string>();
 for(const c of source.calls){if(!address(c.to)||!/^0x(?:[\da-f]{2})*$/.test(c.data)||!/^0x(?:[\da-f]{2})*$/.test(c.result))throw Error('historical_pool_source_invalid');const key=c.to+':'+c.data;if(calls.has(key))throw Error('historical_pool_source_invalid');calls.set(key,c.result);}
 const read=(to:string,method:string,args:unknown[]=[])=>{const raw=calls.get(to+':'+abi.encodeFunctionData(method,args));if(raw===undefined)throw Error('historical_pool_source_incomplete');return abi.decodeFunctionResult(method,raw);};
 const pool=String(read(PCS_V2_FACTORY,'getPair',[token,WBNB])[0]).toLowerCase();
 if(!address(pool)||pool==='0x'+'0'.repeat(40)||String(read(pool,'factory')[0]).toLowerCase()!==PCS_V2_FACTORY)throw Error('historical_pool_unverified');
 const token0=String(read(pool,'token0')[0]).toLowerCase(),token1=String(read(pool,'token1')[0]).toLowerCase();
 if(token0===token1||![token0,token1].includes(token)||![token0,token1].includes(WBNB))throw Error('historical_pool_assets_invalid');
 const quoteDecimals=Number(read(WBNB,'decimals')[0]),oldDecimals=Number(read(token,'decimals')[0]);
 if(quoteDecimals!==18||oldDecimals!==options.tokenDecimals)throw Error('historical_pool_precision_invalid');
 const initial=read(pool,'getReserves');let reserve0=BigInt(initial[0]),reserve1=BigInt(initial[1]);
 const fromBlock=source.blockNumber+1,toBlock=target.number;
 const prior=options.prior;
 if(prior&&(prior.version!==1||prior.kind!=='historical_v2_reserves'||prior.tokenAddress!==token||prior.pool!==pool||prior.quoteAddress!==WBNB
  ||prior.tokenDecimals!==options.tokenDecimals||prior.quoteDecimals!==18||JSON.stringify(prior.source)!==JSON.stringify(source)
  ||JSON.stringify(prior.target)!==JSON.stringify(target)||prior.fromBlock!==fromBlock||prior.toBlock!==toBlock))throw Error('historical_pool_prior_invalid');
 const logs=prior?(prior.lastSync?[prior.lastSync]:[]):fromBlock>toBlock?[]:await rpc<FreshLog[]>('eth_getLogs',[{address:pool,fromBlock:'0x'+fromBlock.toString(16),toBlock:'0x'+toBlock.toString(16),topics:[topic]}]);
 if(!Array.isArray(logs)||logs.length>512)throw Error('historical_pool_work_bounds');
 let lastSync:FreshLog|null=null,previous:[number,number,number]|null=null;
 const headers=new Map<number,string|null>();
 for(const l of logs){
  if(!l||l.removed||l.address!==pool||l.topics.length!==1||l.topics[0]!==topic||!/^0x[\da-f]{128}$/.test(l.data)
   ||!hash(l.transactionHash)||!hash(l.blockHash)||![l.blockNumber,l.transactionIndex,l.logIndex].every(x=>/^0x[\da-f]{1,16}$/.test(x)))throw Error('historical_pool_log_invalid');
  const position=[Number(BigInt(l.blockNumber)),Number(BigInt(l.transactionIndex)),Number(BigInt(l.logIndex))] as [number,number,number];
  if(position[0]<fromBlock||position[0]>toBlock||previous&&(position[0]<previous[0]||position[0]===previous[0]&&(position[1]<previous[1]||position[1]===previous[1]&&position[2]<=previous[2])))throw Error('historical_pool_log_order_invalid');
  if(!headers.has(position[0]))headers.set(position[0],await canonicalHash(position[0]));
  if(headers.get(position[0])!==l.blockHash)throw Error('historical_pool_noncanonical');
  const parsed=abi.decodeEventLog('Sync',l.data,l.topics);reserve0=BigInt(parsed[0]);reserve1=BigInt(parsed[1]);lastSync=l;previous=position;
 }
 if(reserve0<=0n||reserve1<=0n)throw Error('historical_pool_empty');
 const quote=token0===token?reserve1:reserve0,quantity=token0===token?reserve0:reserve1;
 const priceQuote=ratioPrice(quote,quantity,quoteDecimals,options.tokenDecimals);
 if(!priceQuote)throw Error('historical_pool_price_invalid');
 if(prior&&prior.priceQuote!==priceQuote)throw Error('historical_pool_prior_invalid');
 return{version:1,kind:'historical_v2_reserves',tokenAddress:token,pool,quoteAddress:WBNB,tokenDecimals:options.tokenDecimals,quoteDecimals,
  source,target:{...target},fromBlock,toBlock,lastSync,priceQuote};
}
