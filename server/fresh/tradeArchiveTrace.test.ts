import {describe, expect, it, vi} from 'vitest';
import type {Pool} from 'pg';
import type {Rpc} from '../rpc.js';
import type {FreshCapturedReceipt} from './capture.js';
import {validFreshCompleteCallTrace} from './passiveIncoming.js';
import {createFreshTradeArchiveTrace} from './tradeArchiveTrace.js';

const address=(digit:string)=>'0x'+digit.repeat(40);
const hash=(digit:string)=>'0x'+digit.repeat(64);
const txHash=hash('1'),blockHash=hash('2'),wallet=address('a'),router=address('b');
const transaction={hash:txHash,blockHash,blockNumber:'0x100',transactionIndex:'0x0',
  from:wallet,to:router,type:'0x0',value:'0x10',input:'0x12345678'};
const receipt={transactionHash:txHash,blockHash,blockNumber:'0x100',transactionIndex:'0x0',
  status:'0x1',gasUsed:'0x5208',effectiveGasPrice:'0x1',logs:[]};
const block={number:256,hash:blockHash,timestamp:'2026-11-14T15:04:48.000Z'};
const header={number:transaction.blockNumber,hash:blockHash,parentHash:hash('3'),timestamp:'0x6af87ad0',transactions:[txHash]};
const raw={type:'CALL',from:wallet,to:router,value:'0x10',input:transaction.input,output:'0x',gas:'0xffff',gasUsed:'0x5208'};

function setup(publicTrade=true){
  const entry:FreshCapturedReceipt={transaction:{...transaction},receipt:{...receipt},wallets:[wallet],observedAt:block.timestamp};
  const query=vi.fn(async()=>({rowCount:Number(publicTrade)}));
  const node=vi.fn(async()=>header),archive=vi.fn(async()=>raw);
  const repair=createFreshTradeArchiveTrace({query} as unknown as Pick<Pool,'query'>,node as unknown as Rpc,archive as unknown as Rpc);
  return {entry,repair,node,archive};
}

describe('archive recovery of public trade amounts',()=>{
  it('certifies a matching tree once and respects the cooldown',async()=>{
    const {entry,repair,node,archive}=setup();
    const proof=await repair(entry,block);
    expect(proof&&validFreshCompleteCallTrace({...entry,...proof},proof.trace!)).toBe(true);
    expect(node).toHaveBeenCalledTimes(2);
    expect(archive).toHaveBeenCalledExactlyOnceWith('debug_traceTransaction',[txHash,{tracer:'callTracer',tracerConfig:{onlyTopCall:false,withLog:false}}]);
    expect(await repair(entry,block)).toBeNull();
    expect(archive).toHaveBeenCalledTimes(1);
  });

  it('never requests a trace for an ineligible wallet or a noncanonical transaction',async()=>{
    const privateTrade=setup(false);
    expect(await privateTrade.repair(privateTrade.entry,block)).toBeNull();
    expect(privateTrade.archive).not.toHaveBeenCalled();
    const noncanonical=setup();
    noncanonical.node.mockResolvedValue({...header,transactions:[hash('4')]});
    expect(await noncanonical.repair(noncanonical.entry,block)).toBeNull();
    expect(noncanonical.archive).not.toHaveBeenCalled();
  });

  it('discards a valid-looking trace when the canonical hash changes during retrieval',async()=>{
    const {entry,repair,node}=setup();
    node.mockResolvedValueOnce(header).mockResolvedValueOnce({...header,hash:hash('4')});
    expect(await repair(entry,block)).toBeNull();
  });
});
