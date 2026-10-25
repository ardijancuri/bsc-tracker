import {describe,it,expect} from 'vitest';
import {freshNativeBuyCost} from './routerPayment.js';
import type {FreshTransaction,FreshLog} from './capture.js';
const w='0x'+'1'.repeat(40),t='0x'+'2'.repeat(40),r='0x1de460f363af910f51726def188f9004276bf4bc';
const word=(v:bigint|string)=>typeof v==='bigint'?v.toString(16).padStart(64,'0'):v.slice(2).padStart(64,'0');
const tx={from:w,to:r,value:'0x64'} as FreshTransaction;
const log=()=>({address:r,topics:['0x8619026a40d38bedb4002fe511cea4bc4a9b336710efe8f21a61869a7ee0f02a','0x'+word(w),'0x'+word(w),'0x'+word(0n)],
 data:'0x'+[100n,200n,96n,1n,32n,7n,0n,t,r,0n,0n,0n,320n,0n,0n,0n].map(word).join('')}) as FreshLog;
describe('receipt-proven native purchase cost',()=>{
 it('matches a single authenticated exact-input receipt to paid value and token increase',()=>expect(freshNativeBuyCost(tx,w,t,200n,[log()])).toBe(100n));
 it('rejects unknown routers, another sender or recipient and a different token',()=>{expect(freshNativeBuyCost({...tx,to:t},w,t,200n,[log()])).toBeNull();expect(freshNativeBuyCost({...tx,from:t},w,t,200n,[log()])).toBeNull();expect(freshNativeBuyCost(tx,w,r,200n,[log()])).toBeNull();const l=log();l.topics[2]='0x'+word(t);expect(freshNativeBuyCost(tx,w,t,200n,[l])).toBeNull();});
 it('does not infer spent value from tx.value alone or accept mismatched receipts',()=>{expect(freshNativeBuyCost(tx,w,t,200n,[])).toBeNull();expect(freshNativeBuyCost(tx,w,t,201n,[log()])).toBeNull();expect(freshNativeBuyCost({...tx,value:'0x65'},w,t,200n,[log()])).toBeNull();});
 it('rejects multicall ambiguity, removed logs and malformed route payloads',()=>{expect(freshNativeBuyCost(tx,w,t,200n,[log(),log()])).toBeNull();expect(freshNativeBuyCost(tx,w,t,200n,[{...log(),removed:true}])).toBeNull();expect(freshNativeBuyCost(tx,w,t,200n,[{...log(),data:'0x12'}])).toBeNull();const l=log();l.data=l.data.slice(0,2+3*64)+word(2n)+l.data.slice(2+4*64);expect(freshNativeBuyCost(tx,w,t,200n,[l])).toBeNull();});
});
