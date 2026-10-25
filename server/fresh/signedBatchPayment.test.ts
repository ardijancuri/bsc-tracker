import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {AbiCoder,Signature,Transaction,Wallet,hashAuthorization} from 'ethers';
import {describe,it,expect} from 'vitest';
import {FLAP_PORTAL} from '../launchpad.js';
import {flapMarketAbi} from '../nodeMarketProtocols.js';
import {transferTopic} from '../swap.js';
import {beforeExecutionTopic} from '../smartAccountTrades.js';
import type {FreshCapturedReceipt} from './capture.js';
import type {FreshPriceBlock} from './pricing.js';
import {FRESH_SIGNED_BATCH_DELEGATE,freshSignedBatchNativeBuyPayment} from './signedBatchPayment.js';

interface Fixture{entry:FreshCapturedReceipt;block:FreshPriceBlock;token:string;targetRaw:string}
const fixtures:Fixture[]=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/signed-batch-native-buy.json.gz',import.meta.url))).toString());
const fixture=(index=5)=>structuredClone(fixtures[index]);
const proof=(f:Fixture)=>freshSignedBatchNativeBuyPayment(f.entry,f.block,f.token,f.entry.transaction.from,BigInt(f.targetRaw));
const at=(f:Fixture,path:number[])=>path.reduce((call,index)=>call.calls![index],f.entry.trace!);
const word=(v:string|bigint)=>typeof v==='bigint'?v.toString(16).padStart(64,'0'):v.slice(2).padStart(64,'0');
const other='0x'+'1'.repeat(40),abi=AbiCoder.defaultAbiCoder(),batchType='tuple(address,uint256,bytes,bytes)[]';
const txWallet=new Wallet('0x'+'a'.repeat(64));

/** A test-only signer rebinds the captured structure, permitting coherent
 * calldata mutations which reach inner guards rather than only bad-hash checks. */
function resign(f:Fixture){
  const t=f.entry.transaction,auth=(t.authorizationList as any[])[0];
  const a=Signature.from(txWallet.signingKey.sign(hashAuthorization({address:auth.address,chainId:BigInt(auth.chainId),nonce:BigInt(auth.nonce)})));
  Object.assign(auth,{r:a.r,s:a.s,yParity:'0x'+a.yParity});
  const unsigned=Transaction.from({type:4,chainId:BigInt(String(t.chainId)),to:t.to,nonce:Number(BigInt(String(t.nonce))),gasLimit:BigInt(String(t.gas)),
    maxFeePerGas:BigInt(String(t.maxFeePerGas)),maxPriorityFeePerGas:BigInt(String(t.maxPriorityFeePerGas)),value:BigInt(t.value),data:String(t.input),accessList:[],
    authorizationList:[{address:auth.address,chainId:BigInt(auth.chainId),nonce:BigInt(auth.nonce),signature:a}]});
  unsigned.signature=txWallet.signingKey.sign(unsigned.unsignedHash);
  Object.assign(t,{hash:unsigned.hash,from:txWallet.address.toLowerCase(),r:unsigned.signature.r,s:unsigned.signature.s,v:'0x'+unsigned.signature.yParity,yParity:'0x'+unsigned.signature.yParity});
  f.entry.receipt.transactionHash=t.hash;for(const l of f.entry.receipt.logs)l.transactionHash=t.hash;
  f.entry.trace!.input=String(t.input);return f;
}
function signedFixture(){
  const f=fixture(),wallet=f.entry.transaction.from;
  return resign(JSON.parse(JSON.stringify(f).replaceAll(wallet.slice(2),txWallet.address.slice(2).toLowerCase())));
}
function changeBatch(f:Fixture,change:(calls:any[])=>void){
  const data=abi.decode([batchType],'0x'+String(f.entry.transaction.input).slice(10))[0].map((call:any)=>[...call]);
  change(data);f.entry.transaction.input='0xb0da329a'+abi.encode([batchType],[data]).slice(2);return resign(f);
}

describe('signed self-EIP7702 native purchase and explicit trade expenses',()=>{
  it.each(fixtures.map((f,i)=>[f.entry.transaction.hash,i] as const))('authenticates complete real settlement %s',(_hash,index)=>{
    const f=fixture(index),before=JSON.stringify(f),p=proof(f);
    expect(p).not.toBeNull();expect(p?.expensePolicy).toBe('signed_batch_trade_expenses_v1');
    expect(p?.quoteAcquiredRaw).toBe((BigInt(p!.quoteSpentRaw)+BigInt(p!.quoteRemainingRaw)).toString());
    expect(p?.totalWalletNativeWei).toBe((BigInt(p!.acquisitionNativeWei)+BigInt(p!.extraNativeWei)).toString());
    expect(p?.expensePayments).toEqual([{path:[3],recipient:f.entry.trace!.calls![3].to,nativeWei:p?.extraNativeWei}]);
    expect(p?.authDelegate).toBe(FRESH_SIGNED_BATCH_DELEGATE);expect(JSON.stringify(f)).toBe(before);
    expect(p?.gasFeeWei).toBe((BigInt(f.entry.receipt.gasUsed)*BigInt(f.entry.receipt.effectiveGasPrice!)).toString());
  });
  it('keeps raw units, real remainder, gas and separate signed expense distinct',()=>{
    expect(proof(fixture())).toMatchObject({quoteAddress:'0x9b8e987e6fec8cf1380c4dca7071e2c7853aeea1',quoteSourcePool:'0x8768c8969e177575e37435b8295afa2dfb231c86',
      acquisitionNativeWei:'1000000000000000000',extraNativeWei:'1000000000000000',totalWalletNativeWei:'1001000000000000000',quoteAcquiredRaw:'22621747095743770800',
      quoteSpentRaw:'22395533325068850741',quoteRemainingRaw:'226213770674920059',calls:{acquisition:[0],quoteAcquisition:[0,0,3,0],quotePayment:[2,0,0,1,19,0],tokenDelivery:[2,0,0,1,19,8]}});
    expect(proof(fixture(1))?.acquisitionNativeWei).toBe('1500000000000000000');expect(proof(fixture(0))?.extraNativeWei).toBe('750000000000000');
  });
  it('authenticates the actual outer transaction and authorization signatures',()=>{
    const patches=[{hash:'0x'+'1'.repeat(64)},{from:other},{to:other},{value:'0x0'},{nonce:'0x1'},{chainId:'0x1'},{type:'0x2'},
      {r:'0x1'},{s:'0x1'},{yParity:'0x1'},{v:'0x1'},{gas:'0x1'},{maxFeePerGas:'0x1'},{accessList:[{address:other,storageKeys:[]}]}];
    for(const patch of patches){const f=fixture();Object.assign(f.entry.transaction,patch);expect(proof(f)).toBeNull();}
    for(const patch of[{address:other},{chainId:'0x1'},{nonce:'0x0'},{yParity:'0x2'},{r:'0x1'},{s:'0x1'}]){
      const f=fixture();Object.assign((f.entry.transaction.authorizationList as any[])[0],patch);expect(proof(f)).toBeNull();
    }
    for(const list of[undefined,[],[...(fixture().entry.transaction.authorizationList as any[]),...(fixture().entry.transaction.authorizationList as any[])]]){
      const f=fixture();f.entry.transaction.authorizationList=list;expect(proof(f)).toBeNull();
    }
  });
  it('rejects absent original value, signatures, gas, calldata and trace',()=>{
    for(const key of['value','r','s','gas','nonce','chainId','input','yParity','v']){const f=fixture();delete f.entry.transaction[key];expect(proof(f)).toBeNull();}
    const f=fixture();delete f.entry.trace;expect(proof(f)).toBeNull();
  });
  it('requires canonical receipt, log positions and exact target delivery',()=>{
    for(const patch of[{status:'0x0'},{gasUsed:'0x0'},{effectiveGasPrice:'0x0'},{transactionIndex:'0xffff'},{transactionHash:'0x'+'f'.repeat(64)}]){
      const f=fixture();Object.assign(f.entry.receipt,patch);expect(proof(f)).toBeNull();
    }
    const f=fixture();f.targetRaw=(BigInt(f.targetRaw)+1n).toString();expect(proof(f)).toBeNull();
    const g=fixture();g.block.hash='0x'+'d'.repeat(64);expect(proof(g)).toBeNull();
    const h=fixture();h.entry.wallets=[];expect(proof(h)).toBeNull();
    for(const patch of[{removed:true},{blockHash:'0x'+'f'.repeat(64)},{logIndex:'0x0'},{data:'0x1'}]){
      const q=fixture();Object.assign(q.entry.receipt.logs.at(-1)!,patch);expect(proof(q)).toBeNull();
    }
  });
  it('does not count root self-value or duplicated inherited delegate values',()=>{
    const f=fixture(),p=proof(f)!;
    expect(f.entry.trace!.value).toBe(f.entry.transaction.value);expect(p.totalWalletNativeWei).toBe('1001000000000000000');
    expect(p.acquisitionNativeWei).toBe('1000000000000000000');
    const g=fixture();at(g,[0,0]).value='0x1';expect(proof(g)).toBeNull();
  });
  it('rejects unsupported frames, errors, refunds, nested wallet spending and wrong call context',()=>{
    const variants:((f:Fixture)=>void)[]=[f=>at(f,[0,0]).type='CALLCODE',f=>at(f,[0,0]).error='execution reverted',f=>at(f,[2,0]).type='SELFDESTRUCT',
      f=>at(f,[0,0]).from=other,f=>at(f,[0]).calls!.push({type:'CALL',from:at(f,[0]).to!,to:f.entry.transaction.from,value:'0x1',input:'0x'}),
      f=>at(f,[0]).calls!.push({type:'CALL',from:f.entry.transaction.from,to:other,value:'0x1',input:'0x'}),f=>at(f,[3]).calls=[{type:'CALL',from:at(f,[3]).to!,to:other,value:'0x0',input:'0x'}],
      f=>at(f,[0]).input='0x',f=>f.entry.trace!.input='0x',f=>at(f,[3]).value='0x1'];
    for(const change of variants){const f=fixture();change(f);expect(proof(f)).toBeNull();}
  });
  it('rejects unmatched wallet assets, extra transfers and misleading trace delivery',()=>{
    const p=proof(fixture())!,variants:((f:Fixture)=>void)[]=[f=>at(f,p.calls.quoteAcquisition).output='0x',f=>at(f,p.calls.quotePayment).output='0x',
      f=>at(f,p.calls.tokenDelivery).output='0x',f=>at(f,p.calls.quotePayment).input=at(f,p.calls.quotePayment).input!.slice(0,-2)+'00',
      f=>at(f,[0]).calls!.push(structuredClone(at(f,p.calls.quoteAcquisition))),f=>{const l=f.entry.receipt.logs.find(l=>l.address===p.tokenAddress&&l.topics[0]===transferTopic&&l.topics[2].endsWith(p.walletAddress.slice(2)))!;l.data='0x'+word(1n);},
      f=>{const l=structuredClone(f.entry.receipt.logs.find(l=>l.address===p.tokenAddress&&l.topics[0]===transferTopic&&l.topics[2].endsWith(p.walletAddress.slice(2)))!);l.address=other;l.logIndex='0xffff';f.entry.receipt.logs.push(l);},
      f=>f.entry.receipt.logs.push({...f.entry.receipt.logs[0],logIndex:'0xffff',topics:[beforeExecutionTopic],data:'0x'})];
    for(const change of variants){const f=fixture();change(f);expect(proof(f)).toBeNull();}
  });
  it('requires the genuine single acquisition swap and matching single Flap buy',()=>{
    const p=proof(fixture())!;
    for(const which of['swap','buy']){const f=fixture(),log=f.entry.receipt.logs.find(l=>which==='swap'?l.address===p.quoteSourcePool&&Number(BigInt(l.logIndex))===p.quoteSourcePoolLogIndex:l.address===FLAP_PORTAL&&l.topics[0]===flapMarketAbi.getEvent('TokenBought')!.topicHash)!;
      log.data='0x'+word(0n)+log.data.slice(66);expect(proof(f)).toBeNull();}
    const f=fixture(),log=f.entry.receipt.logs.find(l=>l.address===FLAP_PORTAL&&l.topics[0]===flapMarketAbi.getEvent('TokenBought')!.topicHash)!;
    f.entry.receipt.logs.push({...log,logIndex:'0xffff'});expect(proof(f)).toBeNull();
  });
  it('checks canonical signed batch ABI beyond signature verification',()=>{
    expect(proof(signedFixture())).not.toBeNull();
    for(const change of[(c:any[])=>c[0][3]='0x01',(c:any[])=>c.push([...c[3]]),(c:any[])=>c[1][2]='0x',(c:any[])=>c[3][2]='0x1234']){
      const f=changeBatch(signedFixture(),change);expect(proof(f)).toBeNull();
    }
    const f=signedFixture();f.entry.transaction.input=String(f.entry.transaction.input)+'00';resign(f);expect(proof(f)).toBeNull();
  });
  it('rejects a coherently signed unmatched batch action or undeclared outer payment',()=>{
    const f=signedFixture();f.entry.transaction.value='0x1';resign(f);f.entry.trace!.value='0x1';expect(proof(f)).toBeNull();
    const g=changeBatch(signedFixture(),c=>c[3][0]=other);at(g,[3]).to=other;
    expect(proof(g)?.expensePayments).toEqual([{path:[3],recipient:other,nativeWei:'1000000000000000'}]);
    // A plain, actual, separately authorized payment is the approved policy;
    // adding contract execution or an unsigned callback is outside this proof.
    at(g,[3]).calls=[{type:'STATICCALL',from:other,to:FLAP_PORTAL,input:'0x'}];expect(proof(g)).toBeNull();
  });
  it('uses the actual signed expense rather than a guessed fixed fee or percentage',()=>{
    const f=changeBatch(signedFixture(),calls=>calls[3][1]=3_000_000_000_000_000n);
    f.entry.transaction.value='0x'+1_003_000_000_000_000_000n.toString(16);resign(f);f.entry.trace!.value=f.entry.transaction.value;
    at(f,[3]).value='0x'+3_000_000_000_000_000n.toString(16);
    expect(proof(f)).toMatchObject({acquisitionNativeWei:'1000000000000000000',extraNativeWei:'3000000000000000',totalWalletNativeWei:'1003000000000000000',
      expensePayments:[{path:[3],recipient:'0x72203178f2eb424c01367c04a7f64ee545ce8e8d',nativeWei:'3000000000000000'}]});
  });
});
