import{TRUSTED_QUOTE_FEEDS}from'../nodeMarketProtocols.js';
import{WBNB}from'../launchpad.js';
import{FRESH_BTCB_QUOTE}from'./currentBtcQuote.js';
import{FRESH_BNCB_QUOTE}from'./currentBncbQuote.js';
import{FRESH_SPCXB_QUOTE}from'./currentSpcxbQuote.js';
/** These exact assets may settle trades; they are not dollar feeds or pegs.
 * Financial value still requires independent canonical historical conversion. */
export const FRESH_NATIVE_SETTLEMENT_SYMBOLS:Readonly<Record<string,string>>=Object.freeze({
 [FRESH_BTCB_QUOTE]:'BTCB',[FRESH_BNCB_QUOTE]:'BNCB',[FRESH_SPCXB_QUOTE]:'SPCXB'});
export const isFreshSettlementQuote=(address:string)=>Object.hasOwn(TRUSTED_QUOTE_FEEDS,address)||Object.hasOwn(FRESH_NATIVE_SETTLEMENT_SYMBOLS,address);
export const freshSettlementQuoteSymbol=(address:string)=>address===WBNB?'WBNB':Object.hasOwn(TRUSTED_QUOTE_FEEDS,address)?TRUSTED_QUOTE_FEEDS[address].description.split(' / ')[0]:Object.hasOwn(FRESH_NATIVE_SETTLEMENT_SYMBOLS,address)?FRESH_NATIVE_SETTLEMENT_SYMBOLS[address]:null;
