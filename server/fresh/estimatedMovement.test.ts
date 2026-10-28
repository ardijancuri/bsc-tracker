import{describe,it,expect,vi}from'vitest';import{verifyFreshEstimatedMovement}from'./estimatedMovement.js';import{encodeFreshEvidence}from'./capture.js';
const wallet='0x'+'1'.repeat(40),token='0x'+'2'.repeat(40),hash='0x'+'a'.repeat(64),tx='0x'+'b'.repeat(64),topic='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',word=(v:bigint)=>'0x'+v.toString(16).padStart(64,'0');
function fixture(reason='trade_value_unavailable',quantity='1'){
 const e:any={wallets:[wallet],observedAt:'2026-10-28T20:00:00Z',transaction:{hash:tx,blockHash:hash},receipt:{transactionHash:tx,blockHash:hash,status:'0x1',logs:[{address:token,transactionHash:tx,blockHash:hash,topics:[topic,word(0n),'0x'+wallet.slice(2).padStart(64,'0')],data:word(100n)}]}};
 const query=vi.fn(async(sql:string)=>({rows:sql.includes('FROM fresh.recent_evidence')?[{tx_hash:tx,block_hash:hash,payload:encodeFreshEvidence(e),last_error:reason}]:[{kind:'buy',quantity}]}));
 const rpc:any=vi.fn(async(method:string)=>method==='eth_call'?word(100n):{hash,number:'0x64'});
 const input={scopeId:'kol:'+wallet,wallet,token,decimals:2,quantityQ:'1',block:'100',hash};return{e,db:{query},rpc,input};
}
describe('selected estimated movement proof',()=>{
 it('allows only a monetary repair with original matching logs and an exact canonical balance',async()=>{const f=fixture(),proof=await verifyFreshEstimatedMovement(f.db as any,f.rpc,f.input);expect(proof).toMatchObject({block:'100',hash,quantity:'1'});expect(f.rpc).toHaveBeenCalledTimes(3);expect(f.db.query.mock.calls.every(c=>c[0].startsWith('SELECT'))).toBe(true);});
 it.each(['metadata_unavailable','unsupported_execution','operation_fee_allocation_unknown','trade_value_unavailable,token_discovery_pending',''])('rejects non-monetary or empty repair %s',async reason=>{const f=fixture(reason);expect(await verifyFreshEstimatedMovement(f.db as any,f.rpc,f.input)).toBeNull();expect(f.rpc).not.toHaveBeenCalled();});
 it('rejects a normalized amount that does not match the original transfer logs',async()=>{const f=fixture('trade_value_unavailable','2');expect(await verifyFreshEstimatedMovement(f.db as any,f.rpc,f.input)).toBeNull();expect(f.rpc).not.toHaveBeenCalled();});
 it('rejects a different ending balance or reorg',async()=>{const f=fixture();f.rpc.mockImplementation(async(method:string)=>method==='eth_call'?word(101n):{hash,number:'0x64'});expect(await verifyFreshEstimatedMovement(f.db as any,f.rpc,f.input)).toBeNull();f.rpc.mockImplementation(async()=>({hash:'0x'+'c'.repeat(64),number:'0x64'}));expect(await verifyFreshEstimatedMovement(f.db as any,f.rpc,f.input)).toBeNull();});
});
