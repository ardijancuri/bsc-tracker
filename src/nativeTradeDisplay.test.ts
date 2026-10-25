import{describe,it,expect}from'vitest';
import{nativeTradeDisplay}from'./nativeTradeDisplay';
import{translate}from'./i18n';

const bnb='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',erc20='0x'+'1'.repeat(40);

describe('recorded trade settlement display',()=>{
 it('shows a dated BNB equivalent for USDC while retaining actual settlement in its tooltip contract',()=>{
  const value=nativeTradeDisplay({quoteTokenAddress:erc20,quoteSymbol:'USDC',quoteAmount:'226.133956113682511421',amountUsd:'226.09722517519096597066988697',bnbEquivalentAmount:'0.3063'});
  expect(value).toMatchObject({kind:'bnb_equivalent',text:'≈0.306 BNB',symbol:'BNB',amount:'0.3063',titleKey:'BNB equivalent at trade time: {amount} BNB · Settled: {quoteAmount} {quoteSymbol}'});
  expect(translate(value.titleKey,'zh-CN',{amount:value.amount!,quoteAmount:'226.133956113682511421',quoteSymbol:'USDC'})).toContain('226.133956113682511421 USDC');
 });
 it('keeps a recorded native payment authoritative over any optional equivalent and falls back for missing historical conversion',()=>{
  expect(nativeTradeDisplay({quoteTokenAddress:bnb,quoteSymbol:'BNB',quoteAmount:'0.1',amountUsd:'100',bnbEquivalentAmount:'1000'}).text).toBe('0.1 BNB');
  for(const value of[null,'NaN','0','-1'])expect(nativeTradeDisplay({quoteTokenAddress:erc20,quoteSymbol:'USDC',quoteAmount:'100',amountUsd:'100',bnbEquivalentAmount:value}).text).toBe('100 USDC');
  expect(nativeTradeDisplay({quoteTokenAddress:erc20,quoteSymbol:'USDC',quoteAmount:'0.0001',amountUsd:'0.0001',bnbEquivalentAmount:'0.00000012'},'de-DE').text).toBe('≈0,00000012 BNB');
 });
 it('shows recorded BNB directly even when the USD valuation is missing or disagrees',()=>{
  for(const amountUsd of[null,'999999'])expect(nativeTradeDisplay({quoteTokenAddress:bnb,quoteSymbol:'BNB',quoteAmount:'0.1435921',amountUsd})).toMatchObject({kind:'quote',text:'0.144 BNB',amount:'0.1435921',symbol:'BNB'});
 });
 it('normalizes only the recorded native unit and retains exact detail for the tooltip',()=>{
  expect(nativeTradeDisplay({quoteTokenAddress:bnb,quoteSymbol:' wbnb ',quoteAmount:'0.00000000123456789',amountUsd:'1'})).toEqual({kind:'quote',text:'<0.00000001 BNB',amount:'0.00000000123456789',symbol:'BNB',titleKey:'Recorded {symbol} trade amount: {amount}'});
 });
 it.each(['USDC','USDT','BNCB','BTCB'])('shows an actual %s quote as that asset instead of a current-price BNB estimate',symbol=>{
  expect(nativeTradeDisplay({quoteTokenAddress:erc20,quoteSymbol:symbol,quoteAmount:'152.901231',amountUsd:'200'})).toMatchObject({kind:'quote',text:`152.901 ${symbol}`,symbol});
 });
 it('uses an explicitly labeled recorded USD value when the settled quote is unavailable',()=>{
  expect(nativeTradeDisplay({quoteTokenAddress:bnb,quoteSymbol:'BNB',quoteAmount:null,amountUsd:'102.417'})).toMatchObject({kind:'usd',text:'$102.417',titleKey:'Recorded USD trade value: ${amount}'});
  expect(nativeTradeDisplay({quoteTokenAddress:erc20,quoteSymbol:null,quoteAmount:'102',amountUsd:'0.0001'})).toMatchObject({kind:'usd',text:'<$0.001'});
 });
 it('does not infer a native amount or a recorded-BNB tooltip from a symbol without an amount',()=>{
  const display=nativeTradeDisplay({quoteTokenAddress:bnb,quoteSymbol:'BNB',quoteAmount:null,amountUsd:null});expect(display).toMatchObject({kind:'pending',text:'Amount pending',symbol:null,titleKey:'Trade amount is pending verification'});expect(display.text).not.toContain('BNB');
 });
 it('requires an actual native asset address rather than trusting a BNB or WBNB token symbol',()=>{
  for(const quoteSymbol of['BNB','WBNB',' bnb '])for(const quoteTokenAddress of[null,erc20,'not-an-address']){
   expect(nativeTradeDisplay({quoteTokenAddress,quoteSymbol,quoteAmount:'1.5',amountUsd:'100'})).toMatchObject({kind:'usd',text:'$100'});
  }
  expect(nativeTradeDisplay({quoteTokenAddress:bnb.toUpperCase(),quoteSymbol:null,quoteAmount:'0.1',amountUsd:null}).text).toBe('0.1 BNB');
 });
 it('does not let malformed quote identity replace a valid recorded USD amount',()=>{
  for(const quoteSymbol of['','X'.repeat(25),'USDC\nmalicious'])expect(nativeTradeDisplay({quoteTokenAddress:erc20,quoteSymbol,quoteAmount:'1',amountUsd:'100'}).kind).toBe('usd');
 });
 it('keeps very small positive settlements visibly positive despite Number underflow',()=>{
  expect(nativeTradeDisplay({quoteTokenAddress:bnb,quoteSymbol:'BNB',quoteAmount:'0.'+'0'.repeat(350)+'1',amountUsd:null}).text).toBe('<0.00000001 BNB');
 });
 it.each([['0.000042104244974435','0.0000421 BNB'],['0.000057365540857207','0.0000574 BNB'],['0.00000001','0.00000001 BNB'],['0.0011234','0.001 BNB']])('keeps a small recorded BNB settlement %s visible at bounded precision', (quoteAmount,text)=>{
  const value=nativeTradeDisplay({quoteTokenAddress:bnb,quoteSymbol:'BNB',quoteAmount,amountUsd:null});expect(value.text).toBe(text);expect(value.amount).toBe(quoteAmount);
 });
 it('localizes small quote precision and its explicit lower display bound',()=>{
  expect(nativeTradeDisplay({quoteTokenAddress:bnb,quoteSymbol:'BNB',quoteAmount:'0.000042104244974435',amountUsd:null},'de-DE').text).toBe('0,0000421 BNB');
  expect(nativeTradeDisplay({quoteTokenAddress:bnb,quoteSymbol:'BNB',quoteAmount:'0.00000000001',amountUsd:null},'de-DE').text).toBe('<0,00000001 BNB');
 });
 it.each(['','-1','NaN','Infinity','1e999','0x12',' 1 '])('rejects malformed recorded amounts %j without presenting zero or estimated BNB',quoteAmount=>{
  expect(nativeTradeDisplay({quoteTokenAddress:bnb,quoteSymbol:'BNB',quoteAmount,amountUsd:null}).kind).toBe('pending');
 });
 it('preserves legitimate zero and localized numbers',()=>{
  expect(nativeTradeDisplay({quoteTokenAddress:bnb,quoteSymbol:'BNB',quoteAmount:'0',amountUsd:null}).text).toBe('0 BNB');
  expect(nativeTradeDisplay({quoteTokenAddress:erc20,quoteSymbol:'USDC',quoteAmount:'1234.56789',amountUsd:null},'de-DE').text).toBe('1.234,568 USDC');
 });
 it('translates the pending state and amount provenance without changing recorded units or decimal detail',()=>{
  const direct=nativeTradeDisplay({quoteTokenAddress:bnb,quoteSymbol:'BNB',quoteAmount:'0.1435921',amountUsd:null});
  expect(translate(direct.titleKey,'zh-CN',{symbol:direct.symbol!,amount:direct.amount!})).toBe('已记录的 BNB 交易金额：0.1435921');
  expect(translate('Amount pending','zh-CN')).toBe('金额待核实');
  expect(translate('Recorded USD trade value: ${amount}','zh-CN',{amount:'21.15'})).toBe('已记录的美元交易价值：$21.15');
 });
});
