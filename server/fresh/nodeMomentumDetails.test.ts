import {expect,it,vi} from 'vitest';
import type {MarketMomentumToken} from '../../shared/trendingTokens.js';
import {createNodeMomentumDetails} from './nodeMomentumDetails.js';

const address='0xa3cfb853339b77f385b994799b015cb04b208fe6';
const item:MarketMomentumToken={address,name:'Zypher Token',symbol:'POP',volumeUsd:'9200',marketCapUsd:null,priceChangePct:4,buyCount:12,sellCount:10};
const image='https://coin-images.coingecko.com/coins/images/69001/large/logo.png';

it('uses exact-contract image and market cap and distinguishes estimated zero taxes from missing data',async()=>{
  const fetcher=vi.fn<typeof fetch>(async url=>Response.json(String(url).includes('geckoterminal')?{
    data:[{id:'bsc_'+address,type:'token',attributes:{address,image_url:image,market_cap_usd:'94996.64',fdv_usd:'1000000'}}],
  }:{code:1,result:{[address]:{buy_tax:'0',sell_tax:''}}}));
  const details=createNodeMomentumDetails(fetcher);
  const [row]=await details.enrich([item]);
  expect(row).toEqual({...item,marketCapUsd:'94996.64',logoUrl:'/api/token-image/'+address+'?fallback=momentum',
    buyTaxBps:0,sellTaxBps:undefined,taxSource:'goplus'});
  expect(details.image(address)).toBe(image);
  const [exact]=await details.enrich([{...item,marketCapUsd:'95000',buyTaxBps:1,sellTaxBps:1}]);
  expect(exact).toMatchObject({marketCapUsd:'95000',buyTaxBps:1,sellTaxBps:1});
  expect(exact.taxSource).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('ignores foreign addresses, outside image domains, and FDV when market cap is missing',async()=>{
  const fetcher=vi.fn<typeof fetch>(async url=>Response.json(String(url).includes('geckoterminal')?{
    data:[{id:'bsc_'+address,type:'token',attributes:{address,image_url:'https://example.com/logo.png',fdv_usd:'1000000'}}],
  }:{code:1,result:{['0x'+'f'.repeat(40)]:{buy_tax:'0.08'}}}));
  const details=createNodeMomentumDetails(fetcher);
  expect(await details.enrich([item])).toEqual([{...item,logoUrl:null}]);
  expect(details.image(address)).toBeUndefined();
});
