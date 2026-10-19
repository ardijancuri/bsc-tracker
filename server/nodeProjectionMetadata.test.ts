import { describe, expect, it, vi } from 'vitest';
import { createNodeProjectionMetadata } from './nodeProjectionMetadata.js';

const token = `0x${'a'.repeat(40)}`, hash = `0x${'b'.repeat(64)}`, nextHash = `0x${'c'.repeat(64)}`;
const block = { number: '0x64', hash }, abiInteger = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
function fixture(evidence: { decimals?: number; symbol?: string } = {}, rpcResult: string | Error = abiInteger(6)) {
  const database = { query: vi.fn(async (sql: string, _values?:unknown[]) => ({ rows: sql.startsWith('SELECT') ? [evidence] : [] })) };
  const rpc = vi.fn(async () => { if (rpcResult instanceof Error) throw rpcResult; return rpcResult; });
  const service = createNodeProjectionMetadata({ database: database as any, rpc: rpc as any });
  return { database, rpc, service };
}
describe('canonical projection token precision', () => {
  it('ignores legacy token precision and binds the replacement call to the transaction block hash', async () => {
    const { service, rpc, database } = fixture({ symbol: 'USD' });
    expect(await service.load(token, block)).toEqual({ symbol: 'USD', decimals: 6 });
    expect(database.query.mock.calls[0][0]).toContain('p.block_hash=$2');
    expect(database.query.mock.calls[0][0]).not.toContain('t.decimals');
    expect(rpc).toHaveBeenCalledExactlyOnceWith('eth_call', [{ to: token, data: '0x313ce567' }, { blockHash: hash, requireCanonical: true }]);
    expect(database.query.mock.calls[1][0]).toContain('decimals=COALESCE(EXCLUDED.decimals,tokens.decimals)');
  });
  it('uses exact stored block evidence without a financial RPC call', async () => {
    const { service, rpc } = fixture({ decimals: 0, symbol: 'Whole' }, new Error('pruned'));
    expect((await service.load(token, block)).decimals).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('coalesces only equal block identities and rechecks a new block', async () => {
    const { service, rpc } = fixture({ symbol: 'T' });
    const [a, b] = await Promise.all([service.load(token, block), service.load(token, block)]);
    expect(a).toBe(b); expect(rpc).toHaveBeenCalledTimes(1);
    await service.load(token, { ...block, hash: nextHash });
    expect(rpc).toHaveBeenCalledTimes(2);
    service.clear(); await service.load(token, block);
    expect(rpc).toHaveBeenCalledTimes(3);
  });
  it('retries unavailable metadata rather than scaling with a fallback or caching failure', async () => {
    const { service, rpc, database } = fixture({ symbol: 'T' }, new Error('missing trie node'));
    expect(await service.load(token, block)).toEqual({symbol:'T',decimals:null});
    expect(await service.load(token, block)).toEqual({symbol:'T',decimals:null});
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(database.query.mock.calls.filter(([sql])=>sql.startsWith('INSERT')).every(([,values])=>(values as unknown[])[2]===null)).toBe(true);
  });
  it.each([abiInteger(37), '0x06', '0x', abiInteger(256)])('leaves invalid exact precision unavailable %s', async raw => {
    const { service } = fixture({ symbol: 'T' }, raw);
    expect((await service.load(token, block)).decimals).toBeNull();
  });
  it('publishes known sibling metadata while an unknown flow waits, without RPC or a negative precision cache',async()=>{
    let repaired=false;
    const known=`0x${'d'.repeat(40)}`;
    const database={query:vi.fn(async(sql:string,values?:unknown[])=>({rows:sql.startsWith('SELECT')
      ?[{symbol:values?.[0]===known?'Known':'Unknown',decimals:values?.[0]===known?6:repaired?9:undefined}]:[]}))};
    const rpc=vi.fn(async()=>{throw Error('Projection must use saved evidence');});
    const service=createNodeProjectionMetadata({database:database as any,rpc:rpc as any});
    const rows=await Promise.all([service.load(token,block,{allowRpc:false}),service.load(known,block,{allowRpc:false})]);
    expect(rows).toEqual([{symbol:'Unknown',decimals:null},{symbol:'Known',decimals:6}]);expect(rpc).not.toHaveBeenCalled();
    repaired=true;
    expect((await service.load(token,block,{allowRpc:false})).decimals).toBe(9);
    expect(database.query.mock.calls.filter(([sql])=>sql.startsWith('SELECT')).length).toBe(3);
  });
  it('does not require symbol metadata for an independently verified quantity', async () => {
    const { service, rpc } = fixture({ decimals: 9 }, new Error('unsupported symbol'));
    expect(await service.load(token, block)).toEqual({ symbol: null, decimals: 9 });
    expect(rpc).toHaveBeenCalledExactlyOnceWith('eth_call', [{ to: token, data: '0x95d89b41' }, { blockHash: hash, requireCanonical: true }]);
  });
  it('bounds the block cache and rejects malformed checkpoint identities', async () => {
    const f = fixture({ symbol: 'T' });
    const service = createNodeProjectionMetadata({ database: f.database as any, rpc: f.rpc as any, maxEntries: 1 });
    await service.load(token, block); await service.load(token, { ...block, hash: nextHash }); await service.load(token, block);
    expect(f.rpc).toHaveBeenCalledTimes(3);
    await expect(service.load(token, { number: 'latest', hash })).rejects.toThrow('node_projection_metadata_checkpoint_invalid');
    await expect(service.load(token, { ...block, hash: 'latest' })).rejects.toThrow('node_projection_metadata_checkpoint_invalid');
  });
});
