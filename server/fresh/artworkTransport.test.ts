import {it,expect,vi} from 'vitest';
import {fetch as undiciFetch} from 'undici';
import sharp from 'sharp';
import {loadFreshArtwork} from './artwork.js';

vi.mock('undici',async original=>({...await original<typeof import('undici')>(),fetch:vi.fn()}));

it('requests JSON explicitly for the Four.Meme API while retaining manual redirects and the public-DNS dispatcher',async()=>{
  const token='0x74361e7d05b6801c3b7d7f1cce9aa0d557d5ffff',image='https://static.four.meme/market/1028QMSeXgna81.png';
  const data=await sharp({create:{width:4,height:4,channels:3,background:'yellow'}}).png().toBuffer();
  const response=(value:Response)=>value as unknown as Awaited<ReturnType<typeof undiciFetch>>;
  vi.mocked(undiciFetch).mockResolvedValueOnce(response(new Response(JSON.stringify({code:0,data:{address:token,networkCode:'BSC',image}}))))
    .mockResolvedValueOnce(response(new Response(new Uint8Array(data))));
  const result=await loadFreshArtwork(token,{provider:'fourmeme'});
  expect(result.source).toBe('fourmeme_token_record');expect(undiciFetch).toHaveBeenCalledTimes(2);
  expect(undiciFetch).toHaveBeenNthCalledWith(1,`https://four.meme/meme-api/v1/private/token/get/v2?address=${token}`,
    expect.objectContaining({redirect:'manual',dispatcher:expect.anything(),headers:{accept:expect.stringContaining('application/json')}}));
});

it('uses the Flap launch metadata image when one IPFS gateway fails',async()=>{
  const token='0x92dbcd44f5853eb23327e2d430db10ac4ad57777';
  const metadata='bafkreia55m5uh2xls5wieql7foog5yactgofmu5yeczmzbup2hhepe6e3e';
  const image='bafkreigxjygbccibcwmnj2i7mdrcqwrt6cglnhpgl6aq4khtqphrfu3o5e';
  const data=await sharp({create:{width:4,height:4,channels:3,background:'yellow'}}).png().toBuffer();
  const transport=vi.fn(async(url:string)=>{
    if(url===`https://ipfs.filebase.io/ipfs/${metadata}`)return new Response(JSON.stringify({image:`ipfs://${image}`}));
    if(url===`https://ipfs.filebase.io/ipfs/${image}`)return new Response(new Uint8Array(data));
    return new Response(null,{status:403});
  });
  const result=await loadFreshArtwork(token,{provider:'flap',flapMetadataUri:async()=>`https://gateway.pinata.cloud/ipfs/${metadata}`,transport});
  expect(result).toMatchObject({source:'flap_launch_metadata',url:`https://ipfs.filebase.io/ipfs/${image}`,mime:'image/webp'});
  expect(await sharp(result.data).metadata()).toMatchObject({width:4,height:4});
  expect(transport.mock.calls.every(([url])=>url.includes('/ipfs/'))).toBe(true);
});
