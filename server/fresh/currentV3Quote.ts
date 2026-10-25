import{AbiCoder,Interface,getCreate2Address,keccak256}from'ethers';
import{PCS_V3_FACTORY}from'../launchpad.js';
import{freshAddress,freshHash}from'./capture.js';
import{FRESH_CURRENT_STABLE_BRIDGE}from'./currentPoolQuote.js';
import{freshHistoricalValuation,type FreshValuationReadOptions}from'./valuationContext.js';

// Official Pancake deployments and PoolAddress.sol. The fixed CREATE2 initcode
// authenticates the pool independently of self-reported factory/assets.
// https://developer.pancakeswap.finance/contracts/v3/addresses
// https://github.com/pancakeswap/pancake-v3-contracts/blob/main/projects/v3-periphery/contracts/libraries/PoolAddress.sol
export const FRESH_PCS_V3_DEPLOYER='0x41ff9aa7e16b8b1a8a8dc4f0efacd93d02d071c9';
export const FRESH_PCS_V3_INITCODE_HASH='0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2';
const fee=2500,settlement=FRESH_CURRENT_STABLE_BRIDGE,coder=AbiCoder.defaultAbiCoder();
export const freshPoolStableV3=(quote:string)=>getCreate2Address(FRESH_PCS_V3_DEPLOYER,
 keccak256(coder.encode(['address','address','uint24'],[...[quote,settlement].sort(),fee])),FRESH_PCS_V3_INITCODE_HASH).toLowerCase();
const abi=new Interface(['function decimals()view returns(uint8)','function getPool(address,address,uint24)view returns(address)',
 'function poolDeployer()view returns(address)','function factory()view returns(address)','function token0()view returns(address)','function token1()view returns(address)',
 'function fee()view returns(uint24)','function liquidity()view returns(uint128)',
 'function slot0()view returns(uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint32 feeProtocol,bool unlocked)']);

/** One fixed fee-2500 USDT bridge, CURRENT only. sqrtPrice is an exact raw-unit
 * ratio, not a fabricated reserve or dollar price. The caller must obtain the
 * same-block dated USDT/USD feed separately. No fee sweep or historical scan. */
export async function readFreshPoolStableV3Conversion(quoteAddress:string,options:FreshValuationReadOptions){
 const quote=freshAddress(quoteAddress),{rpc,block}=options,stamp=Date.parse(block.timestamp),age=Date.now()-stamp;
 const historical=freshHistoricalValuation(options);
 if(!quote||quote===settlement||!freshHash(block.hash)||!Number.isSafeInteger(block.number)||block.number<0||!Number.isFinite(stamp)||!historical&&(age< -5000||age>30000))throw Error('v3_quote_current_identity_invalid');
 const pair=freshPoolStableV3(quote),assets=[quote,settlement].sort(),at={blockHash:block.hash,requireCanonical:true};
 if(await rpc<string>('eth_chainId',[])!=='0x38')throw Error('v3_quote_chain_invalid');
 const codes=await Promise.all([PCS_V3_FACTORY,FRESH_PCS_V3_DEPLOYER,pair,quote,settlement].map(to=>rpc<string>('eth_getCode',[to,at])));
 if(codes.some(code=>typeof code!=='string'||!/^0x(?:[\da-f]{2})+$/.test(code)||code.length>2+64*1024*2)
  ||codes[2].length<2050)throw Error('v3_quote_code_invalid');
 const call=async(to:string,method:string,args:unknown[]=[])=>{
  const raw=await rpc<string>('eth_call',[{to,data:abi.encodeFunctionData(method,args)},at]);
  try{if(typeof raw!=='string'||!/^0x(?:[\da-f]{2})*$/.test(raw)||raw.length>1026)throw Error();const result=abi.decodeFunctionResult(method,raw);
   if(abi.encodeFunctionResult(method,[...result])!==raw)throw Error();return result;}catch{throw Error('v3_quote_state_invalid');}
 };
 const[registered,deployer,factory,token0,token1,poolFee,slot,liquidity,quotePrecision,settlementPrecision]=await Promise.all([
  call(PCS_V3_FACTORY,'getPool',[quote,settlement,fee]),call(PCS_V3_FACTORY,'poolDeployer'),call(pair,'factory'),call(pair,'token0'),call(pair,'token1'),
  call(pair,'fee'),call(pair,'slot0'),call(pair,'liquidity'),call(quote,'decimals'),call(settlement,'decimals')]);
 if(String(registered[0]).toLowerCase()!==pair||String(deployer[0]).toLowerCase()!==FRESH_PCS_V3_DEPLOYER||String(factory[0]).toLowerCase()!==PCS_V3_FACTORY
  ||String(token0[0]).toLowerCase()!==assets[0]||String(token1[0]).toLowerCase()!==assets[1]||Number(poolFee[0])!==fee)throw Error('v3_quote_identity_mismatch');
 const quoteDecimals=Number(quotePrecision[0]),settlementDecimals=Number(settlementPrecision[0]);
 if(!Number.isInteger(quoteDecimals)||quoteDecimals<0||quoteDecimals>36||!Number.isInteger(settlementDecimals)||settlementDecimals<0||settlementDecimals>36)throw Error('v3_quote_precision_invalid');
 const sqrt=BigInt(slot[0]),tick=Number(slot[1]),l=BigInt(liquidity[0]),index=Number(slot[2]),cardinality=Number(slot[3]),next=Number(slot[4]);
 if(sqrt<4295128739n||sqrt>=1461446703485210103287273052203988822378723970342n||Math.abs(tick)>887272||!l||!slot[6]
  ||!cardinality||index>=cardinality||next<cardinality)throw Error('v3_quote_no_liquidity_or_state_invalid');
 const quoteIs0=assets[0]===quote,numerator=quoteIs0?sqrt*sqrt:1n<<192n,denominator=quoteIs0?1n<<192n:sqrt*sqrt;
 return{quoteDecimals,settlementToken:settlement,settlementDecimals,rawRatio:{numerator,denominator},observedAt:block.timestamp,
  identity:{kind:historical?'authenticated_historical_pcs_v3_trusted':'authenticated_current_pcs_v3_trusted',protocol:'pcs_v3',factory:PCS_V3_FACTORY,deployer:FRESH_PCS_V3_DEPLOYER,pair,token0:assets[0],token1:assets[1],fee,
   poolInitcodeHash:FRESH_PCS_V3_INITCODE_HASH,factoryRuntimeHash:keccak256(codes[0]),deployerRuntimeHash:keccak256(codes[1]),pairRuntimeHash:keccak256(codes[2]),
   quoteToken:quote,settlementToken:settlement,quoteDecimals,settlementDecimals},state:{conversionSqrtPriceX96:String(sqrt),conversionLiquidityRaw:String(l),conversionTick:String(tick)}};
}
