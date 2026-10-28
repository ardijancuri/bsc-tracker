import { Interface, ZeroAddress, decodeBytes32String } from 'ethers';
import type { Pool } from 'pg';
import { type Rpc, blockHex, RpcRequestError, type RpcErrorCategory } from '../rpc.js';
import { FOUR_HELPER, FOUR_MANAGERS, FLAP_PORTAL, fourInterface, flapInterface, WBNB, PCS_V2_FACTORY, PCS_V3_FACTORY } from '../launchpad.js';
import { TRUSTED_QUOTE_FEEDS, oracleMarketAbi, poolMarketAbi } from '../nodeMarketProtocols.js';
import { MarketDecimal, ratioPrice, sqrtPrice } from '../nodeMarketMath.js';
import { freshAddress, freshHash, freshInteger } from './capture.js';
import { freshStockwaveMetadataFromFact } from './factoryLaunch.js';
import { readFreshStockwaveMarket, validFreshStockwaveMarketIdentity } from './stockwaveMarket.js';
import {readFreshInfinityClMarket,validFreshInfinityClMarketIdentity}from'./infinityClMarket.js';
import { FRESH_STOCK_QUOTE_TOKEN } from './stockQuote.js';
import {readFreshStockCurrentRawQuote} from './stockCurrentQuote.js';
import {readFreshFlapRawQuote} from './flapQuoteRecovery.js';
import {FRESH_BTCB_QUOTE,readFreshBtcNativeConversion} from './currentBtcQuote.js';
import {FRESH_BNCB_QUOTE,readFreshBncbNativeConversion} from './currentBncbQuote.js';
import {FRESH_SPCXB_QUOTE,readFreshSpcxbNativeConversion} from './currentSpcxbQuote.js';
import {FRESH_CURRENT_STABLE_BRIDGE,readFreshPoolNativeConversion,readFreshPoolQuoteConversion} from './currentPoolQuote.js';
import{readFreshPoolStableV3Conversion}from'./currentV3Quote.js';
import{createFreshCurrentMarketCanonicalHash,freshMarketIdentityInvalid,freshMarketLaunchDigest}from'./currentMarketAnchor.js';
import{freshHistoricalValuation,type FreshValuationReadOptions}from'./valuationContext.js';
import{readFreshTokenAdmission}from'./tracking.js';

const tokenAbi = new Interface(['function decimals() view returns(uint8)', 'function totalSupply() view returns(uint256)', 'function name() view returns(string)', 'function symbol() view returns(string)', 'function balanceOf(address) view returns(uint256)']);
const bytesTokenAbi = new Interface(['function name() view returns(bytes32)', 'function symbol() view returns(bytes32)']);
export interface FreshPriceBlock { number: number; hash: string; timestamp: string }
export interface FreshTokenMetadata { address: string; name: string | null; symbol: string | null; decimals: number; supplyRaw: string | null; block: FreshPriceBlock }
export interface FreshQuote { tokenAddress: string; priceUsd: string; marketCapUsd: string; metadata: FreshTokenMetadata; market: { id: string; address: string; protocol: string; quoteAddress: string; identity: Record<string, unknown>; state: Record<string, string> }; observedAt: string; blockNumber: number; blockHash: string;observationContext?:'historical_block' }
export interface FreshPriceOptions extends FreshValuationReadOptions {
  launchFact?: unknown;
  canonicalHash?: (number: number) => Promise<string | null>;
  /** Previously authenticated canonical Initialize identities from the worker.
   * Ordinary quote/API reads never discover pools by scanning history. */
  marketIdentities?: readonly unknown[];
}

/** Only bounded categories survive into repair diagnostics. Provider messages,
 * response bodies and request parameters never become error properties. */
export class FreshMetadataReadError extends Error {
  readonly field:'decimals'|'total_supply';readonly category:RpcErrorCategory;readonly code:number|null;
  constructor(field:'decimals'|'total_supply',error:unknown){
    const message=error instanceof RpcRequestError?error.message:error instanceof Error&&/^[a-z_]{1,128}$/.test(error.message)?error.message:'token_metadata_unavailable';
    super(message);this.name='FreshMetadataReadError';this.field=field;
    this.category=error instanceof RpcRequestError?error.category:'rpc_error';this.code=error instanceof RpcRequestError?error.code:null;
  }
}
export const freshMetadataDiagnostic=(error:unknown)=>error instanceof FreshMetadataReadError
  ?`token_metadata_${error.field}_${error.category}${error.code===null?'':`_code_${error.code}`}`:null;

/** A positive, authenticated price is never replaced with zero. This narrower
 * status means the supported current markets were fully checked and empty. */
export class FreshNoLiquidityError extends Error {
  constructor(){super('authenticated_markets_no_liquidity');this.name='FreshNoLiquidityError';}
}
export const freshQuoteFailureStatus=(error:unknown):'no_liquidity'|'quote_unavailable'=>error instanceof FreshNoLiquidityError?'no_liquidity':'quote_unavailable';

async function freshRawCall(options:FreshPriceOptions,to:string,data:string){
  if(!freshAddress(to)||!freshHash(options.block.hash))throw new Error('state_identity_invalid');
  const params=[{to,data},{blockHash:options.block.hash,requireCanonical:true}];
  let raw:unknown;
  try{raw=await options.rpc<string>('eth_call',params);}
  catch(error){
    // A transient transport loss gets one immediate retry of the exact same
    // canonical state request. Unsupported state/reverts/cooldowns never retry.
    if(!(error instanceof RpcRequestError)||error.category!=='transport')throw error;
    raw=await options.rpc<string>('eth_call',params);
  }
  if(typeof raw!=='string'||!/^0x(?:[\da-f]{2})*$/i.test(raw))throw new RpcRequestError('state_response_invalid','invalid_response');
  return raw;
}

/** All reads are tied to the canonical block hash. A server that cannot honor
 * block-hash state reads fails explicitly instead of silently using latest. */
export async function freshCall(options: FreshPriceOptions, to: string, abi: Interface, method: string, args: unknown[] = []) {
  const raw=await freshRawCall(options,to,abi.encodeFunctionData(method,args));
  try{return abi.decodeFunctionResult(method,raw);}
  catch{throw new RpcRequestError('state_response_invalid','invalid_response');}
}
export async function freshConfirmedPriceBlock(rpc: Rpc, confirmations = 6): Promise<FreshPriceBlock> {
  const height = Number(freshInteger(await rpc<string>('eth_blockNumber', []))) - Math.max(6, confirmations);
  const block = await rpc<{ number: string; hash: string; timestamp: string }>('eth_getBlockByNumber', [blockHex(height), false]);
  if (!block || Number(freshInteger(block.number)) !== height || !freshHash(block.hash)) throw new Error('state_block_invalid');
  return { number: height, hash: block.hash.toLowerCase(), timestamp: new Date(Number(freshInteger(block.timestamp)) * 1_000).toISOString() };
}
/** Financial quantities need verified precision, independently of whether
 * supply can be read. Current valuation keeps supply mandatory by default. */
export async function freshTokenMetadata(address: string, options: FreshPriceOptions & { requireSupply?: boolean }): Promise<FreshTokenMetadata> {
  const normalized = freshAddress(address); if (!normalized) throw new Error('token_address_invalid');
  const required=async<T>(field:'decimals'|'total_supply',read:()=>Promise<T>)=>{try{return await read();}catch(error){throw new FreshMetadataReadError(field,error);}};
  const [decimals, supply, name, symbol] = await Promise.all([
    required('decimals',async()=>{const value=Number((await freshCall(options,normalized,tokenAbi,'decimals'))[0]);if(!Number.isInteger(value)||value<0||value>255)throw new RpcRequestError('token_precision_unsupported','invalid_response');return value;}),
    required('total_supply',async()=>{const value=BigInt((await freshCall(options,normalized,tokenAbi,'totalSupply'))[0]);if(value<0n)throw new RpcRequestError('token_precision_unsupported','invalid_response');return value;})
      .catch(error=>{if(options.requireSupply===false)return null;throw error;}),
    optionalIdentity(normalized, 'name', options), optionalIdentity(normalized, 'symbol', options),
  ]);
  return { address: normalized, decimals, supplyRaw: supply?.toString() ?? null, name, symbol, block: options.block };
}
async function optionalIdentity(token: string, field: 'name' | 'symbol', options: FreshPriceOptions): Promise<string | null> {
  try{
    // Return types do not change a function selector. Reuse the response when
    // a legacy token returns bytes32 instead of repeating the identical call.
    const raw=await freshRawCall(options,token,tokenAbi.encodeFunctionData(field));let text:string;
    try{text=String(tokenAbi.decodeFunctionResult(field,raw)[0]);}
    catch{text=decodeBytes32String(bytesTokenAbi.decodeFunctionResult(field,raw)[0]);}
    return text.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,field==='name'?256:64)||null;
  }catch{return null;}
}

export async function freshQuoteUsd(quoteAddress: string, options: FreshPriceOptions): Promise<string> {
  const quote = quoteAddress.toLowerCase() === ZeroAddress ? WBNB : quoteAddress.toLowerCase(), trusted = TRUSTED_QUOTE_FEEDS[quote];
  if (!trusted) throw new Error('quote_feed_unsupported');
  const [precision, description, round] = await Promise.all([
    freshCall(options, trusted.feed, oracleMarketAbi, 'decimals'), freshCall(options, trusted.feed, oracleMarketAbi, 'description'), freshCall(options, trusted.feed, oracleMarketAbi, 'latestRoundData'),
  ]);
  const decimals = Number(precision[0]), answer = BigInt(round.answer), updated = Number(round.updatedAt), timestamp = Date.parse(options.block.timestamp) / 1_000;
  if (String(description[0]) !== trusted.description || !Number.isInteger(decimals) || decimals < 0 || decimals > 36 || answer <= 0n
    || updated <= 0 || updated > timestamp || timestamp - updated > trusted.maxAgeSeconds || BigInt(round.answeredInRound) < BigInt(round.roundId)) throw new Error('quote_feed_unverified_or_stale');
  return MarketDecimal.raw(answer, decimals).text();
}

interface QuoteCandidate { quote: string; decimals: number; priceQuote: string; priceRatio?: MarketDecimal; marketQuote?: string; observedAt?: string;
  id: string; address: string; protocol: string; identity: Record<string, unknown>; state: Record<string, string>; liquidity: MarketDecimal }
const currentNativeQuotes=[FRESH_BTCB_QUOTE,FRESH_BNCB_QUOTE,FRESH_SPCXB_QUOTE];
const currentNativeConversion=(quote:string,options:FreshPriceOptions)=>quote===FRESH_BTCB_QUOTE?readFreshBtcNativeConversion(options)
  :quote===FRESH_BNCB_QUOTE?readFreshBncbNativeConversion(options):quote===FRESH_SPCXB_QUOTE?readFreshSpcxbNativeConversion(options)
    :readFreshPoolNativeConversion(quote,options);
async function currentQuoteConversion(quote:string,options:FreshPriceOptions){
  try{
    const value=await currentNativeConversion(quote,options);
    return{...value,settlementToken:WBNB,settlementDecimals:18,settlementRaw:value.nativeRaw};
  }catch(error){
    // A missing/empty direct native market may have an authentic USDT market.
    // This is one fixed extra hop, never a route search or a dollar peg. Node
    // transport/precision/identity errors do not trigger provider-style retries.
    if(currentNativeQuotes.includes(quote)||!(error instanceof Error)||!['pool_quote_code_invalid','pool_quote_no_liquidity'].includes(error.message))throw error;
    try{return await readFreshPoolQuoteConversion(quote,FRESH_CURRENT_STABLE_BRIDGE,options);}
    catch(stableError){
      if(!(stableError instanceof Error)||!['pool_quote_code_invalid','pool_quote_no_liquidity'].includes(stableError.message))throw stableError;
      const value=await readFreshPoolStableV3Conversion(quote,options);
      // These internal ratio terms need not be pool balances. Persist only
      // genuine V3 sqrt/liquidity evidence; do not invent virtual reserves.
      return{...value,settlementRaw:value.rawRatio.numerator,quoteRaw:value.rawRatio.denominator};
    }
  }
}

/** A current V4 state plus a reserve-checked current WBNB/raw-stock query. Raw
 * stock precision cancels before any decimal formatting. Retain only compact
 * source references in the current market row; the full receipt stays in the
 * bounded repair path, never in permanent current pricing state. */
async function stockwavePrice(token: FreshTokenMetadata, options: FreshPriceOptions): Promise<QuoteCandidate | null> {
  const metadata = freshStockwaveMetadataFromFact(options.launchFact, options.block);
  if (!metadata || metadata.address !== token.address || metadata.decimals !== token.decimals || !options.canonicalHash) return null;
  const row = options.launchFact as Record<string, unknown>, proof = row.proof as Record<string, unknown>, market = proof.market;
  if (!validFreshStockwaveMarketIdentity(market) || market.tokenAddress !== token.address || market.quoteAddress !== FRESH_STOCK_QUOTE_TOKEN) return null;
  const creationNumber = Number(row.block_number ?? row.blockNumber), creationHash = String(row.block_hash ?? row.blockHash).toLowerCase();
  const creationTx = String(row.tx_hash ?? row.txHash).toLowerCase(), launchIndex = Number(row.log_index ?? row.logIndex);
  if (market.initial.blockNumber !== creationNumber || market.initial.blockHash !== creationHash || market.initial.transactionHash !== creationTx
    || market.initial.logIndex >= launchIndex || await options.canonicalHash(creationNumber) !== creationHash) throw new Error('stockwave_quote_creation_unverified');
  const [current, conversion, nativePrecision] = await Promise.all([
    readFreshStockwaveMarket({ rpc: options.rpc, identity: market, tokenDecimals: token.decimals, block: options.block }),
    readFreshStockCurrentRawQuote({rpc:options.rpc,block:options.block}),
    freshCall(options, WBNB, tokenAbi, 'decimals'),
  ]);
  const age = (Date.parse(options.block.timestamp) - Date.parse(conversion.source.timestamp)) / 1000;
  if (Number(nativePrecision[0]) !== 18 || conversion.nativeToken !== WBNB || conversion.quoteToken !== market.quoteAddress
    || conversion.target.number !== options.block.number || conversion.target.hash !== options.block.hash
    || conversion.source.number!==options.block.number||conversion.source.hash!==options.block.hash||age!==0) throw new Error('stockwave_quote_conversion_unverified');
  const nativeRaw = BigInt(conversion.nativeRaw), quoteRaw = BigInt(conversion.quoteRaw);
  if (nativeRaw <= 0n || quoteRaw <= 0n) throw new Error('stockwave_quote_conversion_unverified');
  const numerator = BigInt(current.rawQuoteRatio.numerator), denominator = BigInt(current.rawQuoteRatio.denominator);
  const priceRatio = new MarketDecimal(numerator * nativeRaw * 10n ** BigInt(token.decimals), denominator * quoteRaw * 10n ** 18n);
  const virtual = current.virtualQuoteLiquidityRaw;
  const liquidity = new MarketDecimal(BigInt(virtual.numerator) * nativeRaw, BigInt(virtual.denominator) * quoteRaw * 10n ** 18n);
  if (priceRatio.n <= 0n || liquidity.n <= 0n) throw new Error('stockwave_quote_price_invalid');
  return { quote: WBNB, marketQuote: market.quoteAddress, decimals: 18, priceQuote: priceRatio.text(), priceRatio, liquidity,
    observedAt: conversion.source.timestamp, address: market.manager, protocol: 'uniswap_v4', id: `uniswap_v4:${market.manager}:${market.poolId}`,
    identity: { manager: market.manager, poolId: market.poolId, poolKey: market.poolKey,
      creation: { blockNumber: creationNumber, blockHash: creationHash, transactionHash: creationTx, initializeLogIndex: market.initial.logIndex },
      stockConversion: { kind: conversion.kind, venue: conversion.venue, quoteToken: conversion.quoteToken, nativeToken: conversion.nativeToken,
        sourceBlock: conversion.source.number, sourceHash: conversion.source.hash, observedAt: conversion.source.timestamp,
        venueRuntimeHash:conversion.venueRuntimeHash,calldataHash:conversion.calldataHash,quoteDecimals:conversion.quoteDecimals } },
    state: { sqrtPriceX96: current.sqrtPriceX96, liquidity: current.liquidityRaw, nativeRaw: conversion.nativeRaw, quoteRaw: conversion.quoteRaw,
      rawQuoteNumerator: current.rawQuoteRatio.numerator, rawQuoteDenominator: current.rawQuoteRatio.denominator } };
}
async function registeredV4Price(token:FreshTokenMetadata,options:FreshPriceOptions,value:unknown):Promise<QuoteCandidate|null>{
  if(!validFreshStockwaveMarketIdentity(value)||value.tokenAddress!==token.address||!options.canonicalHash
    ||value.initial.blockNumber>options.block.number||await options.canonicalHash(value.initial.blockNumber)!==value.initial.blockHash)return null;
  const market=await readFreshStockwaveMarket({rpc:options.rpc,identity:value,tokenDecimals:token.decimals,block:options.block});
  const raw=market.rawQuoteRatio,virtual=market.virtualQuoteLiquidityRaw,quote=value.quoteAddress;
  let priceRatio:MarketDecimal,liquidity:MarketDecimal,converted:Awaited<ReturnType<typeof currentQuoteConversion>>|null=null;
  let decimals:number;
  if(TRUSTED_QUOTE_FEEDS[quote]){
    decimals=Number((await freshCall(options,quote,tokenAbi,'decimals'))[0]);if(!Number.isInteger(decimals)||decimals<0||decimals>36)return null;
    priceRatio=new MarketDecimal(BigInt(raw.numerator)*10n**BigInt(token.decimals),BigInt(raw.denominator)*10n**BigInt(decimals));
    liquidity=new MarketDecimal(BigInt(virtual.numerator),BigInt(virtual.denominator)*10n**BigInt(decimals));
  }else{
    converted=await currentQuoteConversion(quote,options);decimals=converted.settlementDecimals;
    priceRatio=new MarketDecimal(BigInt(raw.numerator)*converted.settlementRaw*10n**BigInt(token.decimals),BigInt(raw.denominator)*converted.quoteRaw*10n**BigInt(decimals));
    liquidity=new MarketDecimal(BigInt(virtual.numerator)*converted.settlementRaw,BigInt(virtual.denominator)*converted.quoteRaw*10n**BigInt(decimals));
  }
  if(priceRatio.n<=0n||liquidity.n<=0n)return null;
  return{quote:converted?converted.settlementToken:quote,marketQuote:quote,decimals,priceQuote:priceRatio.text(),priceRatio,liquidity,
    address:value.manager,protocol:'uniswap_v4',id:`uniswap_v4:${value.manager}:${value.poolId}`,observedAt:options.block.timestamp,
    identity:{manager:value.manager,poolId:value.poolId,poolKey:value.poolKey,market:value,
      ...(converted?{quoteConversion:converted.identity}:{})},
    state:{sqrtPriceX96:market.sqrtPriceX96,liquidity:market.liquidityRaw,rawQuoteNumerator:raw.numerator,rawQuoteDenominator:raw.denominator,
      ...(converted?converted.state:{})}};
}
async function registeredInfinityClPrice(token:FreshTokenMetadata,options:FreshPriceOptions,value:unknown):Promise<QuoteCandidate|null>{
 if(!validFreshInfinityClMarketIdentity(value)||value.tokenAddress!==token.address||!options.canonicalHash
  ||value.initial.blockNumber>options.block.number||await options.canonicalHash(value.initial.blockNumber)!==value.initial.blockHash)return null;
 const market=await readFreshInfinityClMarket({rpc:options.rpc,identity:value,tokenDecimals:token.decimals,block:options.block}),raw=market.rawQuoteRatio,virtual=market.virtualQuoteLiquidityRaw;
 const decimals=Number((await freshCall(options,WBNB,tokenAbi,'decimals'))[0]);if(decimals!==18)return null;
 const priceRatio=new MarketDecimal(BigInt(raw.numerator)*10n**BigInt(token.decimals),BigInt(raw.denominator)*10n**18n),liquidity=new MarketDecimal(BigInt(virtual.numerator),BigInt(virtual.denominator)*10n**18n);
 if(priceRatio.n<=0n||liquidity.n<=0n)return null;
 return{quote:WBNB,marketQuote:WBNB,decimals:18,priceQuote:priceRatio.text(),priceRatio,liquidity,address:value.manager,protocol:'infinity_cl',id:`infinity_cl:${value.manager}:${value.poolId}`,observedAt:options.block.timestamp,
  identity:{manager:value.manager,poolId:value.poolId,poolKey:value.poolKey,market:value},state:{sqrtPriceX96:market.sqrtPriceX96,liquidity:market.liquidityRaw,rawQuoteNumerator:raw.numerator,rawQuoteDenominator:raw.denominator}};
}
async function discoverPool(token: FreshTokenMetadata, quote: string, options: FreshPriceOptions): Promise<{candidates:QuoteCandidate[];complete:boolean}> {
  const quoteDecimals = Number((await freshCall(options, quote, tokenAbi, 'decimals'))[0]);
  if (!Number.isInteger(quoteDecimals) || quoteDecimals < 0 || quoteDecimals > 36) throw new Error('quote_precision_invalid');
  const requests: { address: string; protocol: 'pcs_v2' | 'pcs_v3'; fee: number | null }[] = [];
  const v2 = await freshCall(options, PCS_V2_FACTORY, poolMarketAbi, 'getPair', [token.address, quote]);
  if (freshAddress(v2[0]) && String(v2[0]).toLowerCase() !== ZeroAddress) requests.push({ address: String(v2[0]).toLowerCase(), protocol: 'pcs_v2', fee: null });
  const v3 = await Promise.allSettled([100, 500, 2_500, 10_000].map(async fee => ({ address: String((await freshCall(options, PCS_V3_FACTORY, poolMarketAbi, 'getPool', [token.address, quote, fee]))[0]).toLowerCase(), fee })));
  for (const result of v3) if (result.status === 'fulfilled' && freshAddress(result.value.address) && result.value.address !== ZeroAddress) requests.push({ ...result.value, protocol: 'pcs_v3' });
  const candidates = await Promise.allSettled(requests.map(async request => {
    const [factory, t0, t1] = await Promise.all(['factory', 'token0', 'token1'].map(method => freshCall(options, request.address, poolMarketAbi, method)));
    const expectedFactory = request.protocol === 'pcs_v2' ? PCS_V2_FACTORY : PCS_V3_FACTORY;
    const token0 = String(t0[0]).toLowerCase(), token1 = String(t1[0]).toLowerCase();
    if (String(factory[0]).toLowerCase() !== expectedFactory || ![token0, token1].includes(token.address) || ![token0, token1].includes(quote) || token0 === token1) throw new Error('pool_identity_mismatch');
    const tokenIs0 = token0 === token.address;
    let priceQuote: string | null, liquidity: MarketDecimal, state: Record<string, string>;
    if (request.protocol === 'pcs_v2') {
      const reserves = await freshCall(options, request.address, poolMarketAbi, 'getReserves');
      const tokenRaw = BigInt(reserves[tokenIs0 ? 0 : 1]), quoteRaw = BigInt(reserves[tokenIs0 ? 1 : 0]);
      if(tokenRaw===0n||quoteRaw===0n)return null;
      priceQuote = ratioPrice(quoteRaw, tokenRaw, quoteDecimals, token.decimals); liquidity = MarketDecimal.raw(quoteRaw, quoteDecimals);
      state = { reserve0: String(reserves[0]), reserve1: String(reserves[1]) };
    } else {
      const [slot, fee, rawLiquidity] = await Promise.all([freshCall(options, request.address, poolMarketAbi, 'slot0'), freshCall(options, request.address, poolMarketAbi, 'fee'), freshCall(options, request.address, poolMarketAbi, 'liquidity')]);
      if (Number(fee[0]) !== request.fee) throw new Error('pool_fee_mismatch');
      if(BigInt(rawLiquidity[0])===0n)return null;
      priceQuote = sqrtPrice(BigInt(slot[0]), tokenIs0, tokenIs0 ? token.decimals : quoteDecimals, tokenIs0 ? quoteDecimals : token.decimals);
      // Active V3 quote-side virtual reserve, only used for choosing amongst
      // authenticated live pools. This is not recorded as trading volume.
      const sqrt = BigInt(slot[0]), l = BigInt(rawLiquidity[0]), quoteRaw = tokenIs0 ? l * sqrt / (1n << 96n) : l * (1n << 96n) / sqrt;
      liquidity = MarketDecimal.raw(quoteRaw, quoteDecimals); state = { sqrtPriceX96: sqrt.toString(), liquidity: l.toString() };
    }
    if (!priceQuote || liquidity.n <= 0n) throw new Error('pool_price_unavailable');
    return { quote, decimals: quoteDecimals, priceQuote, address: request.address, id: `${request.protocol}:${request.address}`, protocol: request.protocol,
      identity: { factory: expectedFactory, token0, token1, fee: request.fee }, state, liquidity } satisfies QuoteCandidate;
  }));
  return {candidates:candidates.flatMap(candidate=>candidate.status==='fulfilled'&&candidate.value?[candidate.value]:[]),
    complete:v3.every(value=>value.status==='fulfilled')&&candidates.every(value=>value.status==='fulfilled')};
}

interface LaunchObservation {proof:Record<string,unknown>|null;emptyQuote?:string;marketQuote?:string}
async function launchPrice(token: FreshTokenMetadata, options: FreshPriceOptions, observed: LaunchObservation): Promise<QuoteCandidate | null> {
  if (token.decimals !== 18) return null;
  try {
    const info = await freshCall(options, FOUR_HELPER, fourInterface, 'getTokenInfo', [token.address]);
    if ([1n, 2n].includes(BigInt(info.version)) && FOUR_MANAGERS.includes(String(info.tokenManager).toLowerCase())) {
      observed.proof = { platform: 'fourmeme', stage: info.liquidityAdded ? 'graduated' : 'bonding', helper: FOUR_HELPER, controller: String(info.tokenManager).toLowerCase(), blockNumber: options.block.number, blockHash: options.block.hash };
      const quote = String(info.quote).toLowerCase() === ZeroAddress ? WBNB : String(info.quote).toLowerCase();
      if(freshAddress(quote))observed.marketQuote=quote;
      if (info.liquidityAdded || BigInt(info.lastPrice) <= 0n) return null;
      if(!TRUSTED_QUOTE_FEEDS[quote]){
        const conversion=await currentQuoteConversion(quote,options);
        const priceRatio=new MarketDecimal(BigInt(info.lastPrice)*conversion.settlementRaw,conversion.quoteRaw*10n**BigInt(conversion.settlementDecimals));
        const liquidity=new MarketDecimal(BigInt(info.funds)*conversion.settlementRaw,conversion.quoteRaw*10n**BigInt(conversion.settlementDecimals));
        if(priceRatio.n<=0n||liquidity.n<=0n)return null;
        return{quote:conversion.settlementToken,marketQuote:quote,decimals:conversion.settlementDecimals,priceQuote:priceRatio.text(),priceRatio,liquidity,address:String(info.tokenManager).toLowerCase(),id:`fourmeme:${token.address}`,protocol:'fourmeme',
          observedAt:conversion.observedAt,identity:{helper:FOUR_HELPER,manager:String(info.tokenManager).toLowerCase(),version:String(info.version),quoteConversion:conversion.identity},
          state:{lastPrice:String(info.lastPrice),funds:String(info.funds),...conversion.state}};
      }
      const decimals = Number((await freshCall(options, quote, tokenAbi, 'decimals'))[0]);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
      return { quote, decimals, priceQuote: MarketDecimal.raw(BigInt(info.lastPrice), decimals).text(), address: String(info.tokenManager).toLowerCase(), id: `fourmeme:${token.address}`, protocol: 'fourmeme',
        identity: { helper: FOUR_HELPER, manager: String(info.tokenManager).toLowerCase(), version: String(info.version) }, state: { lastPrice: String(info.lastPrice), funds: String(info.funds) }, liquidity: MarketDecimal.raw(BigInt(info.funds), decimals) };
    }
  } catch { /* Not a verified FourMeme token. */ }
  for (const method of ['getTokenV8Safe', 'getTokenV7'] as const) {
    try {
      const state = (await freshCall(options, FLAP_PORTAL, flapInterface, method, [token.address]))[0];
      if ([1n, 4n].includes(BigInt(state.status))) observed.proof = { platform: 'flap', stage: BigInt(state.status) === 4n ? 'graduated' : 'bonding', controller: FLAP_PORTAL, method, blockNumber: options.block.number, blockHash: options.block.hash };
      // Graduation empties the curve, but its authenticated quote still names
      // the migrated market. Retain only a valid, supported quote for bounded
      // factory discovery; unknown portal states/quote routes grant no trust.
      const quote = String(state.quoteTokenAddress).toLowerCase() === ZeroAddress ? WBNB : String(state.quoteTokenAddress).toLowerCase();
      if ([1n,4n].includes(BigInt(state.status)) && freshAddress(quote)) observed.marketQuote=quote;
      if (BigInt(state.status) === 4n) return null;
      if (BigInt(state.status) !== 1n) continue;
      // A displayed curve price with no reserve is not an executable quote.
      // Still check alternate authenticated markets before declaring emptiness.
      if(BigInt(state.reserve)===0n){observed.emptyQuote=quote;return null;}
      if(BigInt(state.price)<=0n)continue;
      if (!TRUSTED_QUOTE_FEEDS[quote]) {
        const conversion = await currentQuoteConversion(quote,options);
        // Portal price is normalized quote/token in Wad. The reserve ratio
        // retains its genuine settlement asset until that asset's dated feed.
        const priceRatio = new MarketDecimal(BigInt(state.price) * 10n ** BigInt(conversion.quoteDecimals) * conversion.settlementRaw,
          10n ** BigInt(18+conversion.settlementDecimals) * conversion.quoteRaw);
        const liquidity = new MarketDecimal(BigInt(state.reserve) * conversion.settlementRaw, conversion.quoteRaw * 10n ** BigInt(conversion.settlementDecimals));
        if (priceRatio.n <= 0n || liquidity.n <= 0n) continue;
        return {quote:conversion.settlementToken,marketQuote:quote,decimals:conversion.settlementDecimals,priceQuote:priceRatio.text(),priceRatio,liquidity,
          address:FLAP_PORTAL,id:`flap:${token.address}`,protocol:'flap',observedAt:conversion.observedAt,
          identity:{portal:FLAP_PORTAL,method,quoteConversion:conversion.identity},
          state:{price:String(state.price),reserve:String(state.reserve),...conversion.state}};
      }
      if (!TRUSTED_QUOTE_FEEDS[quote]) return null;
      const decimals = Number((await freshCall(options, quote, tokenAbi, 'decimals'))[0]);
      return { quote, decimals, priceQuote: MarketDecimal.raw(BigInt(state.price), 18).text(), address: FLAP_PORTAL, id: `flap:${token.address}`, protocol: 'flap',
        identity: { portal: FLAP_PORTAL, method }, state: { price: String(state.price), reserve: String(state.reserve) }, liquidity: MarketDecimal.raw(BigInt(state.reserve), decimals) };
    } catch { /* Unsupported portal version remains explicit. */ }
  }
  return null;
}

export async function freshCurrentQuote(tokenAddress: string, options: FreshPriceOptions): Promise<FreshQuote> {
  const historical=freshHistoricalValuation(options);
  const token = await freshTokenMetadata(tokenAddress, { ...options, requireSupply: true });
  if(token.supplyRaw===null)throw new Error('token_supply_unavailable');
  const launch:LaunchObservation = { proof: null }, [controller, stockwave,registeredV4] = await Promise.all([
    launchPrice(token, options, launch), stockwavePrice(token, options).catch(() => null),
    Promise.allSettled((options.marketIdentities??[]).slice(0,8).map(identity=>validFreshInfinityClMarketIdentity(identity)?registeredInfinityClPrice(token,options,identity):registeredV4Price(token,options,identity))),
  ]);
  let routed:QuoteCandidate|null=null;
  if(!controller&&!launch.emptyQuote&&launch.proof?.platform==='flap'&&launch.proof.stage==='bonding'){
    try{
      const route=await readFreshFlapRawQuote({rpc:options.rpc,token,block:options.block}),raw=route.rawNativeRatio;
      const priceRatio=new MarketDecimal(BigInt(raw.numerator)*10n**BigInt(token.decimals),BigInt(raw.denominator)*10n**18n);
      const quotePerTokenRaw=new MarketDecimal(BigInt(route.state.priceScaled18),10n**18n*BigInt(route.reserveModelScale.factor));
      const liquidity=new MarketDecimal(BigInt(raw.numerator),BigInt(raw.denominator)).div(quotePerTokenRaw)
        .mul(MarketDecimal.raw(BigInt(route.state.reserveRaw),18));
      routed={quote:WBNB,marketQuote:route.identity.quoteAddress,decimals:18,priceQuote:priceRatio.text(),priceRatio,
        liquidity,id:`flap:${token.address}`,address:FLAP_PORTAL,protocol:'flap',identity:route.identity,state:route.state,observedAt:options.block.timestamp};
    }catch{/* Unknown quote routes stay unavailable; there is no peg or metadata fallback. */}
  }
  const launchCandidate=controller??routed;
  // An authenticated empty bonding curve does not need an exchange rate:
  // there is no reserve to value. Still inspect its exact quote's supported
  // factories and all ordinary feed markets. A missing conversion for a new
  // quote asset must not turn proven empty markets into an endless retry.
  // Incomplete discovery, a positive alternative or registered V4 identity
  // continues to prevent the terminal empty-market classification below.
  const emptyCurve=!!launch.emptyQuote;
  const discoveryQuotes=[...new Set([...Object.keys(TRUSTED_QUOTE_FEEDS),...(launch.marketQuote?[launch.marketQuote]:[]),...(emptyCurve?[launch.emptyQuote!]:[])])].filter(quote=>quote!==token.address);
  const discovered=launchCandidate?[]:await Promise.allSettled(discoveryQuotes.map(quote=>discoverPool(token,quote,options)));
  const candidates = [...(launchCandidate ? [launchCandidate] : discovered.flatMap(value=>value.status==='fulfilled'?value.value.candidates:[])),...(stockwave?[stockwave]:[]),
    ...registeredV4.flatMap(value=>value.status==='fulfilled'&&value.value?[value.value]:[])];
  const valued = await Promise.allSettled(candidates.map(async candidate => {
    let usd:MarketDecimal,valuedCandidate=candidate;
    if(!TRUSTED_QUOTE_FEEDS[candidate.quote]){
      const conversion=await currentQuoteConversion(candidate.quote,options);
      const settlementPerQuote=new MarketDecimal(conversion.settlementRaw*10n**BigInt(conversion.quoteDecimals),conversion.quoteRaw*10n**BigInt(conversion.settlementDecimals));
      usd=settlementPerQuote.mul(MarketDecimal.parse(await freshQuoteUsd(conversion.settlementToken,options)));
      // Preserve compact current conversion evidence alongside the traded pool.
      // It documents this observation only, never an earlier historical value.
      valuedCandidate={...candidate,identity:{...candidate.identity,quoteConversion:{...conversion.identity,
        observedBlock:options.block.number,observedHash:options.block.hash,observedAt:conversion.observedAt}},
        state:{...candidate.state,...conversion.state}};
    }else usd = MarketDecimal.parse(await freshQuoteUsd(candidate.quote, options));
    return { candidate:valuedCandidate, price: (candidate.priceRatio ?? MarketDecimal.parse(candidate.priceQuote)).mul(usd), liquidity: candidate.liquidity.mul(usd) };
  }));
  const choices = valued.flatMap(value => value.status === 'fulfilled' ? [value.value] : []).sort((a, b) => b.liquidity.compare(a.liquidity));
  if (!choices.length) {
    if(emptyCurve&&!candidates.length&&!(options.marketIdentities?.length)&&discovered.length===discoveryQuotes.length
      &&discovered.every(value=>value.status==='fulfilled'&&value.value.complete))throw new FreshNoLiquidityError();
    throw new Error('authenticated_market_quote_unavailable');
  }
  const { candidate, price } = choices[0];
  if (price.n <= 0n) throw new Error('current_price_invalid');
  return { tokenAddress: token.address, priceUsd: price.text(), marketCapUsd: MarketDecimal.raw(BigInt(token.supplyRaw), token.decimals).mul(price).text(), metadata: token,
    market: { id: candidate.id, address: candidate.address, protocol: candidate.protocol, quoteAddress: candidate.marketQuote ?? candidate.quote, identity: { ...candidate.identity, ...(launch.proof ? { launch: launch.proof } : {}) }, state: candidate.state },
    observedAt: candidate.observedAt ?? options.block.timestamp, blockNumber: options.block.number, blockHash: options.block.hash,...(historical?{observationContext:'historical_block' as const}:{}) };
}

export async function persistFreshQuote(database: Pick<Pool, 'query'>, quote: FreshQuote) {
  if(quote.observationContext==='historical_block')throw Error('historical_valuation_not_current');
  await database.query(`UPDATE fresh.tokens SET name=COALESCE($2,name),symbol=COALESCE($3,symbol),decimals=$4,total_supply_raw=$5,
    price_usd=$6,market_cap_usd=$7,observed_block=$8,observed_hash=$9,observed_at=$10,metadata_updated_at=clock_timestamp(),valuation_status='ready',price_source='node' WHERE address=$1
    AND (observed_block IS NULL OR observed_block<=$8)`, [quote.tokenAddress, quote.metadata.name, quote.metadata.symbol, quote.metadata.decimals, quote.metadata.supplyRaw,
    quote.priceUsd, quote.marketCapUsd, quote.blockNumber, quote.blockHash, quote.observedAt]);
  await database.query(`INSERT INTO fresh.markets(id,token_address,address,protocol,quote_address,identity,state,observed_block,observed_hash,observed_at,status)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,'ready') ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state,identity=EXCLUDED.identity,
    observed_block=EXCLUDED.observed_block,observed_hash=EXCLUDED.observed_hash,observed_at=EXCLUDED.observed_at,status='ready'
    WHERE fresh.markets.observed_block IS NULL OR fresh.markets.observed_block<=EXCLUDED.observed_block`, [quote.market.id, quote.tokenAddress, ['uniswap_v4','infinity_cl'].includes(quote.market.protocol)?null:quote.market.address, quote.market.protocol,
    quote.market.quoteAddress, JSON.stringify(quote.market.identity), JSON.stringify(quote.market.state), quote.blockNumber, quote.blockHash, quote.observedAt]);
}

/** A completed RPC observation is committed only in its original capture
 * generation. The capture/reorg lock closes the read-before-rollback race;
 * no RPC or historical scan runs while database locks are held. The query-only
 * writer stays separate for rolled-back fixtures and caller-owned transactions. */
export async function commitFreshCurrentQuote(database:Pool,quote:FreshQuote,options:{captureRevision:string|number}){
 if(quote.observationContext==='historical_block')throw Error('historical_valuation_not_current');
 const client=await database.connect();try{
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(73621941)');
  const capture=(await client.query(`SELECT c.block_number,c.block_hash,c.revision,c.value,b.occurred_at,h.value->>'ok' AS capture_ok,h.updated_at AS health_at
   FROM fresh.checkpoints c JOIN fresh.checkpoints h ON h.key='health:capture'
   JOIN fresh.recent_blocks b ON b.block_number=c.block_number AND b.block_hash=c.block_hash WHERE c.key='capture' FOR SHARE OF c,h,b`)).rows[0];
  const now=Date.now(),capTime=Date.parse(capture?.occurred_at),healthTime=Date.parse(capture?.health_at),quoteTime=Date.parse(quote.observedAt);
  if(!capture||capture.capture_ok!=='true'||!/^\d+$/.test(String(options.captureRevision))||String(capture.revision)!==String(options.captureRevision)
   ||!Number.isFinite(capTime)||now-capTime>20_000||capTime>now+5_000||!Number.isFinite(healthTime)||now-healthTime>90_000||healthTime>now+5_000)
   throw Error('current_quote_capture_changed');
  if(!freshAddress(quote.tokenAddress)||!Number.isSafeInteger(quote.blockNumber)||quote.blockNumber<0||!freshHash(quote.blockHash)
   ||!Number.isFinite(quoteTime)||now-quoteTime>120_000||quoteTime>now+5_000||quote.blockNumber>Number(capture.block_number)
   ||quote.metadata.address!==quote.tokenAddress||quote.metadata.block.number!==quote.blockNumber||quote.metadata.block.hash!==quote.blockHash
   ||Date.parse(quote.metadata.block.timestamp)!==quoteTime)throw Error('current_quote_observation_invalid');
  const canonical=(await client.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1 FOR SHARE',[quote.blockNumber])).rows[0]?.block_hash;
  if(canonical!==quote.blockHash)throw Error('current_quote_noncanonical');
  const token=(await client.query('SELECT launch_status FROM fresh.tokens WHERE address=$1 FOR SHARE',[quote.tokenAddress])).rows[0];
  const admission=await readFreshTokenAdmission(client,quote.tokenAddress,{blockNumber:quote.blockNumber,lock:true});
  if(!token||!admission||token.launch_status!==admission.launchStatus)throw Error('current_quote_token_changed');
  if(admission.kind==='new_launch'){
   const launch=admission.fact;
   const creationHash=(await client.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1 FOR SHARE',[launch.block_number])).rows[0]?.block_hash;
   if(creationHash&&creationHash!==launch.block_hash)throw Error('current_quote_token_noncanonical');
  }
  if(quote.market.protocol==='uniswap_v4'){
   // An explicit existing-token permission is not a launch/Initialize proof.
   if(admission.kind!=='new_launch')throw Error('current_quote_market_admission_unsupported');
   const stored=(await client.query('SELECT token_address,protocol,identity FROM fresh.markets WHERE id=$1 FOR SHARE',[quote.market.id])).rows[0];
   const proposed=quote.market.identity,fromQuote=proposed.market;
   if(freshMarketIdentityInvalid(proposed)||freshMarketIdentityInvalid(stored?.identity))throw Error('current_quote_market_invalidated');
   let identity:unknown=fromQuote;
   if(fromQuote){
    const previous=stored?.identity?.market??stored?.identity;
    if(!stored||stored.token_address!==quote.tokenAddress||stored.protocol!=='uniswap_v4'||!validFreshStockwaveMarketIdentity(previous)
     ||!validFreshStockwaveMarketIdentity(fromQuote)||freshMarketLaunchDigest(previous)!==freshMarketLaunchDigest(fromQuote))throw Error('current_quote_market_changed');
   }else{
    const fact=(await client.query("SELECT to_jsonb(lf) AS fact FROM fresh.launch_facts lf WHERE token_address=$1 AND status='eligible' FOR SHARE",[quote.tokenAddress])).rows[0]?.fact;
    identity=fact?.proof?.market;const creation=proposed.creation as Record<string,unknown>|undefined;
    if(fact?.protocol!=='stockwave'||!creation||!validFreshStockwaveMarketIdentity(identity)||!freshStockwaveMetadataFromFact(fact,quote.metadata.block)
     ||Number(creation.blockNumber)!==identity.initial.blockNumber||creation.blockHash!==identity.initial.blockHash||creation.transactionHash!==identity.initial.transactionHash
     ||creation.initializeLogIndex!==identity.initial.logIndex)throw Error('current_quote_market_changed');
   }
   if(!validFreshStockwaveMarketIdentity(identity)||identity.tokenAddress!==quote.tokenAddress||identity.manager!==proposed.manager||identity.poolId!==proposed.poolId
    ||freshMarketLaunchDigest(identity.poolKey)!==freshMarketLaunchDigest(proposed.poolKey)||identity.initial.blockNumber>quote.blockNumber)throw Error('current_quote_market_changed');
   const canonical=createFreshCurrentMarketCanonicalHash(client,{token:quote.tokenAddress,block:quote.metadata.block});
   if(await canonical(identity.initial.blockNumber)!==identity.initial.blockHash)throw Error('current_quote_market_noncanonical');
  }
  if(quote.market.protocol==='infinity_cl'){
   if(admission.kind!=='new_launch')throw Error('current_quote_market_admission_unsupported');
   const stored=(await client.query('SELECT token_address,protocol,identity FROM fresh.markets WHERE id=$1 FOR SHARE',[quote.market.id])).rows[0],proposed=quote.market.identity,identity=proposed.market,previous=stored?.identity?.market??stored?.identity;
   if(freshMarketIdentityInvalid(proposed)||freshMarketIdentityInvalid(stored?.identity)||!stored||stored.token_address!==quote.tokenAddress||stored.protocol!=='infinity_cl'
    ||!validFreshInfinityClMarketIdentity(previous)||!validFreshInfinityClMarketIdentity(identity)||freshMarketLaunchDigest(previous)!==freshMarketLaunchDigest(identity)
    ||identity.tokenAddress!==quote.tokenAddress||identity.manager!==proposed.manager||identity.poolId!==proposed.poolId||freshMarketLaunchDigest(identity.poolKey)!==freshMarketLaunchDigest(proposed.poolKey)
    ||identity.initial.blockNumber>quote.blockNumber)throw Error('current_quote_market_changed');
   const canonical=createFreshCurrentMarketCanonicalHash(client,{token:quote.tokenAddress,block:quote.metadata.block});
   if(await canonical(identity.initial.blockNumber)!==identity.initial.blockHash)throw Error('current_quote_market_noncanonical');
  }
  await persistFreshQuote(client,quote);await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
