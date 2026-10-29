import{describe,it,expect,vi}from'vitest';import sharp from'sharp';
import{freshPancakeArtworkFromJson,loadFreshArtwork}from'./artwork.js';
const token='0x8e6442663a4f8c50b6132c68d42a30e7dfe4ae15',other='0x'+'1'.repeat(40),pair='0x'+'2'.repeat(40),icon='https://cdn.dexscreener.com/cms/images/token-icon';
const endpoint='https://api.dexscreener.com/latest/dex/tokens/'+token;
const market=(patch:Record<string,unknown>={})=>({chainId:'bsc',dexId:'pancakeswap',pairAddress:pair,baseToken:{address:token},quoteToken:{address:other},info:{imageUrl:icon},...patch});
const body=(pairs:unknown[]=[])=>JSON.stringify({pairs});
const png=()=>sharp({create:{width:16,height:16,channels:4,background:'yellow'}}).png().toBuffer();
describe('exact BSC PancakeSwap artwork enrichment',()=>{
 it.each(['v2','v3','infinity'])('accepts the contract icon from provider PancakeSwap records with label %s',label=>{
  expect(freshPancakeArtworkFromJson(body([market({labels:[label],priceUsd:'untrusted',marketCap:999999})]),token)).toBe(icon);
 });
 it('coalesces identical artwork from multiple markets and ignores quote-token and unrelated records',()=>{
  expect(freshPancakeArtworkFromJson(body([market(),market({pairAddress:'0x'+'3'.repeat(40)}),market({baseToken:{address:other},quoteToken:{address:token},info:{imageUrl:'https://example.com/wrong.png'}})]),token)).toBe(icon);
  expect(freshPancakeArtworkFromJson(body([market({baseToken:{address:token.toUpperCase()}})]),token)).toBe(icon);
 });
 it.each([
  market({chainId:'ethereum'}),market({dexId:'fake-pancakeswap'}),market({pairAddress:'not-a-pool'}),market({baseToken:{address:other,name:token},quoteToken:{address:token}}),
  market({info:{header:icon}}),market({info:{imageUrl:'http://example.com/x'}}),market({info:{imageUrl:'https://127.0.0.1/private'}}),market({info:{imageUrl:'https://user:pass@example.com/x'}}),
 ])('rejects wrong-chain, wrong-contract, non-Pancake, header-only and unsafe records',value=>{
  expect(freshPancakeArtworkFromJson(body([value]),token)).toBeNull();
 });
 it('rejects conflicts, nested spoofed JSON, oversized pages and unbounded pair lists',()=>{
  expect(freshPancakeArtworkFromJson(body([market(),market({info:{imageUrl:'https://example.com/different.png'}})]),token)).toBeNull();
  expect(freshPancakeArtworkFromJson(JSON.stringify({pairs:[],description:body([market()])}),token)).toBeNull();
  expect(freshPancakeArtworkFromJson(body(Array.from({length:501},()=>market())),token)).toBeNull();
  expect(freshPancakeArtworkFromJson(JSON.stringify({pairs:[market()],description:'x'.repeat(512*1024)}),token)).toBeNull();
 });
 it('downloads and normalizes the market image without returning financial metadata',async()=>{
  const bytes=await png(),calls:string[]=[];const result=await loadFreshArtwork(token,{provider:'pancakeswap',transport:async url=>{calls.push(url);return new Response(url===endpoint?body([market()]):new Uint8Array(bytes));}});
  expect(calls).toEqual([endpoint,icon]);expect(result.source).toBe('pancakeswap_market_record');expect(Object.keys(result).sort()).toEqual(['data','mime','source','url']);expect((await sharp(result.data).metadata()).format).toBe('webp');
 });
 it('automatically recovers after both generic launchpad lookups have no artwork',async()=>{
  const bytes=await png(),calls:string[]=[];
  const result=await loadFreshArtwork(token,{provider:'auto',marketFallback:true,transport:async url=>{calls.push(url);return new Response(url===endpoint?body([market()]):url===icon?new Uint8Array(bytes):'{}');}});
  expect(result.source).toBe('pancakeswap_market_record');expect(calls).toEqual([`https://four.meme/meme-api/v1/private/token/get/v2?address=${token}`,`https://genius.fun/token/${token}`,endpoint,icon]);
 });
 it('falls back after a launchpad image fails while leaving good launchpad artwork primary',async()=>{
  const bytes=await png(),launchIcon='https://static.four.meme/good.png',calls:string[]=[];
  const run=(bad:boolean)=>loadFreshArtwork(token,{provider:'fourmeme',marketFallback:true,transport:async url=>{calls.push(url);return url===launchIcon?new Response(bad?'broken':new Uint8Array(bytes)):new Response(url===endpoint?body([market()]):url===icon?new Uint8Array(bytes):JSON.stringify({code:0,data:{address:token,networkCode:'BSC',image:launchIcon}}));}});
  expect((await run(true)).source).toBe('pancakeswap_market_record');calls.length=0;expect((await run(false)).source).toBe('fourmeme_token_record');expect(calls).not.toContain(endpoint);
 });
 it('caller cancellation never starts another provider',async()=>{
  const controller=new AbortController(),transport=vi.fn(async()=>{controller.abort();throw Error('stop');});
  await expect(loadFreshArtwork(token,{provider:'auto',marketFallback:true,signal:controller.signal,transport})).rejects.toThrow('artwork_deadline');expect(transport).toHaveBeenCalledTimes(1);
 });
 it('an internal primary deadline reserves time for the market fallback',async()=>{
  vi.useFakeTimers();const timeout=vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{const controller=new AbortController();setTimeout(()=>controller.abort(),ms);return controller.signal;});try{
   const bytes=await png();const transport=vi.fn(async(url:string,{signal}:{signal:AbortSignal})=>{if(url===endpoint)return new Response(body([market()]));if(url===icon)return new Response(new Uint8Array(bytes));return new Promise<Response>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('primary_deadline')),{once:true}));});
   const pending=loadFreshArtwork(token,{provider:'genius',marketFallback:true,transport});await vi.advanceTimersByTimeAsync(12_001);const result=await pending;expect(result.source).toBe('pancakeswap_market_record');
  }finally{timeout.mockRestore();vi.useRealTimers();}
 });
});
