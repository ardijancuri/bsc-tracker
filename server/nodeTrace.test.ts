import { describe, expect, it } from 'vitest';
import { nodeExecutionNeedsTrace,nodeTraceMatchesTransaction,nodeTraceNativeDelta, traceNodeTransaction, validateNodeTrace } from './nodeTrace.js';
const wallet = `0x${'a'.repeat(40)}`, router = `0x${'b'.repeat(40)}`;
describe('bounded private node tracing', () => {
  it('accounts actual successful native payouts and excludes reverted/delegate calls', () => {
    const trace = validateNodeTrace({ type: 'CALL', from: wallet, to: router, value: '0xa', calls: [
      { type: 'CALL', from: router, to: wallet, value: '0x3' }, { type: 'CALL', from: router, to: wallet, value: '0xff', error: 'reverted' },
      { type: 'DELEGATECALL', from: wallet, to: router, value: '0xff' }] });
    expect(nodeTraceNativeDelta(trace, wallet)).toBe(-7n);
  });
  it('bounds node count, recursion and malformed quantities', () => {
    expect(() => validateNodeTrace({ type: 'CALL', from: wallet, value: 'nan' })).toThrow('bounds');
    expect(() => validateNodeTrace({ type: 'CALL', from: wallet, calls: [{ type: 'CALL', from: wallet }] }, 1)).toThrow('bounds');
  });
  it('never accepts a debug HTTP endpoint or arbitrary transaction identity', async () => {
    await expect(traceNodeTransaction('invalid')).rejects.toThrow('hash_invalid');
    await expect(traceNodeTransaction(`0x${'1'.repeat(64)}`, { ipcPath: 'https://node/debug' })).rejects.toThrow('ipc_path');
  });
  it('binds captured traces to the original transaction root and value',()=>{
    const trace={type:'CALL',from:wallet,to:router,value:'0xa'};
    expect(nodeTraceMatchesTransaction(trace,{from:wallet,to:router,value:'0xa'})).toBe(true);
    expect(nodeTraceMatchesTransaction(trace,{from:wallet,to:wallet,value:'0xa'})).toBe(false);
    expect(nodeTraceMatchesTransaction(trace,{from:wallet,to:router,value:'0xb'})).toBe(false);
    expect(nodeTraceMatchesTransaction({...trace,error:'reverted'},{from:wallet,to:router,value:'0xa'})).toBe(false);
  });
  it('queues only relevant native token trades rather than unrelated payments or whole smart-account bundles',()=>{
    const token=`0x${'c'.repeat(40)}`,execution={id:'one',txHash:`0x${'1'.repeat(64)}`,walletAddress:wallet,kind:'transaction',status:'success',nativeValueRaw:'100',
      logs:[{address:router,topics:['0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'],data:'0x'}],flows:[{tokenAddress:token,deltaRaw:'10'}]};
    expect(nodeExecutionNeedsTrace(execution)).toBe(true);
    expect(nodeExecutionNeedsTrace({...execution,nativeValueRaw:'0'})).toBe(false);
    expect(nodeExecutionNeedsTrace({...execution,flows:[]})).toBe(false);
    expect(nodeExecutionNeedsTrace({...execution,logs:[]})).toBe(false);
    expect(nodeExecutionNeedsTrace({...execution,kind:'user_operation'})).toBe(false);
    expect(nodeExecutionNeedsTrace({...execution,flows:[...execution.flows,{tokenAddress:'0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',deltaRaw:'-100'}]})).toBe(false);
    expect(nodeExecutionNeedsTrace({...execution,nativeValueRaw:'0',flows:[{tokenAddress:token,deltaRaw:'-10'}]})).toBe(true);
  });
});
