import type {Rpc} from '../rpc.js';
import type {FreshPriceBlock} from './pricing.js';
import {FRESH_CURRENT_NATIVE_QUOTES,freshCurrentNativePair,readFreshCurrentNativeConversion} from './currentNativeQuote.js';
import type {FreshValuationReadOptions} from './valuationContext.js';
export const FRESH_SPCXB_QUOTE=FRESH_CURRENT_NATIVE_QUOTES.spcxb;
export const FRESH_SPCXB_NATIVE_PAIR=freshCurrentNativePair('spcxb');
/** Current authenticated SPCXB/WBNB conversion; never a stock/USD peg. */
export const readFreshSpcxbNativeConversion=(options:FreshValuationReadOptions)=>readFreshCurrentNativeConversion('spcxb',options);
