import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {Interface} from 'ethers';
import {describe,it,expect} from 'vitest';
import {decodeFreshExecutions,normalizeFreshReceipt} from './decode.js';
import {freshSmartAccountSellSettlement,FRESH_RELAY_DEPOSITORY,FRESH_NATIVE_BRIDGE} from './smartAccountSettlement.js';
import type {FreshCapturedReceipt} from './capture.js';
import type {FreshCallTrace} from './trace.js';
import {WBNB} from '../launchpad.js';

// Complete original public BSC receipt/call-tree vectors. No app credentials,
// current metadata, financial snapshots or live RPC are used by these tests.
const fixtures=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/smartAccountSettlements.json.gz',import.meta.url))).toString()) as FreshCapturedReceipt[];
const token='0xb0e974ee58899dd77eb13c2c0a0adefeb30f7777',wallet='0x5865363bb04450ab313dcd2e71a189efb3c31e41';
const quantities=[-732684317200455658923766n,-366580452200526280416765n];
const expected=[222725832579561399n,226133956113682511421n];
const fixture=(i:number)=>structuredClone(fixtures[i]);
const proof=(e:FreshCapturedReceipt,i:number)=>freshSmartAccountSellSettlement(e,decodeFreshExecutions(e)[0],token,quantities[i],e.trace!);
function nodes(c:FreshCallTrace):FreshCallTrace[]{return[c,...(c.calls??[]).flatMap(nodes)];}
const aa=new Interface(['function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)']);
function changeOperation(e:FreshCapturedReceipt,update:(v:any[])=>void){const p=aa.parseTransaction({data:e.transaction.input as string})!;const args=p.args.toArray(true) as any[];update(args);e.transaction.input=aa.encodeFunctionData(p.fragment,args).toLowerCase();e.trace!.input=e.transaction.input as string;}

describe('signed smart-account bridge sale settlement',()=>{
  it.each([0,1])('proves the original BIBI sale %s without assigning bundler gas or intermediary output',i=>{
    const e=fixture(i),p=proof(e,i)!;expect(p.quoteRaw).toBe(expected[i]);expect(p.recipient).toBe(i===0?FRESH_NATIVE_BRIDGE:FRESH_RELAY_DEPOSITORY);
    expect(p.quoteAddress).toBe(i===0?WBNB:'0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d');expect(decodeFreshExecutions(e)[0].feeWei).toBe(0n);
  });
  it.each([0,1])('preserves unknown USD while returning independently proven quote units %s',async i=>{
    const e=fixture(i),block={number:e.transaction.blockNumber,hash:e.transaction.blockHash,timestamp:'0x'+Math.floor(Date.parse(i===0?'2026-10-23T15:07:05Z':'2026-10-24T00:17:30Z')/1000).toString(16)};
    const result=await normalizeFreshReceipt(e,block,{metadata:async address=>({address,name:'BIBI',symbol:'BIBI',decimals:18,supplyRaw:null,block:{number:Number(BigInt(block.number)),hash:block.hash,timestamp:new Date(Number(BigInt(block.timestamp))*1000).toISOString()}}),eligible:async t=>t.address===token,priceUsd:async()=>null});
    expect(result.events).toHaveLength(1);expect(result.events[0].amountUsd).toBeNull();expect(result.events[0].feeUsd).toBe('0');expect(result.events[0].quoteAmount).toBe(i===0?'0.222725832579561399':'226.133956113682511421');expect(result.reasons).toEqual(['trade_value_unavailable']);
  });
  it.each([0,1])('uses the historical quote feed once without reclassifying acquisitions %s',async i=>{
    const e=fixture(i),prices=new Map<string,number>();
    const result=await normalizeFreshReceipt(e,{number:e.transaction.blockNumber,hash:e.transaction.blockHash,timestamp:'0x6adbf91a'},{metadata:async address=>({address,name:'BIBI',symbol:'BIBI',decimals:18,supplyRaw:null,block:{number:Number(BigInt(e.transaction.blockNumber)),hash:e.transaction.blockHash,timestamp:'2026-10-24T00:17:30Z'}}),eligible:async t=>t.address===token,priceUsd:async address=>{prices.set(address,(prices.get(address)??0)+1);return address===WBNB?'747.03488712':'0.99983757';}});
    expect(result.reasons).toEqual([]);expect(result.events[0].kind).toBe('sell');expect(result.events[0].amountUsd).not.toBeNull();expect([...prices.values()]).toEqual(i===0?[1]:[1,1]);
    expect(result.tradeBnbPrices).toEqual(i===0?undefined:{[result.events[0].id]:'747.03488712'});
  });
  it.each([0,1])('rejects a different wallet, direction, quantity, trace root and receipt identity %s',i=>{
    for(const alter of [
      (e:FreshCapturedReceipt)=>{e.wallets=[];},
      (e:FreshCapturedReceipt)=>{e.trace!.input='0x';},
      (e:FreshCapturedReceipt)=>{e.trace!.error='revert';},
      (e:FreshCapturedReceipt)=>{e.receipt.logs[2].transactionHash='0x'+'1'.repeat(64);},
      (e:FreshCapturedReceipt)=>{e.receipt.logs[2].logIndex=e.receipt.logs[1].logIndex;}
    ]){const e=fixture(i);alter(e);expect(proof(e,i)).toBeNull();}
    const e=fixture(i),ex=decodeFreshExecutions(e)[0];expect(freshSmartAccountSellSettlement(e,ex,token,-quantities[i],e.trace!)).toBeNull();expect(freshSmartAccountSellSettlement(e,ex,token,quantities[i]-1n,e.trace!)).toBeNull();
    expect(freshSmartAccountSellSettlement(e,{...ex,wallet:'0x'+'1'.repeat(40)},token,quantities[i],e.trace!)).toBeNull();
  });
  it.each([0,1])('rejects repeated operations and paymasters rather than allocating another account payment %s',i=>{
    let e=fixture(i);changeOperation(e,a=>{a[0].push(a[0][0]);});expect(proof(e,i)).toBeNull();
    e=fixture(i);changeOperation(e,a=>{a[0][0][7]='0x'+'1'.repeat(40);});expect(proof(e,i)).toBeNull();
  });
  it.each([0,1])('rejects a reverted or unsigned inner operation %s',i=>{
    let e=fixture(i);nodes(e.trace!).find(c=>c.from===wallet&&c.input?.startsWith(i===0?'0xea239ef1':'0xf9e4bab4'))!.error='execution reverted';expect(proof(e,i)).toBeNull();
    e=fixture(i);nodes(e.trace!).find(c=>c.from===wallet&&c.input?.startsWith(i===0?'0xea239ef1':'0xf9e4bab4'))!.input='0x12345678';expect(proof(e,i)).toBeNull();
  });
  it('rejects forged Relay credit identity, amount, duplicate deposits and absent token payment',()=>{
    for(const change of [
      (e:FreshCapturedReceipt)=>{const l=e.receipt.logs.find(l=>l.address===FRESH_RELAY_DEPOSITORY)!;l.data=l.data.replace(wallet.slice(2),'1'.repeat(40));},
      (e:FreshCapturedReceipt)=>{const l=e.receipt.logs.find(l=>l.address===FRESH_RELAY_DEPOSITORY)!;l.data=l.data.slice(0,130)+'0'.repeat(63)+'1'+l.data.slice(194);},
      (e:FreshCapturedReceipt)=>{e.receipt.logs=e.receipt.logs.filter(l=>l.logIndex!=='0x200');},
      (e:FreshCapturedReceipt)=>{nodes(e.trace!).find(c=>c.from===FRESH_RELAY_DEPOSITORY&&c.input?.startsWith('0x23b872dd'))!.error='reverted';},
      (e:FreshCapturedReceipt)=>{const c=nodes(e.trace!).find(c=>c.to===FRESH_RELAY_DEPOSITORY&&c.input?.startsWith('0x5a1ee3ac'))!;c.calls!.push(structuredClone(c.calls![0]));c.calls!.push(structuredClone(c.calls![1]));}
    ]){const e=fixture(1);change(e);expect(proof(e,1)).toBeNull();}
  });
  it('requires native withdrawal/payment conservation, matching signed destination and a real bridge payment',()=>{
    for(const change of [
      (e:FreshCapturedReceipt)=>{nodes(e.trace!).find(c=>c.type==='CALL'&&c.to===FRESH_NATIVE_BRIDGE)!.value='0x1';},
      (e:FreshCapturedReceipt)=>{const c=nodes(e.trace!).find(c=>c.type==='CALL'&&c.to===FRESH_NATIVE_BRIDGE)!;c.input=c.input!.replace('16fa2412','26fa2412');},
      (e:FreshCapturedReceipt)=>{const l=e.receipt.logs.find(l=>l.address===FRESH_NATIVE_BRIDGE&&l.topics.length===3)!;l.topics[2]='0x'+'0'.repeat(24)+'1'.repeat(40);},
      (e:FreshCapturedReceipt)=>{nodes(e.trace!).find(c=>c.from===WBNB&&c.type==='CALL')!.value='0x1';}
    ]){const e=fixture(0);change(e);expect(proof(e,0)).toBeNull();}
  });
});
