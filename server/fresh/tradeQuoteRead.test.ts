import{describe,it,expect}from'vitest';
import{tradeIdentity}from'./reads.js';
const native='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
describe('recorded trade quote API identity',()=>{
 it('exposes authentic quote contract and exact units independently of USD',()=>{
  expect(tradeIdentity({kind:'buy',quantity:'1000000',amount_usd:null,quote_address:native,quote_symbol:'BNB',quote_amount:'0.000000000000000001',
   occurred_at:'2026-10-24T00:00:00Z',block_number:'123'})).toMatchObject({quoteTokenAddress:native,quoteSymbol:'BNB',quoteAmount:'0.000000000000000001',amountUsd:null,valuationStatus:'unpriced'});
 });
 it('keeps missing proof unavailable rather than creating a BNB value from USD',()=>{
  expect(tradeIdentity({kind:'sell',quantity:'10',amount_usd:'100',occurred_at:'2026-10-24T00:00:00Z',block_number:'123'})).toMatchObject({quoteTokenAddress:null,quoteSymbol:null,quoteAmount:null,amountUsd:'100'});
 });
});
