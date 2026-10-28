import {describe,it,expect,vi} from 'vitest';
import sharp from 'sharp';
import {freshArtworkRaster,freshArtworkUrl,freshFlapArtworkFromHtml,loadFreshArtwork,normalizeFreshArtwork,runFreshArtwork,freshArtworkCaptureReady} from './artwork.js';
import {tokenIdentity} from './reads.js';
import type {Pool} from 'pg';

const token='0x9ae8b2957399e8103e7cc190ec1d9a12ec9a7777';
const other='0xef4c1eb1cb8bb806f15f61cd2710da8fbb827777';
const icon='https://assets.example/token.png';
const page=(address=token,image=icon)=>`<script>self.__next_f.push(${JSON.stringify([1,'5:'+JSON.stringify({coin:{address,name:'Test',metadata:{image},quoteToken:{metadata:{image:'https://assets.example/WRONG.png'}}}})+'\n'])})</script>`;
const png=()=>sharp({create:{width:16,height:16,channels:4,background:'#f4c400'}}).png().toBuffer();

describe('optional contract-bound token artwork',()=>{
  it('reads only artwork of the exact Flap contract and normalizes it to cached WebP',async()=>{
    const bytes=await png(),calls:string[]=[];
    const result=await loadFreshArtwork(token,{transport:async url=>{calls.push(url);return url===icon?new Response(new Uint8Array(bytes)):new Response(page());}});
    expect(calls).toEqual([`https://flap.sh/bnb/${token}`,icon]);expect(result.mime).toBe('image/webp');
    expect(await sharp(result.data).metadata()).toMatchObject({format:'webp',width:16,height:16});
    expect(result).not.toHaveProperty('price');
  });
  it('rejects another contract and never selects nested quote-token artwork',async()=>{
    const transport=vi.fn(async()=>new Response(page(other)));
    await expect(loadFreshArtwork(token,{transport})).rejects.toThrow('artwork_not_published');expect(transport).toHaveBeenCalledTimes(1);
  });
  it('does not reinterpret malicious descriptions, nested metadata or raw escaped JSON as a coin',()=>{
    const spoof={coin:{address:token,metadata:{image:'https://evil.example/spoof.png'}}};
    const wrong={coin:{address:other,metadata:{description:JSON.stringify(spoof),nested:spoof}}};
    const html=`<script>self.__next_f.push(${JSON.stringify([1,'5:'+JSON.stringify(wrong)+'\n'])})</script>`;
    expect(freshFlapArtworkFromHtml(html,token)).toBeNull();
    expect(freshFlapArtworkFromHtml(JSON.stringify(spoof).replaceAll('"','\\"'),token)).toBeNull();
  });
  it('joins streamed Flight records without executing scripts or interpreting string records',()=>{
    const json='5:'+JSON.stringify({coin:{address:token,metadata:{image:icon}}})+'\n',split=Math.floor(json.length/2);
    const html=[json.slice(0,split),json.slice(split)].map(value=>`<script>self.__next_f.push(${JSON.stringify([1,value])})</script>`).join('');
    expect(freshFlapArtworkFromHtml(html,token)).toBe(icon);
    expect(freshFlapArtworkFromHtml(`<script>self.__next_f.push(${JSON.stringify([1,'5:'+JSON.stringify(json)+'\n'])})</script>`,token)).toBeNull();
  });
  it.each(['http://example.com/a','https://127.0.0.1/private','https://[::1]/x','https://2130706433/a','https://user:pass@example.com/x','https://example.com:444/x','file:///a'])('rejects unsafe artwork URL %s',url=>expect(freshArtworkUrl(url)).toBeNull());
  it('does not follow an official-page redirect or request an untrusted private target',async()=>{
    const transport=vi.fn(async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/'}}));
    await expect(loadFreshArtwork(token,{transport})).rejects.toThrow('artwork_response_unavailable');expect(transport).toHaveBeenCalledTimes(1);
    const privateUrl=vi.fn(async()=>new Response(page(token,'https://127.0.0.1/secret')));
    await expect(loadFreshArtwork(token,{transport:privateUrl})).rejects.toThrow('artwork_url_rejected');expect(privateUrl).toHaveBeenCalledTimes(1);
  });
  it('enforces declared and streaming body limits',async()=>{
    await expect(loadFreshArtwork(token,{transport:async()=>new Response('small',{headers:{'content-length':String(512*1024+1)}})})).rejects.toThrow('artwork_response_unavailable');
    await expect(loadFreshArtwork(token,{transport:async()=>new Response('x'.repeat(512*1024+1))})).rejects.toThrow('artwork_body_limit');
    await expect(loadFreshArtwork(token,{transport:async url=>url===icon?new Response('x',{headers:{'content-length':String(10*1024*1024+1)}}):new Response(page())})).rejects.toThrow('artwork_response_unavailable');
  });
  it('extracts a passive single embedded PNG without passing SVG to the decoder',async()=>{
    const bytes=await png(),svg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img" aria-labelledby="title"><title id="title">BTCB Token (BTCB)</title><image width="64" height="64" href="data:image/png;base64,${bytes.toString('base64')}"/></svg>`);
    expect(freshArtworkRaster(svg)).toEqual(bytes);expect((await sharp((await normalizeFreshArtwork(svg))!).metadata()).format).toBe('webp');
  });
  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://127.0.0.1/x"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>image{fill:url(https://evil.test/a)}</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><use href="file:///private"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject>external</foreignObject></svg>',
  ])('rejects all active/external SVG instead of rasterizing it',value=>expect(freshArtworkRaster(Buffer.from(value))).toBeNull());
  it('rejects corrupt raster input, oversized dimensions and SVG mime mismatches',async()=>{
    expect(await normalizeFreshArtwork(Buffer.from('not an image'))).toBeNull();
    expect(await normalizeFreshArtwork(await sharp({create:{width:4097,height:1,channels:3,background:'white'}}).png().toBuffer())).toBeNull();
    const bytes=await png();expect(freshArtworkRaster(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/jpeg;base64,${bytes.toString('base64')}"/></svg>`))).toBeNull();
  });
  it('returns only bounded failure categories and honors consumer cancellation',async()=>{
    const aborted=new AbortController();aborted.abort();
    await expect(loadFreshArtwork(token,{signal:aborted.signal,transport:async(_url,{signal})=>{if(signal.aborted)throw Error('SECRET_URL');return new Response(page());}})).rejects.toThrow('artwork_deadline');
  });
});

describe('artwork durable work and read identities',()=>{
  it('permits optional images despite an old repair gap when current capture and decoding are healthy',()=>{
    const now=Date.now(),state={capture_ok:'true',decode_ok:'true',pending_current:false,occurred_at:new Date(now-3000),decode_checked_at:new Date(now-30_000),decode_lag:100_000};
    expect(freshArtworkCaptureReady(state,now)).toBe(true);
    for(const patch of[{pending_current:true},{capture_ok:'false'},{decode_ok:'false'},{occurred_at:new Date(now-20_001)},{decode_checked_at:new Date(now-60_001)},{occurred_at:'invalid'},{decode_checked_at:new Date(now+5001)}])expect(freshArtworkCaptureReady({...state,...patch},now)).toBe(false);
    expect(freshArtworkCaptureReady(undefined,now)).toBe(false);
  });
  it('queries only eligible public traded tokens and never starts financial work',async()=>{
    const query=vi.fn(async(sql:string)=>({rows:[],rowCount:0}));
    expect(await runFreshArtwork({query} as unknown as Pool)).toEqual({ready:0,failed:0});
    expect(query.mock.calls[0][0]).toContain('k.is_tracked');expect(query.mock.calls[0][0]).toContain('e.canonical');expect(query.mock.calls[0][0]).toContain("e.kind IN('buy','sell')");
    expect(query.mock.calls[0][0]).toContain("t.launch_status='eligible'");expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain("lf.token_address=t.address AND lf.status='eligible'");
  });
  it('an existing active lease prevents duplicate upstream work',async()=>{
    const query=vi.fn().mockResolvedValueOnce({rows:[{address:token}],rowCount:1}).mockResolvedValue({rows:[],rowCount:0});
    const loader=vi.fn();expect(await runFreshArtwork({query} as unknown as Pool,{loader})).toEqual({ready:0,failed:0});expect(loader).not.toHaveBeenCalled();
  });
  it('stores only normalized bytes in token identity columns and finishes its own lease',async()=>{
    const bytes=await png(),query=vi.fn().mockResolvedValueOnce({rows:[{address:token}],rowCount:1}).mockResolvedValue({rows:[{saved:1}],rowCount:1});
    const loader=vi.fn(async()=>({data:bytes,mime:'image/webp' as const,url:icon,source:'flap_contract_page' as const}));
    expect(await runFreshArtwork({query} as unknown as Pool,{loader})).toEqual({ready:1,failed:0});
    expect(query.mock.calls[2][0]).toContain('SET logo_data=$2,logo_mime=$3,logo_url=$4');expect(query.mock.calls[2][0]).not.toContain('price_usd');
    expect(query.mock.calls[2][0]).toContain('e.canonical');expect(query.mock.calls[2][0]).toContain('DELETE FROM fresh.jobs');expect(query).toHaveBeenCalledTimes(3);
  });
  it('defers a failure without blocking financial decoding or returning source data',async()=>{
    const query=vi.fn().mockResolvedValueOnce({rows:[{address:token}],rowCount:1}).mockResolvedValue({rows:[{}],rowCount:1});
    expect(await runFreshArtwork({query} as unknown as Pool,{loader:async()=>{throw Error('SECRET_RESPONSE');}})).toEqual({ready:0,failed:1});
    expect(query.mock.calls[2][0]).toContain("interval '1 hour'");expect(query.mock.calls[2][1][2]).toBe('artwork_unavailable');
  });
  it('uses local cached artwork and exposes no-liquidity without stale current market cap',()=>{
    const value=tokenIdentity({address:token,logo_data:Buffer.from('cached'),logo_url:icon,valuation_status:'no_liquidity',price_usd:'1',market_cap_usd:'100'});
    expect(value.logoUrl).toBe(`/api/token-image/${token}`);expect(value.priceUsd).toBeNull();expect(value.marketCapUsd).toBeNull();expect(value.valuationStatus).toBe('no_liquidity');
  });
});
