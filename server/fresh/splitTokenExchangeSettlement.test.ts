import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {expect,it} from 'vitest';
import type {FreshCapturedReceipt} from './capture.js';
import {decodeFreshExecutions} from './decode.js';
import {certifyFreshCompleteCallTrace} from './passiveIncoming.js';
import {freshTokenExchangeSettlement} from './tokenExchangeSettlement.js';

const cases=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/split-token-exchange-gm.json.gz',import.meta.url))).toString()) as
  {entry:FreshCapturedReceipt;timestamp:string}[];
const prove=(entry:FreshCapturedReceipt,timestamp:string)=>freshTokenExchangeSettlement(entry,decodeFreshExecutions(entry)[0],{
  number:entry.receipt.blockNumber,hash:entry.receipt.blockHash,timestamp:'0x'+(Date.parse(timestamp)/1000).toString(16),
},entry.trace!);

it.each([0,1])('authenticates the actual split USDT exchange %s without using current market prices',index=>{
  const {entry,timestamp}=cases[index];
  const proof=prove(entry,timestamp);
  expect(proof).toMatchObject({
    kind:'ordinary_token_exchange_via_usdt',buyToken:'0x13920fe6467e9e3c852b8d365a036c995f0f7777',
    quoteRaw:[2067432821524030430876n,1987986459264114323966n][index],
  });
});

it('rejects a split route with a missing trace certificate or different BNCB funding',()=>{
  const {entry:original,timestamp}=cases[0];
  const entry=structuredClone(original);
  delete entry.completeTraceProof;
  expect(prove(entry,timestamp)).toBeNull();

  const funding=entry.receipt.logs.find(log=>log.address==='0x4902c5ebc598265ed2212b559b042de8a5eeec3f'&&
    log.topics[2]?.endsWith('fd55be774ea18067bd06a6aed49fb1cc4ad966e9'))!;
  funding.data='0x'+(BigInt(funding.data)+1n).toString(16).padStart(64,'0');
  entry.completeTraceProof=certifyFreshCompleteCallTrace(entry,entry.trace!,{method:'debug_traceTransaction',
    params:[entry.transaction.hash,{tracer:'callTracer',tracerConfig:{onlyTopCall:false,withLog:false}}]},'private_ipc');
  expect(prove(entry,timestamp)).toBeNull();
});
