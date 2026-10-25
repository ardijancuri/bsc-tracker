import{describe,it,expect}from'vitest';
import{freshTradeBnbEquivalent}from'./tradeBnbDisplay.js';
import{tradeIdentity}from'./reads.js';
const usdc='0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',bnb='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
describe('compact historical BNB display conversion',()=>{
 it('uses the recorded USD amount and dated BNB/USD rate with exact decimal division',()=>{
  expect(freshTradeBnbEquivalent({quote_address:usdc,amount_usd:'123.456789',bnb_price_usd:'800'})).toBe('0.15432098625');
  expect(freshTradeBnbEquivalent({quote_address:usdc,amount_usd:'0',bnb_price_usd:'700'})).toBe('0');
 });
 it('cannot replace actual BNB or use unavailable, zero, negative or malformed historical prices',()=>{
  expect(freshTradeBnbEquivalent({quote_address:bnb,amount_usd:'100',bnb_price_usd:'700'})).toBeNull();
  for(const rate of[undefined,null,'0','-1','NaN','Infinity','1/2'])expect(freshTradeBnbEquivalent({quote_address:usdc,amount_usd:'100',bnb_price_usd:rate})).toBeNull();
 });
 it('adds an equivalent to the API while preserving the full actual quote and P&L inputs',()=>{
  const row={id:'trade',transaction_hash:'0x'+'a'.repeat(64),quote_address:usdc,quote_symbol:'USDC',quote_amount:'226.133956113682511421',amount_usd:'226.09722517519096597066988697',bnb_price_usd:'737.87155465',quantity:'366580.452200526280416765',occurred_at:'2026-10-24T00:17:30Z',block_number:'129416436'};
  const value=tradeIdentity(row);expect(value.bnbEquivalentAmount).toBe(freshTradeBnbEquivalent(row));expect(value.quoteAmount).toBe(row.quote_amount);expect(value.quoteTokenAddress).toBe(usdc);expect(value.quoteSymbol).toBe('USDC');expect(value.amountUsd).toBe(row.amount_usd);
 });
});
