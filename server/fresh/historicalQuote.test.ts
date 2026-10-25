import {describe,it,expect} from 'vitest';
import {Interface} from 'ethers';
import type {Rpc} from '../rpc.js';
import {WBNB} from '../launchpad.js';
import {recoverFreshHistoricalQuote} from './historicalQuote.js';
const abi=new Interface(['function decimals() view returns(uint8)','function description() view returns(string)',
  'function latestRoundData() view returns(uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)',
  'function getRoundData(uint80) view returns(uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)']);
const h=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
const target={number:100,hash:h(100),timestamp:'2026-10-22T18:50:00.000Z'},anchor={number:200,hash:h(200),timestamp:'2026-10-22T19:00:00.000Z'};
const epoch=Date.parse('2026-10-22T18:40:00Z')/1000;
function fake(options:{missing?:bigint;nonmonotonic?:boolean;description?:string;stale?:boolean;phase?:bigint}={}){
 const calls:any[]=[],phase=options.phase??2n,id=(n:bigint)=>(phase<<64n)|n;
 const rpc=(async(method:string,params:unknown[])=>{expect(method).toBe('eth_call');calls.push(params);expect(params[1]).toEqual({blockHash:anchor.hash,requireCanonical:true});
 const parsed=abi.parseTransaction({data:(params[0] as any).data})!;
 if(parsed.name==='decimals')return abi.encodeFunctionResult(parsed.name,[8]);
 if(parsed.name==='description')return abi.encodeFunctionResult(parsed.name,[options.description??'BNB / USD']);
 let n=parsed.name==='latestRoundData'?20n:BigInt(parsed.args[0])&((1n<<64n)-1n);
 if(n===options.missing)throw Error('missing_round');
 let timestamp=epoch+Number(n)*60;if(options.stale)timestamp-=10000;
 if(options.nonmonotonic&&n===10n)timestamp+=2000;
 return abi.encodeFunctionResult(parsed.name,[id(n),100_000_000_000n+n,timestamp,timestamp,id(n)]);
 }) as Rpc;return{rpc,calls};
}
describe('historical oracle recovery',()=>{
 it('uses the actual historical bracket rather than the current answer',async()=>{const f=fake(),p=await recoverFreshHistoricalQuote({rpc:f.rpc,tokenAddress:WBNB,target,anchor});
 expect(p.priceUsd).toBe('1000.0000001');expect(p.selectedRound).toBe(String((2n<<64n)|10n));expect(p.nextRound).toBe(String((2n<<64n)|11n));expect(f.calls.length).toBeLessThan(12);expect(p.target).toEqual(target);expect(p.anchor).toEqual(anchor);});
 it('revalidates retained observations without another upstream call',async()=>{const f=fake(),p=await recoverFreshHistoricalQuote({rpc:f.rpc,tokenAddress:WBNB,target,anchor});
 const none=(async()=>{throw Error('must_not_read')}) as Rpc;expect((await recoverFreshHistoricalQuote({rpc:none,tokenAddress:WBNB,target,anchor,prior:p})).priceUsd).toBe(p.priceUsd);});
 it('rejects foreign target, source, result or chosen round in retained proof',async()=>{const f=fake(),p=await recoverFreshHistoricalQuote({rpc:f.rpc,tokenAddress:WBNB,target,anchor});
 for(const prior of [{...p,target:{...target,hash:h(99)}},{...p,feed:h(1)},{...p,priceUsd:'999'},{...p,selectedRound:'1'}])await expect(recoverFreshHistoricalQuote({rpc:f.rpc,tokenAddress:WBNB,target,anchor,prior})).rejects.toThrow();});
 it('rejects missing rounds instead of interpolating',async()=>{await expect(recoverFreshHistoricalQuote({...fake({missing:10n}),tokenAddress:WBNB,target,anchor})).rejects.toThrow('missing_round');});
 it('rejects nonmonotonic sampled data and incorrect feed identity',async()=>{for(const opts of [{nonmonotonic:true},{description:'OTHER / USD'}])await expect(recoverFreshHistoricalQuote({...fake(opts),tokenAddress:WBNB,target,anchor})).rejects.toThrow();});
 it('rejects stale rounds and unsupported earlier phases',async()=>{await expect(recoverFreshHistoricalQuote({...fake({stale:true}),tokenAddress:WBNB,target,anchor})).rejects.toThrow('historical_oracle_stale');
 await expect(recoverFreshHistoricalQuote({...fake(),tokenAddress:WBNB,target:{...target,timestamp:'2026-10-22T18:39:00Z'},anchor})).rejects.toThrow('historical_oracle_phase_unsupported');});
 it('allows the latest round only when it genuinely predates the historical target',async()=>{const f=fake(),later={...target,timestamp:anchor.timestamp};const p=await recoverFreshHistoricalQuote({rpc:f.rpc,tokenAddress:WBNB,target:later,anchor});expect(p.nextRound).toBeNull();expect(p.selectedRound).toBe(String((2n<<64n)|20n));});
 it('fails bounded work and unknown quote assets',async()=>{let clock=0;await expect(recoverFreshHistoricalQuote({...fake(),tokenAddress:WBNB,target,anchor,now:()=>clock+=9000})).rejects.toThrow('historical_oracle_work_bounds');
 await expect(recoverFreshHistoricalQuote({...fake(),tokenAddress:'0x'+'1'.repeat(40),target,anchor})).rejects.toThrow('historical_oracle_identity_invalid');});
});
