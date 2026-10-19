import{describe,it,expect}from'vitest';
import{selectNodeQuoteConversion,type NodeQuoteConversionRoute}from'./nodeMarketConversion.js';
const route=(pool:string,priceUsd:string,depthUsd:string):NodeQuoteConversionRoute=>({pool,priceUsd,depthUsd,protocol:'pcs_v2',base:'verified-feed-asset',evidence:{}});
describe('authenticated same-block quote route selection',()=>{
  it('chooses greatest genuine depth deterministically',()=>{
    expect(selectNodeQuoteConversion([route('b','1','2000'),route('a','1.01','5000')])?.pool).toBe('a');
    expect(selectNodeQuoteConversion([route('b','1','5000'),route('a','1','5000')])?.pool).toBe('a');
  });
  it('rejects absent, zero and thin manipulated routes',()=>{
    expect(selectNodeQuoteConversion([])).toBeNull();
    expect(selectNodeQuoteConversion([route('a','0','5000'),route('b','1000000','1')])).toBeNull();
  });
  it('refuses conflicting deep routes instead of picking a convenient mark',()=>{
    expect(selectNodeQuoteConversion([route('a','1','5000'),route('b','2','100000')])).toBeNull();
  });
});
