import {describe,it,expect,vi} from 'vitest';
import type {Pool} from 'pg';
import sharp from 'sharp';
import {freshFourMemeArtworkFromJson,loadFreshArtwork,runFreshArtwork} from './artwork.js';

const token='0x74361e7d05b6801c3b7d7f1cce9aa0d557d5ffff',other='0x'+'1'.repeat(40);
const image='https://static.four.meme/market/1028QMSeXgna81.png';
const endpoint=`https://four.meme/meme-api/v1/private/token/get/v2?address=${token}`;
const record=(patch:Record<string,unknown>={})=>JSON.stringify({code:0,data:{address:token,networkCode:'BSC',image,...patch}});
const png=()=>sharp({create:{width:16,height:16,channels:4,background:'yellow'}}).png().toBuffer();

describe('exact-contract Four.Meme and OpenFour artwork',()=>{
  it('selects the actual token image, not the OpenFour template or creator artwork',()=>{
    expect(freshFourMemeArtworkFromJson(record({userAvatar:'https://example.com/creator.png',tokenTemplateVo:{image:'https://example.com/template.png'},price:'invalid-financial-value'}),token)).toBe(image);
    expect(freshFourMemeArtworkFromJson(record({address:token.toUpperCase()}),token)).toBe(image);
  });
  it.each([
    record({address:other,name:token}),record({networkCode:'ETH'}),record({networkCode:null}),
    record({image:null,userAvatar:image}),record({image:'https://127.0.0.1/private'}),record({image:'http://example.com/icon.png'}),
    JSON.stringify({code:1,data:{address:token,networkCode:'BSC',image}}),
    JSON.stringify({code:0,data:[{address:token,networkCode:'BSC',image}]}),
    JSON.stringify({code:0,data:{description:record()}}),
    '<script>'+record()+'</script>',record({description:'x'.repeat(512*1024)}),
  ])('rejects another identity, chain, nested/spoofed image or oversized response',value=>{
    expect(freshFourMemeArtworkFromJson(value,token)).toBeNull();
  });
  it('normalizes real response-shaped artwork and consumes no financial metadata',async()=>{
    const bytes=await png(),calls:string[]=[];
    const result=await loadFreshArtwork(token,{provider:'fourmeme',transport:async url=>{calls.push(url);return new Response(url===endpoint?record({tokenPrice:{price:'999999'}}):new Uint8Array(bytes));}});
    expect(calls).toEqual([endpoint,image]);expect(result.source).toBe('fourmeme_token_record');
    expect((await sharp(result.data).metadata()).format).toBe('webp');
    expect(Object.keys(result).sort()).toEqual(['data','mime','source','url']);
  });
  it('discovers OpenFour artwork for a generic canonical EVM creation without probing Genius',async()=>{
    const bytes=await png(),calls:string[]=[];
    const result=await loadFreshArtwork(token,{provider:'auto',transport:async url=>{calls.push(url);return new Response(url===endpoint?record():new Uint8Array(bytes));}});
    expect(result.source).toBe('fourmeme_token_record');expect(calls).toEqual([endpoint,image]);
  });
  it.each([200,404])('retains exact Genius discovery after Four.Meme has no matching record (HTTP %s)',async status=>{
    const bytes=await png(),calls:string[]=[],genius=`https://genius.fun/token/${token}`;
    const geniusImage='https://example.com/genius.png';
    const page=`<link rel="canonical" href="${genius}"/><meta property="og:image" content="https://genius.fun/api/image?src=${encodeURIComponent(geniusImage)}"/>`;
    const result=await loadFreshArtwork(token,{provider:'auto',transport:async url=>{calls.push(url);return url===endpoint?new Response(record({address:other}),{status}):new Response(url===genius?page:new Uint8Array(bytes));}});
    expect(result.source).toBe('genius_contract_page');expect(calls).toEqual([endpoint,genius,geniusImage]);
  });
  it('does not fetch an image from a mismatched token or follow a redirect',async()=>{
    const transport=vi.fn(async()=>new Response(record({address:other})));
    await expect(loadFreshArtwork(token,{provider:'fourmeme',transport})).rejects.toThrow('artwork_not_published');expect(transport).toHaveBeenCalledTimes(1);
    await expect(loadFreshArtwork(token,{provider:'fourmeme',transport:async()=>new Response(null,{status:302,headers:{location:'https://127.0.0.1/private'}})})).rejects.toThrow('artwork_response_unavailable');
  });
  it('cancellation never starts the second provider',async()=>{
    const controller=new AbortController(),transport=vi.fn(async()=>{controller.abort();throw Error('cancelled');});
    await expect(loadFreshArtwork(token,{provider:'auto',signal:controller.signal,transport})).rejects.toThrow('artwork_deadline');expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe('launch protocol routing for optional cached artwork',()=>{
  it.each([['flap','flap'],['fourmeme','fourmeme'],['evm_creation','auto']])('routes %s to %s without changing launch classification or finances',async(protocol,provider)=>{
    const query=vi.fn().mockResolvedValueOnce({rows:[{address:token,protocol}],rowCount:1}).mockResolvedValue({rows:[{saved:1}],rowCount:1});
    const loader=vi.fn(async()=>({data:await png(),mime:'image/webp' as const,url:image,source:'fourmeme_token_record' as const}));
    expect(await runFreshArtwork({query}as unknown as Pool,{loader})).toEqual({ready:1,failed:0});
    expect(loader).toHaveBeenCalledWith(token,{signal:undefined,provider,marketFallback:true});
    const writes=query.mock.calls.slice(1).map(([sql])=>String(sql)).join('\n');
    expect(writes).not.toMatch(/UPDATE fresh\.(?:financial_events|positions|kols|launch_facts)|INSERT INTO fresh\.(?:financial_events|positions|kols|launch_facts)/);
  });
});
