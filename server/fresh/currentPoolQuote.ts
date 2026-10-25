import {Interface,getCreate2Address,keccak256,solidityPackedKeccak256} from 'ethers';
import {PCS_V2_FACTORY,WBNB} from '../launchpad.js';
import {freshAddress,freshHash} from './capture.js';
import {TRUSTED_QUOTE_FEEDS} from '../nodeMarketProtocols.js';
import {validateFreshPcsV2FactoryCode,FRESH_PCS_V2_FACTORY_RUNTIME_HASH,FRESH_PCS_V2_PAIR_INITCODE_HASH,FRESH_PCS_V2_PAIR_RUNTIME_HASH} from './flapQuoteRecovery.js';
import {freshHistoricalValuation,type FreshValuationReadOptions} from './valuationContext.js';
const abi=new Interface(['function decimals()view returns(uint8)','function factory()view returns(address)','function token0()view returns(address)',
  'function token1()view returns(address)','function getPair(address,address)view returns(address)','function getReserves()view returns(uint112,uint112,uint32)']);
export const FRESH_CURRENT_STABLE_BRIDGE='0x55d398326f99059ff775485246999027b3197955';
export const freshPoolQuotePair=(quote:string,settlement:string)=>getCreate2Address(PCS_V2_FACTORY,solidityPackedKeccak256(['address','address'],[quote,settlement].sort()),FRESH_PCS_V2_PAIR_INITCODE_HASH).toLowerCase();
export const freshPoolNativePair=(quote:string)=>freshPoolQuotePair(quote,WBNB);

/** A current quote discovered from an authenticated launch controller is an
 * asset, not an assertion of a stock price or a peg. Its one-hop PCS V2/WBNB
 * pool supplies a raw reserve ratio after exact template/factory/asset checks.
 * Current precision is observed at this same block; none of this authorizes a
 * historical decimals answer, reserve, trade settlement or fee attribution. */
async function readPoolConversion(quoteAddress:string,settlementAddress:string,options:FreshValuationReadOptions){
  const quote=freshAddress(quoteAddress),settlement=freshAddress(settlementAddress),{rpc,block}=options,stamp=Date.parse(block.timestamp),age=Date.now()-stamp;
  const historical=freshHistoricalValuation(options);
  if(!quote||!settlement||quote===settlement||!TRUSTED_QUOTE_FEEDS[settlement]||!freshHash(block.hash)||!Number.isSafeInteger(block.number)||block.number<0||!Number.isFinite(stamp)
    ||!historical&&(age< -5000||age>30000))throw Error('pool_quote_current_identity_invalid');
  const pair=freshPoolQuotePair(quote,settlement),assets=[quote,settlement].sort(),at={blockHash:block.hash,requireCanonical:true};
  if(await rpc<string>('eth_chainId',[])!=='0x38')throw Error('pool_quote_chain_invalid');
  const[factoryCode,pairCode,quoteCode,settlementCode]=await Promise.all([PCS_V2_FACTORY,pair,quote,...(settlement===WBNB?[]:[settlement])].map(to=>rpc<string>('eth_getCode',[to,at])));
  validateFreshPcsV2FactoryCode(factoryCode);
  const assetCode=(code:unknown)=>typeof code==='string'&&/^0x(?:[\da-f]{2})+$/.test(code)&&code.length<=2+64*1024*2;
  if(typeof pairCode!=='string'||!/^0x[\da-f]{29962}$/.test(pairCode)||keccak256(pairCode)!==FRESH_PCS_V2_PAIR_RUNTIME_HASH
    ||!assetCode(quoteCode)||(settlement!==WBNB&&!assetCode(settlementCode)))throw Error('pool_quote_code_invalid');
  const call=async(to:string,method:string,args:unknown[]=[])=>{
    const raw=await rpc<string>('eth_call',[{to,data:abi.encodeFunctionData(method,args)},at]);
    try{if(typeof raw!=='string'||!/^0x(?:[\da-f]{2})*$/.test(raw)||raw.length>1026)throw Error();
      const result=abi.decodeFunctionResult(method,raw);if(abi.encodeFunctionResult(method,[...result])!==raw)throw Error();return result;
    }catch{throw Error('pool_quote_state_invalid');}
  };
  const[registered,factory,token0,token1,reserves,quotePrecision,settlementPrecision]=await Promise.all([
    call(PCS_V2_FACTORY,'getPair',[quote,settlement]),call(pair,'factory'),call(pair,'token0'),call(pair,'token1'),call(pair,'getReserves'),
    call(quote,'decimals'),call(settlement,'decimals'),
  ]);
  if(String(registered[0]).toLowerCase()!==pair||String(factory[0]).toLowerCase()!==PCS_V2_FACTORY||String(token0[0]).toLowerCase()!==assets[0]
    ||String(token1[0]).toLowerCase()!==assets[1])throw Error('pool_quote_identity_mismatch');
  const quoteDecimals=Number(quotePrecision[0]),settlementDecimals=Number(settlementPrecision[0]);
  if(!Number.isInteger(quoteDecimals)||quoteDecimals<0||quoteDecimals>36||!Number.isInteger(settlementDecimals)||settlementDecimals<0||settlementDecimals>36
    ||settlement===WBNB&&settlementDecimals!==18)throw Error('pool_quote_precision_invalid');
  const quoteIs0=assets[0]===quote,quoteRaw=BigInt(reserves[quoteIs0?0:1]),settlementRaw=BigInt(reserves[quoteIs0?1:0]);
  if(quoteRaw<=0n||settlementRaw<=0n)throw Error('pool_quote_no_liquidity');
  return{quoteDecimals,quoteRaw,settlementToken:settlement,settlementDecimals,settlementRaw,observedAt:block.timestamp,
    identity:{kind:historical?'authenticated_historical_pcs_v2_trusted':'authenticated_current_pcs_v2_trusted',protocol:'pcs_v2',factory:PCS_V2_FACTORY,pair,token0:assets[0],token1:assets[1],quoteToken:quote,settlementToken:settlement,
      factoryRuntimeHash:FRESH_PCS_V2_FACTORY_RUNTIME_HASH,pairInitcodeHash:FRESH_PCS_V2_PAIR_INITCODE_HASH,pairRuntimeHash:FRESH_PCS_V2_PAIR_RUNTIME_HASH,quoteDecimals,settlementDecimals},
    state:{quoteReserveRaw:String(quoteRaw),settlementReserveRaw:String(settlementRaw)}};
}

/** A bounded one-hop conversion to a trusted feed asset. The reserve ratio is
 * never treated as USD: callers must read the actual dated settlement feed. */
export const readFreshPoolQuoteConversion=readPoolConversion;
export async function readFreshPoolNativeConversion(quote:string,options:FreshValuationReadOptions){
  const value=await readPoolConversion(quote,WBNB,options);
  return{quoteDecimals:value.quoteDecimals,quoteRaw:value.quoteRaw,nativeRaw:value.settlementRaw,observedAt:value.observedAt,
    identity:{kind:freshHistoricalValuation(options)?'authenticated_historical_pcs_v2_native':'authenticated_current_pcs_v2_native',protocol:'pcs_v2',factory:PCS_V2_FACTORY,pair:value.identity.pair,token0:value.identity.token0,token1:value.identity.token1,
      quoteToken:value.identity.quoteToken,nativeToken:WBNB,factoryRuntimeHash:FRESH_PCS_V2_FACTORY_RUNTIME_HASH,pairInitcodeHash:FRESH_PCS_V2_PAIR_INITCODE_HASH,
      pairRuntimeHash:FRESH_PCS_V2_PAIR_RUNTIME_HASH,quoteDecimals:value.quoteDecimals},state:{quoteReserveRaw:String(value.quoteRaw),nativeReserveRaw:String(value.settlementRaw)}};
}
