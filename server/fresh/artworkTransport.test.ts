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
