import {describe,it,expect,vi} from 'vitest';
import type {Rpc} from '../rpc.js';
import {createFreshHistoricalValuationOptions,freshHistoricalValuation} from './valuationContext.js';
import {freshCurrentQuote,persistFreshQuote,commitFreshCurrentQuote} from './pricing.js';
const target={number:100,hash:'0x'+'a'.repeat(64),timestamp:'2026-10-20T00:00:00.000Z'},other='0x'+'b'.repeat(64);
function fixture(options:{chain?:string;hash?:string;number?:number;timestamp?:string}={}){
  const rpc=vi.fn(async(method:string,params:unknown[])=>{
    if(method==='eth_chainId')return options.chain??'0x38';
    if(method==='eth_getBlockByNumber'){expect(params).toEqual(['0x64',false]);return{number:'0x'+(options.number??100).toString(16),hash:options.hash??target.hash,timestamp:'0x'+(Date.parse(options.timestamp??target.timestamp)/1000).toString(16)};}
    return'0x6000';
  }) as unknown as Rpc&ReturnType<typeof vi.fn>;
  return{rpc};
}
describe('explicit original-block historical valuation capability',()=>{
  it('verifies the actual RPC canonical header and freezes the original observation',async()=>{
    const f=fixture(),local=vi.fn(async()=>({...target})),options=await createFreshHistoricalValuationOptions(f.rpc,target,local);
    expect(freshHistoricalValuation(options)).toBe(true);expect(options.block).toEqual(target);expect(Object.isFrozen(options.block)).toBe(true);
    expect(()=>{options.block.timestamp='2026-10-24T00:00:00Z';}).toThrow();
    expect(f.rpc.mock.calls.map(([method])=>method)).toEqual(['eth_chainId','eth_getBlockByNumber']);expect(local).toHaveBeenCalledExactlyOnceWith(100);
  });
  it.each([{chain:'0x1'},{hash:other},{number:101},{timestamp:'2026-10-20T00:00:01.000Z'}])('rejects foreign chain/header identity',async patch=>{
    await expect(createFreshHistoricalValuationOptions(fixture(patch).rpc,target)).rejects.toThrow();
  });
  it('does not trust a matching caller pseudo-header when the actual RPC header disagrees',async()=>{
    await expect(createFreshHistoricalValuationOptions(fixture({hash:other}).rpc,target,async()=>target)).rejects.toThrow('historical_valuation_noncanonical');
    await expect(createFreshHistoricalValuationOptions(fixture().rpc,target,async()=>({...target,hash:other}))).rejects.toThrow('historical_valuation_noncanonical');
  });
  it('rejects forged/copied capabilities, changed blocks and replacement RPCs',async()=>{
    const f=fixture(),options=await createFreshHistoricalValuationOptions(f.rpc,target);
    for(const patch of[{historicalValuation:JSON.parse(JSON.stringify(options.historicalValuation))},{block:{...target,hash:other}},{block:{...target,timestamp:'2026-10-21T00:00:00.000Z'}},{rpc:f.rpc}]){
      expect(()=>freshHistoricalValuation({...options,...patch})).toThrow('historical_valuation_context_invalid');
    }
    expect(freshHistoricalValuation({rpc:f.rpc,block:target})).toBe(false);
  });
  it('forbids latest, foreign hashes, weakened canonical selectors and unrelated RPC methods before upstream I/O',async()=>{
    const f=fixture(),options=await createFreshHistoricalValuationOptions(f.rpc,target),before=f.rpc.mock.calls.length;
    for(const [method,params] of[
      ['eth_call',[{to:'0x'+'1'.repeat(40),data:'0x'},'latest']],['eth_getCode',['0x'+'1'.repeat(40),'latest']],
      ['eth_getCode',['0x'+'1'.repeat(40),{blockHash:other,requireCanonical:true}]],['eth_call',[{to:'0x'+'1'.repeat(40),data:'0x'},{blockHash:target.hash,requireCanonical:false}]],
      ['eth_blockNumber',[]],['eth_getLogs',[{}]],['eth_getBlockByNumber',['latest',false]],
    ] as [string,unknown[]][])await expect(options.rpc(method,params)).rejects.toThrow('historical_valuation_request_invalid');
    expect(f.rpc.mock.calls).toHaveLength(before);
    await expect(options.rpc('eth_getCode',['0x'+'1'.repeat(40),{blockHash:target.hash,requireCanonical:true}])).resolves.toBe('0x6000');
  });
  it('rejects a forged historical flag at the quote entry point before reading metadata',async()=>{
    const f=fixture();await expect(freshCurrentQuote('0x'+'1'.repeat(40),{rpc:f.rpc,block:target,historicalValuation:{kind:'verified_historical_block',target}})).rejects.toThrow('historical_valuation_context_invalid');expect(f.rpc).not.toHaveBeenCalled();
  });
  it('never promotes an explicitly historical valuation into current token/market rows',async()=>{
    const query=vi.fn(),connect=vi.fn(),quote={observationContext:'historical_block'} as any;
    await expect(persistFreshQuote({query} as any,quote)).rejects.toThrow('historical_valuation_not_current');
    await expect(commitFreshCurrentQuote({connect} as any,quote,{captureRevision:1})).rejects.toThrow('historical_valuation_not_current');
    expect(query).not.toHaveBeenCalled();expect(connect).not.toHaveBeenCalled();
  });
});
