import type { Pool } from 'pg';

export interface NodeProjectionTokenMetadata { symbol: string | null; decimals: number | null }
type Checkpoint = { number: string; hash: string };
type ProjectionRpc = <T>(method: string, params: unknown[]) => Promise<T>;
const addressRe = /^0x[a-f0-9]{40}$/i, hashRe = /^0x[a-f0-9]{64}$/i;
const precision = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 36 ? value : null;
export function decodeNodeTokenIdentityText(raw: string, maximumBytes = 256): string | null {
  try {
    if (raw.length>8194 || !/^0x(?:[a-f0-9]{2})*$/i.test(raw)) return null;
    const bytes = Buffer.from(raw.slice(2), 'hex');
    let payload:Buffer;
    if (bytes.length===32) {
      const end=bytes.indexOf(0);if(end>=0&&bytes.subarray(end).some(byte=>byte!==0))return null;
      payload=end<0?bytes:bytes.subarray(0,end);
    } else {
      if(bytes.length<96||BigInt(`0x${bytes.subarray(0,32).toString('hex')}`)!==32n)return null;
      const rawLength=BigInt(`0x${bytes.subarray(32,64).toString('hex')}`);
      if(rawLength<=0n||rawLength>BigInt(maximumBytes))return null;
      const length=Number(rawLength),padded=Math.ceil(length/32)*32;
      if(bytes.length<64+padded||bytes.subarray(64+length,64+padded).some(byte=>byte!==0))return null;
      payload=bytes.subarray(64,64+length);
    }
    if(!payload.length||payload.length>maximumBytes)return null;
    const text=new TextDecoder('utf-8',{fatal:true}).decode(payload);
    if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text))return null;
    return text.replace(/\s+/gu,' ').trim()||null;
  } catch { return null; }
}

/** Compatibility feed projection still needs exact quantities. Legacy token
 * rows may contain guessed decimals, so only canonical block metadata or a
 * block-hash-bound node call can authorize scaling. Missing precision remains
 * null and is never cached as verified; identity publication need not wait. */
export function createNodeProjectionMetadata(options: { database: Pick<Pool, 'query'>; rpc: ProjectionRpc; maxEntries?: number }) {
  const cache = new Map<string, NodeProjectionTokenMetadata>(), jobs = new Map<string, Promise<NodeProjectionTokenMetadata>>();
  const maxEntries = Math.min(1000, Math.max(1, options.maxEntries ?? 256));
  async function load(rawAddress: string, checkpoint: Checkpoint, loadOptions: { allowRpc?: boolean } = {}) {
    const address = rawAddress.toLowerCase(), blockHash = checkpoint.hash.toLowerCase();
    if (!addressRe.test(address) || !hashRe.test(blockHash) || !/^0x[a-f0-9]+$/i.test(checkpoint.number)) throw new Error('node_projection_metadata_checkpoint_invalid');
    const key = `${address}:${blockHash}`, cached = cache.get(key);
    if (cached) return cached;
    const allowRpc = loadOptions.allowRpc !== false, jobKey = `${key}:${allowRpc ? 'rpc' : 'stored'}`;
    const existingJob = jobs.get(jobKey); if (existingJob) return existingJob;
    const job = (async () => {
      const existing = (await options.database.query(`SELECT t.symbol,p.decimals FROM (VALUES($1::text)) target(address)
        LEFT JOIN tokens t ON t.address=target.address LEFT JOIN node_market_token_evidence p
        ON p.token_address=target.address AND p.block_hash=$2 AND p.block_number=$3`, [address, blockHash, BigInt(checkpoint.number).toString()])).rows[0];
      let decimals = precision(existing?.decimals), symbol = typeof existing?.symbol === 'string' && existing.symbol ? existing.symbol : null;
      if (decimals === null && allowRpc) {
        try {
          const raw = await options.rpc<string>('eth_call', [{ to: address, data: '0x313ce567' }, { blockHash, requireCanonical: true }]);
          decimals = /^0x[a-f0-9]{64}$/i.test(raw) ? precision(Number(BigInt(raw))) : null;
        } catch { /* A real trade can be published without inventing precision. */ }
      }
      if (!symbol && allowRpc && decimals !== null) {
        try { symbol = decodeNodeTokenIdentityText(await options.rpc<string>('eth_call', [{ to: address, data: '0x95d89b41' }, { blockHash, requireCanonical: true }]),128); }
        catch { /* Artwork and names never block a known quantity. */ }
      }
      const result = { symbol, decimals };
      await options.database.query(`INSERT INTO tokens(address,symbol,decimals) VALUES($1,$2,$3) ON CONFLICT(address) DO UPDATE SET
        symbol=COALESCE(tokens.symbol,EXCLUDED.symbol),decimals=COALESCE(EXCLUDED.decimals,tokens.decimals)`, [address, symbol, decimals]);
      if (decimals !== null) cache.set(key, result);
      if (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
      return result;
    })().finally(() => jobs.delete(jobKey));
    jobs.set(jobKey, job); return job;
  }
  return { load, clear: () => cache.clear() };
}
