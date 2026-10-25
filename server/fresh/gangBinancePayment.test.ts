import{describe,it,expect}from'vitest';import{freshGangBinanceNativeBuyCost}from'./gangBinancePayment.js';import{freshNativeBuyCost}from'./routerPayment.js';import type{FreshTransaction,FreshLog}from'./capture.js';
const gang='0x0c6302401aa5325c2e36f170f52c00b1d220b405',pair='0x0bd5ded695d61c2db15c703c345d57e039fd0b6d',bnb='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const router='0xb300000b72deaeb607a12d5f54773d1c19c7028d',executor='0x3d90f66b534dd8482b181e24655a9e8265316be9',poolExecutor='0x8086c0d903ed072cd7362b79b314347c57a3c77d';
const fee='0x94a11745a8d33388ee635b55f43944f1202c13d4',wallet='0x'+'1'.repeat(40),native='0x'+'e'.repeat(40),zero='0x'+'0'.repeat(40);
const word=(value:string|bigint)=>typeof value==='bigint'?value.toString(16).padStart(64,'0'):value.slice(2).padStart(64,'0');
function fixture(){const gross=2n*10n**18n,net=199n*10n**16n,raw=10n**24n,minimum=10n**23n;
 const route=[1n,0n,0n,0n,2n*minimum,0n,native,gang,net,minimum,1792900000n,448n,512n,1088n,1n,net,1n,32n,1n,32n,160n,224n,288n,352n,bnb,1n,poolExecutor,1n,pair,1n,0n,1n,32n,0n,0n,0n,0n].map(word);
 route[30]='800000000000000000002710'+pair.slice(2);const nested='47ee97ff'+route.join('');
 const input='0x810c705b'+[fee,executor,0n,gross,gang,minimum,224n,1188n].map(word).join('')+nested+'0'.repeat(56),outerFlag='b000000000000000000000320000000000000000000000000000000000000000';
 const tx={from:wallet,to:router,hash:'0x'+'a'.repeat(64),blockHash:'0x'+'b'.repeat(64),blockNumber:'0x3ea',transactionIndex:'0x0',value:'0x'+gross.toString(16),chainId:'0x38',type:'0x0',input:input.slice(0,10+2*64)+outerFlag+input.slice(10+3*64)}as FreshTransaction;
 const log=(address:string,signature:string,addresses:string[],values:(string|bigint)[],index:number)=>({address,topics:[signature,...addresses.map(value=>'0x'+word(value))],data:'0x'+values.map(word).join(''),logIndex:'0x'+index.toString(16),transactionHash:tx.hash,blockHash:tx.blockHash,blockNumber:tx.blockNumber,transactionIndex:tx.transactionIndex})as FreshLog;
 const logs=[log(router,'0xf228de527fc1b9843baac03b9a04565473a263375950e63435d4138464386f46',[zero],[fee,gross-net],0),
 log(bnb,'0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c',[executor],[net],1),
 log(bnb,'0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',[executor,pair],[net],2),
 log(gang,'0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',[pair,router],[raw],3),
 log(pair,'0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1',[],[raw*100n,net*100n],4),
 log(pair,'0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',[poolExecutor,router],[0n,net,raw,0n],5),
 log(executor,'0xe5b9f85c5caca875a8b78e5b2d88de86d7793cbff3d81ea4ecbec4c2b9ad7beb',[],[1n,native,gang,wallet,net,raw],6),
 log(gang,'0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',[router,wallet],[raw],7)];return{tx,logs,raw,gross};}
const replace=(data:string,index:number,value:string|bigint)=>data.slice(0,2+index*64)+word(value)+data.slice(2+(index+1)*64);
describe('pinned GANG Binance native exact-input receipt',()=>{
 it('proves gross signed native fee plus actual net deposit and final token delivery',()=>{const f=fixture();expect(freshGangBinanceNativeBuyCost(f.tx,wallet,gang,f.raw,f.logs)).toBe(f.gross);expect(freshNativeBuyCost(f.tx,wallet,gang,f.raw,f.logs)).toBe(f.gross);});
 const reject=(name:string,mutate:(f:ReturnType<typeof fixture>)=>void)=>it(name,()=>{const f=fixture();mutate(f);expect(freshGangBinanceNativeBuyCost(f.tx,wallet,gang,f.raw,f.logs)).toBeNull();});
 const outer=(f:ReturnType<typeof fixture>,index:number,value:string|bigint)=>{f.tx.input='0x810c705b'+replace('0x'+(f.tx.input as string).slice(10),index,value).slice(2);};
 const inner=(f:ReturnType<typeof fixture>,index:number,value:string|bigint)=>{const input=f.tx.input as string,start=10+8*64;f.tx.input=input.slice(0,start+8)+replace('0x'+input.slice(start+8,start+1188*2),index,value).slice(2)+input.slice(start+1188*2);};
 reject('rejects signed native amount different from actual expense plus deposit',f=>{f.tx.value='0x1';});
 reject('rejects ERC20 funding with no native value',f=>{f.tx.value='0x0';});
 reject('rejects another caller',f=>{f.tx.from=fee;});
 reject('rejects another chain or delegation',f=>{f.tx.authorizationList=[];});
 reject('rejects a different signed executor',f=>outer(f,1,fee));
 reject('rejects changed signed fee flags',f=>outer(f,2,0n));
 reject('rejects malformed dynamic boundaries',f=>outer(f,6,256n));
 reject('rejects a different nested route or extra path',f=>inner(f,18,2n));
 reject('rejects a different nested market',f=>inner(f,28,fee));
 reject('rejects hidden extra nested calls',f=>inner(f,36,1n));
 reject('rejects an ERC20 nested input',f=>inner(f,6,bnb));
 reject('rejects mismatched nested actual input',f=>inner(f,8,1n));
 reject('rejects changed final input padding',f=>{f.tx.input=(f.tx.input as string).slice(0,-1)+'1';});
 reject('rejects missing or duplicated native fee evidence',f=>{f.logs.shift();});
 reject('rejects a fee sent to another recipient',f=>{f.logs[0].data=replace(f.logs[0].data,0,wallet);});
 reject('rejects a fee amount mismatch',f=>{f.logs[0].data=replace(f.logs[0].data,1,1n);});
 reject('rejects a withdrawal/refund instead of native input',f=>{f.logs[1].topics[0]='0x'+'f'.repeat(64);});
 reject('rejects another depositor',f=>{f.logs[1].topics[1]='0x'+word(wallet);});
 reject('rejects wallet-funded WBNB',f=>{f.logs[2].topics[1]='0x'+word(wallet);});
 reject('rejects a missing final wallet delivery',f=>{f.logs.pop();});
 reject('rejects another final recipient',f=>{f.logs[7].topics[2]='0x'+word(fee);});
 reject('rejects changed target delivery',f=>{f.logs[7].data=word(1n);});
 reject('rejects wrong output asset',f=>{f.logs[6].data=replace(f.logs[6].data,2,bnb);});
 reject('rejects wrong output recipient',f=>{f.logs[6].data=replace(f.logs[6].data,3,router);});
 reject('rejects changed output receipt input amount',f=>{f.logs[6].data=replace(f.logs[6].data,4,1n);});
 reject('rejects an output from another route id',f=>{f.logs[6].data=replace(f.logs[6].data,0,2n);});
 reject('rejects an orphan original receipt log',f=>{f.logs[7].blockHash='0x'+'c'.repeat(64);});
 reject('rejects removed logs',f=>{f.logs[7].removed=true;});
 reject('rejects an extra output/refund flow',f=>{f.logs.push({...f.logs[7],logIndex:'0x8'});});
 it('never approves another token or a different actual received quantity',()=>{const f=fixture();expect(freshGangBinanceNativeBuyCost(f.tx,wallet,bnb,f.raw,f.logs)).toBeNull();expect(freshGangBinanceNativeBuyCost(f.tx,wallet,gang,f.raw+1n,f.logs)).toBeNull();});
});
