import {FRESH_CURRENT_NATIVE_QUOTES,freshCurrentNativePair,readFreshCurrentNativeConversion} from './currentNativeQuote.js';
import type {FreshValuationReadOptions} from './valuationContext.js';
export const FRESH_BNCB_QUOTE=FRESH_CURRENT_NATIVE_QUOTES.bncb;
export const FRESH_BNCB_NATIVE_PAIR=freshCurrentNativePair('bncb');
/** Preserve the bounded BNCB route and diagnostic contract. */
export const readFreshBncbNativeConversion=(options:FreshValuationReadOptions)=>readFreshCurrentNativeConversion('bncb',options);
