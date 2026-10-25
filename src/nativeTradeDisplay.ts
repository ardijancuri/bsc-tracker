type TradeValueInput={quoteSymbol:string|null;quoteTokenAddress?:string|null;quoteAmount:string|null;amountUsd:string|null;bnbEquivalentAmount?:string|null};
export interface NativeTradeDisplay {
  kind:'quote'|'bnb_equivalent'|'usd'|'pending';text:string;amount:string|null;symbol:string|null;
  titleKey:'Recorded {symbol} trade amount: {amount}'|'Recorded USD trade value: ${amount}'|'Trade amount is pending verification'|'BNB equivalent at trade time: {amount} BNB · Settled: {quoteAmount} {quoteSymbol}';
}

const decimal=(value:string|null)=>{
  if(typeof value!=='string'||value.length>384||!/^\d+(?:\.\d+)?$/.test(value))return null;
  const number=Number(value);return Number.isFinite(number)&&number>=0?{raw:value,number,positive:/[1-9]/.test(value)}:null;
};
const nativeAddresses=new Set(['0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c','0x0000000000000000000000000000000000000000']);

/** Native settlements stay exact. Other quotes use the server's historical
 * BNB equivalent, never the overview's changing current BNB/USD price. */
export function nativeTradeDisplay(trade:TradeValueInput,locale='en-US'):NativeTradeDisplay {
  const quote=decimal(trade.quoteAmount),symbol=typeof trade.quoteSymbol==='string'?trade.quoteSymbol.trim():'',
    address=typeof trade.quoteTokenAddress==='string'?trade.quoteTokenAddress.toLowerCase():'',native=nativeAddresses.has(address),
    validAddress=/^0x[0-9a-f]{40}$/.test(address),validSymbol=!!symbol&&symbol.length<=24&&!/[\u0000-\u001f\u007f]/.test(symbol),
    reservedNativeSymbol=['BNB','WBNB'].includes(symbol.toUpperCase());
  const format=(amount:number)=>new Intl.NumberFormat(locale,{maximumFractionDigits:3}).format(amount);
  const formatQuote=(amount:{positive:boolean;number:number})=>{
    if(amount.positive&&amount.number<0.00000001)return`<${new Intl.NumberFormat(locale,{maximumFractionDigits:8}).format(0.00000001)}`;
    if(amount.positive&&amount.number<0.001)return new Intl.NumberFormat(locale,{maximumFractionDigits:Math.min(8,2-Math.floor(Math.log10(amount.number)))}).format(amount.number);
    return format(amount.number);
  };
  if(quote&&validAddress&&(native||validSymbol&&!reservedNativeSymbol)){
    const equivalent=decimal(trade.bnbEquivalentAmount??null);
    if(!native&&equivalent&&(!quote.positive||equivalent.positive))return{kind:'bnb_equivalent',text:`≈${formatQuote(equivalent)} BNB`,amount:equivalent.raw,symbol:'BNB',
      titleKey:'BNB equivalent at trade time: {amount} BNB · Settled: {quoteAmount} {quoteSymbol}'};
    const unit=native?'BNB':symbol;
    return{kind:'quote',text:`${formatQuote(quote)} ${unit}`,amount:quote.raw,symbol:unit,
      titleKey:'Recorded {symbol} trade amount: {amount}'};
  }
  const usd=decimal(trade.amountUsd);
  if(usd)return{kind:'usd',text:usd.positive&&usd.number<0.001?'<$0.001':`$${format(usd.number)}`,amount:usd.raw,symbol:'USD',titleKey:'Recorded USD trade value: ${amount}'};
  return{kind:'pending',text:'Amount pending',amount:null,symbol:null,titleKey:'Trade amount is pending verification'};
}
