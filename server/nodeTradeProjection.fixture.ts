import type { NodeTradeProjectionInput, PreparedNodeTradeProjection } from './nodeTradeProjection.js';
import { transferTopic } from './swap.js';
export const projectionWallet=`0x${'a'.repeat(40)}`,projectionToken=`0x${'b'.repeat(40)}`,projectionPool=`0x${'c'.repeat(40)}`;
export const projectionWbnb='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',projectionHash=`0x${'d'.repeat(64)}`;
const topic=(value:string)=>`0x${value.slice(2).padStart(64,'0')}`;
export function projectionFixture():{input:NodeTradeProjectionInput;prepared:PreparedNodeTradeProjection}{
 const stamp='2026-10-19T16:53:00.000Z',log=(token:string,from:string,to:string,amount:bigint)=>({address:token,topics:[transferTopic,topic(from),topic(to)],data:`0x${amount.toString(16).padStart(64,'0')}`});
 return {input:{wallet:projectionWallet,live:true,transaction:{hash:projectionHash,from:projectionWallet,to:projectionPool,value:'0x0',blockNumber:'0x64',transactionIndex:'0x2'},
  block:{number:'0x64',hash:projectionHash,timestamp:`0x${(Date.parse(stamp)/1000).toString(16)}`},receipt:{status:'0x1',blockHash:projectionHash,logs:[
   log(projectionToken,projectionPool,projectionWallet,5n*10n**18n),log(projectionWbnb,projectionWallet,projectionPool,10n**18n),
   {address:projectionPool,topics:['0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'],data:'0x'}]}},
  prepared:{metadata:new Map([[projectionToken,{symbol:'TEST',decimals:18}],[projectionWbnb,{symbol:'WBNB',decimals:18}]]),oracle:{price:'600',updatedAt:Date.parse(stamp)/1000},
   conversions:new Map([[projectionWbnb,{tokenAddress:projectionWbnb,priceUsd:'600',marketCapUsd:null,supply:null,timestamp:stamp,blockNumber:'100',blockHash:projectionHash,source:'node',marketId:'fixture',stale:false,supplyEstimated:false,reason:null}]])}};
}
