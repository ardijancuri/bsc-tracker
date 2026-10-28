import{TRUSTED_QUOTE_FEEDS}from'../nodeMarketProtocols.js';
import{WBNB}from'../launchpad.js';
import{FRESH_BTCB_QUOTE}from'./currentBtcQuote.js';
import{FRESH_BNCB_QUOTE}from'./currentBncbQuote.js';
import{FRESH_SPCXB_QUOTE}from'./currentSpcxbQuote.js';
import{isStockToken}from'../stockToken.js';
/** These exact assets may settle trades; they are not dollar feeds or pegs.
 * Financial value still requires independent canonical historical conversion. */
export const FRESH_NATIVE_SETTLEMENT_SYMBOLS:Readonly<Record<string,string>>=Object.freeze({
 [FRESH_BTCB_QUOTE]:'BTCB',[FRESH_BNCB_QUOTE]:'BNCB',[FRESH_SPCXB_QUOTE]:'SPCXB'});
export const FRESH_WRAPPED_STOCK_SETTLEMENT_SYMBOLS:Readonly<Record<string,string>>=Object.freeze({'0x41333df9e7639188bbfca5522dc4844398af9f9e':'wTCENTx','0x076cf393e701839fc7a5832d2c68aafa235682ae':'wXIAOx'});
export const isFreshSettlementQuote=(address:string)=>typeof address==='string'&&/^[0-9a-f]{40}$/.test(address.slice(2))&&address.startsWith('0x')&&(Object.hasOwn(TRUSTED_QUOTE_FEEDS,address)||Object.hasOwn(FRESH_NATIVE_SETTLEMENT_SYMBOLS,address)||Object.hasOwn(FRESH_WRAPPED_STOCK_SETTLEMENT_SYMBOLS,address)||isStockToken(address));
export const freshSettlementQuoteSymbol=(address:string)=>address===WBNB?'WBNB':Object.hasOwn(TRUSTED_QUOTE_FEEDS,address)?TRUSTED_QUOTE_FEEDS[address].description.split(' / ')[0]:Object.hasOwn(FRESH_NATIVE_SETTLEMENT_SYMBOLS,address)?FRESH_NATIVE_SETTLEMENT_SYMBOLS[address]:Object.hasOwn(FRESH_WRAPPED_STOCK_SETTLEMENT_SYMBOLS,address)?FRESH_WRAPPED_STOCK_SETTLEMENT_SYMBOLS[address]:(isStockToken(address)?'ERC20':null);
