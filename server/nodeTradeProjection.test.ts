import {describe,it,expect,vi}from'vitest';
import type {PoolClient}from'pg';
import{writeNodeTradeProjection}from'./nodeTradeProjection.js';
import{projectionFixture,projectionToken,projectionWbnb,projectionWallet,projectionPool}from'./nodeTradeProjection.fixture.js';
describe('prepared transaction-only trade projection',()=>{
 it('writes exact quote amounts through its supplied connection with no external reads',async()=>{
  const{input,prepared}=projectionFixture(),query=vi.fn(async()=>({rows:[]}));
  await writeNodeTradeProjection({query}as unknown as PoolClient,input,prepared);
  const values=(query.mock.calls[0]as unknown[])[1]as unknown[];
  expect(values.slice(3,11)).toEqual([projectionToken,'buy','5',projectionWbnb,'WBNB','1','600','120']);
  expect(query.mock.calls).toHaveLength(3);
 });
 it('fails missing prepared metadata instead of acquiring a second connection',async()=>{
  const{input,prepared}=projectionFixture(),query=vi.fn();prepared.metadata=new Map();
  await expect(writeNodeTradeProjection({query}as unknown as PoolClient,input,prepared)).rejects.toThrow('node_projection_metadata_not_prepared');expect(query).not.toHaveBeenCalled();
 });
 it('uses actual refunded native spend and leaves absent trace amounts unknown',async()=>{
  const{input,prepared}=projectionFixture(),query=vi.fn(async()=>({rows:[]}));
  input.receipt.logs=input.receipt.logs.filter(log=>log.address!==projectionWbnb);input.transaction.value='0xde0b6b3a7640000';
  prepared.trace={type:'CALL',from:projectionWallet,to:projectionPool,value:input.transaction.value,calls:[{type:'CALL',from:projectionPool,to:projectionWallet,value:'0x6f05b59d3b20000'}]};
  await writeNodeTradeProjection({query}as unknown as PoolClient,input,prepared);
  expect(((query.mock.calls[0]as unknown[])[1]as unknown[]).slice(7,11)).toEqual(['BNB','0.5','300','60']);
  query.mockClear();prepared.trace=null;await writeNodeTradeProjection({query}as unknown as PoolClient,input,prepared);
  expect(((query.mock.calls[0]as unknown[])[1]as unknown[]).slice(7,11)).toEqual([null,null,null,null]);
 });
});
