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

const gang='0x0c6302401aa5325c2e36f170f52c00b1d220b405',pair='0x0bd5ded695d61c2db15c703c345d57e039fd0b6d',bnb='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const feeTopic='0x205442d60b70af1203d43cab62352c3b69b94f091be32fe683198057282b5c92',depositTopic='0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c';
const transferTopic='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',syncTopic='0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';
const poolSwapTopic='0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',swapTopic='0x8619026a40d38bedb4002fe511cea4bc4a9b336710efe8f21a61869a7ee0f02a';
function wrappedFixture(){
 const route=[0n,bnb,gang,pair,2500n,50n,0n,320n,0n,0n,0n];
 const transaction={from:w,to:r,value:'0x2710',type:'0x0',chainId:'0x38',hash:'0x'+'a'.repeat(64),blockHash:'0x'+'b'.repeat(64),blockNumber:'0x64',transactionIndex:'0x2',
  input:'0x4d819a2a'+[160n,0n,10000n,19000n,1000n,1n,32n,...route].map(word).join('')}as FreshTransaction;
 const make=(address:string,signature:string,addresses:(string|bigint)[],values:(string|bigint)[],index:number)=>({address,topics:[signature,...addresses.map(value=>'0x'+word(value))],data:'0x'+values.map(word).join(''),logIndex:'0x'+index.toString(16),transactionHash:transaction.hash,blockHash:transaction.blockHash,blockNumber:transaction.blockNumber,transactionIndex:transaction.transactionIndex})as FreshLog;
 const logs=[make(r,feeTopic,[0n,w],[100n,900n],10),make(bnb,depositTopic,[r],[9900n],11),make(bnb,transferTopic,[r,pair],[9900n],12),
  make(gang,transferTopic,[pair,w],[20000n],13),make(pair,syncTopic,[],[50000n,30000n],14),make(pair,poolSwapTopic,[r,w],[0n,9900n,20000n,0n],15),
  make(r,swapTopic,[w,w,0n],[10000n,20000n,96n,1n,32n,...route],16)];
 return{transaction,logs};
}
const replaceWord=(data:string,index:number,value:bigint|string)=>data.slice(0,2+index*64)+word(value)+data.slice(2+(index+1)*64);
describe('receipt-proven native-funded wrapped-BNB GANG purchase',()=>{
 it('retains gross native cost including the explicit expense, with gas accounted elsewhere',()=>{const f=wrappedFixture();expect(freshNativeBuyCost(f.transaction,w,gang,20000n,f.logs)).toBe(10000n);});
 it.each(['0x0','0x1','0x2'])('accepts an ordinary signed transaction of type%s',type=>{const f=wrappedFixture();f.transaction.type=type;expect(freshNativeBuyCost(f.transaction,w,gang,20000n,f.logs)).toBe(10000n);});
 const rounded=()=>{const f=wrappedFixture();f.transaction.value='0x2731';f.transaction.input='0x4d819a2a'+replaceWord('0x'+(f.transaction.input as string).slice(10),2,10033n).slice(2);
  f.logs[6].data=replaceWord(f.logs[6].data,0,10033n);f.logs[1].data='0x'+word(9933n);f.logs[2].data='0x'+word(9933n);f.logs[5].data=replaceWord(f.logs[5].data,1,9933n);return f;};
 it('retains every signed wei when the authenticated percentage expense uses integer floor',()=>{const f=rounded();expect(freshNativeBuyCost(f.transaction,w,gang,20000n,f.logs)).toBe(10033n);});
 it('rejects a rounded-up expense even when the forged split totals signed value',()=>{const f=rounded();f.logs[0].data=replaceWord(f.logs[0].data,0,101n);f.logs[1].data='0x'+word(9932n);f.logs[2].data='0x'+word(9932n);f.logs[5].data=replaceWord(f.logs[5].data,1,9932n);expect(freshNativeBuyCost(f.transaction,w,gang,20000n,f.logs)).toBeNull();});
 const reject=(name:string,mutate:(f:ReturnType<typeof wrappedFixture>)=>void)=>it(name,()=>{const f=wrappedFixture();mutate(f);expect(freshNativeBuyCost(f.transaction,w,gang,20000n,f.logs)).toBeNull();});
 reject('rejects ERC20-funded WBNB with no native value',f=>{f.transaction.value='0x0';});
 reject('rejects a wallet WBNB transfer funding the route',f=>{f.logs[2].topics[1]='0x'+word(w);});
 reject('rejects an extra ERC20 funding or refund movement',f=>{f.logs.push({...f.logs[2],logIndex:'0x11'});});
 reject('rejects a WBNB withdrawal/refund instead of a deposit',f=>{f.logs[1].topics[0]='0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';});
 reject('rejects a deposit not received by the router',f=>{f.logs[1].topics[1]='0x'+word(w);});
 reject('rejects an unauthenticated market route',f=>{f.logs[6].data=replaceWord(f.logs[6].data,8,t);});
 reject('rejects another router even if it has the same Swap ABI',f=>{f.transaction.to='0x3508dca95a64c9378cb07ef6f40553a50905372a';f.logs[0].address=f.transaction.to;f.logs[6].address=f.transaction.to;});
 reject('rejects absent native expense evidence',f=>{f.logs[0].topics[0]='0x'+'f'.repeat(64);});
 reject('rejects a foreign fee payer',f=>{f.logs[0].topics[2]='0x'+word(t);});
 reject('rejects a fee charged in a token instead of native BNB',f=>{f.logs[0].topics[1]='0x'+word(bnb);});
 reject('rejects a fee/deposit total different from signed value',f=>{f.logs[0].data=replaceWord(f.logs[0].data,0,101n);});
 reject('rejects a different unexplained fee schedule',f=>{f.logs[0].data=replaceWord(f.logs[0].data,0,200n);f.logs[1].data='0x'+word(9800n);f.logs[2].data='0x'+word(9800n);f.logs[5].data=replaceWord(f.logs[5].data,1,9800n);});
 reject('rejects a pool payment different from the deposit',f=>{f.logs[2].data='0x'+word(9800n);});
 reject('rejects received output different from the wallet transfer',f=>{f.logs[3].data='0x'+word(19999n);});
 reject('rejects a pool output different from actual delivery',f=>{f.logs[5].data=replaceWord(f.logs[5].data,2,19999n);});
 reject('rejects an additional input or output leg',f=>{f.logs[5].data=replaceWord(f.logs[5].data,0,1n);});
 reject('rejects a different pool recipient',f=>{f.logs[5].topics[2]='0x'+word(r);});
 reject('rejects route calldata differing from the emitted route',f=>{f.transaction.input='0x4d819a2a'+replaceWord('0x'+(f.transaction.input as string).slice(10),10,t).slice(2);});
 reject('rejects trailing calldata or a second route',f=>{f.transaction.input+='0'.repeat(64);});
 reject('rejects a missing or different method selector',f=>{f.transaction.input='0xdeadbeef'+(f.transaction.input as string).slice(10);});
 reject('rejects signed value differing from calldata',f=>{f.transaction.input='0x4d819a2a'+replaceWord('0x'+(f.transaction.input as string).slice(10),2,9999n).slice(2);});
 reject('rejects a receipt spending for another asset',f=>{f.logs[6].topics[3]='0x'+word(bnb);});
 reject('rejects authorization or smart-account transactions',f=>{f.transaction.authorizationList=[];});
 reject('rejects type4 execution',f=>{f.transaction.type='0x4';});
 reject('rejects another chain',f=>{f.transaction.chainId='0x1';});
 reject('rejects orphan or foreign log context',f=>{f.logs[3].blockHash='0x'+'c'.repeat(64);});
 reject('rejects foreign transaction identity',f=>{f.logs[3].transactionHash='0x'+'c'.repeat(64);});
 reject('rejects inconsistent transaction position',f=>{f.logs[3].transactionIndex='0x3';});
 reject('rejects removed or duplicate log positions',f=>{f.logs[3].removed=true;});
 reject('rejects reordered logs',f=>{[f.logs[1],f.logs[2]]=[f.logs[2],f.logs[1]];});
 reject('rejects malformed receipt words',f=>{f.logs[0].data='0x01';});
 reject('rejects expired receipt timing relative to signed deadline',f=>{f.logs[0].data=replaceWord(f.logs[0].data,1,1001n);});
 it('cannot approve the same pattern for an unpinned target',()=>{const f=wrappedFixture();expect(freshNativeBuyCost(f.transaction,w,t,20000n,f.logs)).toBeNull();});
});

const wrapper='0x01a21c857a3219991fba2b1a2824b1b758966b54',pcs='0x10ed43c718714eb63d5aa57b78b54704e256024e',expenseRecipient='0xdefb37382e08d8a33abbc869a02e179cb28a0821';
const wrapperSwap='0xb4ebd56706d27fa01a1b393765021ba216f704b12bb50a87bf257d3ba6cd7bdc',wrapperExpense='0xb948f731b5e342e038ab722853f67007c439a74137633184c1d0513b21bf5a64';
function wrapperFixture(){
 const f=wrappedFixture(),trade=10n**18n,extra=300000000000000n,embedded=trade/100n,deposited=trade-embedded;
 f.transaction.to=wrapper;f.transaction.value='0x'+(trade+extra).toString(16);
 f.transaction.input='0x89f7f14f'+[gang,4n,19000n,1000n,224n,expenseRecipient,extra,160n,19000n,64n,2n,bnb,gang].map(word).join('');
 f.logs[0].address=wrapper;f.logs[0].topics=[wrapperExpense,'0x'+word(w),'0x'+word(expenseRecipient)];f.logs[0].data='0x'+word(extra);
 f.logs[1].topics[1]='0x'+word(pcs);f.logs[1].data='0x'+word(deposited);
 f.logs[2].topics[1]='0x'+word(pcs);f.logs[2].data='0x'+word(deposited);
 f.logs[5].topics[1]='0x'+word(pcs);f.logs[5].data='0x'+[0n,deposited,20000n,0n].map(word).join('');
 f.logs[6].address=wrapper;f.logs[6].topics=[wrapperSwap,'0x'+word(w)];f.logs[6].data='0x'+['0x'+'e'.repeat(40),gang,trade,20000n,embedded,4n].map(word).join('');
 return f;
}
describe('receipt-proven PCS wrapper native GANG purchase',()=>{
 it('includes the signed separate native expense and embedded expense exactly once, excluding gas',()=>{const f=wrapperFixture();expect(freshNativeBuyCost(f.transaction,w,gang,20000n,f.logs)).toBe(1000300000000000000n);});
 const reject=(name:string,mutate:(f:ReturnType<typeof wrapperFixture>)=>void)=>it(name,()=>{const f=wrapperFixture();mutate(f);expect(freshNativeBuyCost(f.transaction,w,gang,20000n,f.logs)).toBeNull();});
 const inputWord=(f:ReturnType<typeof wrapperFixture>,index:number,value:bigint|string)=>{f.transaction.input='0x89f7f14f'+replaceWord('0x'+(f.transaction.input as string).slice(10),index,value).slice(2);};
 reject('rejects a foreign outer wrapper',f=>{f.transaction.to=t;});
 reject('rejects a different wallet payer',f=>{f.transaction.from=t;});
 reject('rejects another chain',f=>{f.transaction.chainId='0x1';});
 reject('rejects delegated authorization and smart-account execution',f=>{f.transaction.authorizationList=[];});
 reject('rejects a sale selector and calldata with different ABI',f=>{f.transaction.input='0xdeadbeef'+(f.transaction.input as string).slice(10);});
 reject('rejects trailing signed calldata',f=>{f.transaction.input+='0'.repeat(64);});
 reject('rejects a different signed target',f=>inputWord(f,0,t));
 reject('rejects another DEX route',f=>inputWord(f,1,5n));
 reject('rejects an unattained signed minimum',f=>inputWord(f,2,20001n));
 reject('rejects noncanonical dynamic offsets',f=>inputWord(f,4,256n));
 reject('rejects another signed expense recipient',f=>inputWord(f,5,t));
 reject('rejects a different signed extra expense',f=>inputWord(f,6,300000000000001n));
 reject('rejects a different nested minimum output',f=>inputWord(f,8,18000n));
 reject('rejects an ERC20-funded path',f=>inputWord(f,11,t));
 reject('rejects an extra path hop',f=>inputWord(f,10,3n));
 reject('rejects a missing or duplicated separate expense event',f=>{f.logs.splice(0,1);});
 reject('rejects an unsigned or mismatched separate expense',f=>{f.logs[0].data='0x'+word(300000000000001n);});
 reject('rejects an expense paid by another wallet',f=>{f.logs[0].topics[1]='0x'+word(t);});
 reject('rejects an expense paid to another recipient',f=>{f.logs[0].topics[2]='0x'+word(t);});
 reject('rejects a native gross charge differing from trade plus expense',f=>{f.transaction.value='0x'+1000300000000000001n.toString(16);});
 reject('rejects a different deposited payer',f=>{f.logs[1].topics[1]='0x'+word(wrapper);});
 reject('rejects a WBNB withdrawal or native refund flow',f=>{f.logs.push({...f.logs[1],logIndex:'0x11'});});
 reject('rejects a different pool payment',f=>{f.logs[2].topics[2]='0x'+word(t);});
 reject('rejects a wallet-funded WBNB transfer',f=>{f.logs[2].topics[1]='0x'+word(w);});
 reject('rejects a delivery differing from the outer swap',f=>{f.logs[3].data='0x'+word(19999n);});
 reject('rejects an additional pair input or output flow',f=>{f.logs[5].data=replaceWord(f.logs[5].data,3,1n);});
 reject('rejects a different actual wallet recipient',f=>{f.logs[6].topics[1]='0x'+word(t);});
 reject('rejects an ERC20 outer input asset',f=>{f.logs[6].data=replaceWord(f.logs[6].data,0,bnb);});
 reject('rejects a different outer input amount',f=>{f.logs[6].data=replaceWord(f.logs[6].data,2,10n**18n-1n);});
 reject('rejects an unsupported embedded expense instead of guessing it',f=>{f.logs[6].data=replaceWord(f.logs[6].data,4,10n**16n+1n);});
 reject('rejects another outer route id',f=>{f.logs[6].data=replaceWord(f.logs[6].data,5,5n);});
 reject('rejects an orphan original log',f=>{f.logs[3].blockHash='0x'+'c'.repeat(64);});
 reject('rejects another original transaction',f=>{f.logs[3].transactionHash='0x'+'c'.repeat(64);});
 reject('rejects removed or reordered logs',f=>{f.logs[3].removed=true;});
 it('does not admit a different token through an otherwise trusted wrapper',()=>{const f=wrapperFixture();expect(freshNativeBuyCost(f.transaction,w,t,20000n,f.logs)).toBeNull();});
});
