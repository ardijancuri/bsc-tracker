import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { KolTokenInventoryEvidence, KolTokenInventoryTransfer } from '../shared/kolTokenTrades.js';
import { pool } from './db.js';
import { hasRecognizedSwap, transferTopic, walletSwapFlows } from './swap.js';

type Trade = { txHash: string; side: string; tokenAmount: string | null; blockNumber: string | null; blockHash?: string | null; transactionIndex?: number | null };
type Movement = KolTokenInventoryTransfer & { blockHash: string };
type Block = { number: string; hash: string; timestamp: string };
type Log = { address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string; blockHash: string; logIndex: string; transactionIndex: string; removed?: boolean };
type Rpc = (method: string, params: unknown[], signal: AbortSignal) => Promise<any>;
type Query = (sql: string, values: unknown[]) => Promise<{ rows: any[] }>;
type Persist = (events: KolTokenInventoryTransfer[], endpoint: { height: number; hash: string }, verify: () => Promise<void>, signal: AbortSignal) => Promise<void>;
type Page = { from: number; to: number; hash: string; logs: Log[]; canonicalTransactions: string[]; transactions: string[]; checked: string[] };
type State = { version: 1; wallet: string; token: string; first: number; target: number; endpoint: Block; scanned: number;
  checkpointHash: string | null; pageSize: number; page?: Page; movements: Movement[]; initialRaw: string | null; endingRaw: string | null;
  decimals: number; initialSource: 'historical_call' | 'derived_complete_movements' | null; checkedAt: string | null };
const address = /^0x[0-9a-f]{40}$/;
const hash = /^0x[0-9a-f]{64}$/;
const hex = (height: number) => `0x${height.toString(16)}`;
const topic = (wallet: string) => `0x${wallet.slice(2).padStart(64, '0')}`;
const quantity = (value: string | null, decimals: number) => {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value ?? '');
  if (!match || (match[2]?.length ?? 0) > decimals) return null;
  return BigInt(match[1] + (match[2] ?? '').padEnd(decimals, '0'));
};
const units = (raw: bigint, decimals: number) => {
  if (!decimals) return raw.toString();
  const digits = raw.toString().padStart(decimals + 1, '0');
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`.replace(/\.?0+$/, '');
};
function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { operation.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}
let requestId = 0;
const rpcRequest: Rpc = async (method, params, signal) => {
  const response = await fetch(process.env.BSC_RPC_HTTP || 'http://127.0.0.1:8545', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
  });
  if (!response.ok) throw new Error('Inventory RPC unavailable');
  const body = await response.json();
  if (body.error || body.result == null) throw new Error('Inventory RPC unavailable');
  return body.result;
};
export const persistCanonicalInventoryTransfers: Persist = async (events, endpoint, verify, signal) => {
  if (!events.length) return;
  const acquired = pool.connect().then(client => { if (signal.aborted) { client.release(); throw signal.reason; } return client; });
  const client = await bounded(acquired, signal);
  try {
    await client.query('BEGIN'); await client.query("SET LOCAL statement_timeout='1000ms'");
    await client.query('SELECT pg_advisory_xact_lock(782319)');
    await verify();
    const checkpoint = await client.query('SELECT block_hash FROM processed_blocks WHERE block_number=$1', [endpoint.height]);
    if (checkpoint.rows[0] && checkpoint.rows[0].block_hash.toLowerCase() !== endpoint.hash) throw new Error('canonical_endpoint_changed');
    await client.query(`INSERT INTO wallet_transfers(id,tx_hash,log_index,wallet_address,token_address,delta_raw,kind,block_number,block_hash,timestamp)
      SELECT m.id,m."txHash",m."logIndex",m."walletAddress",m."tokenAddress",m."deltaRaw"::numeric,'transfer',m."blockNumber"::bigint,m."blockHash",m.timestamp
      FROM jsonb_to_recordset($1::jsonb) AS m(id text,"txHash" text,"logIndex" integer,"walletAddress" text,"tokenAddress" text,"deltaRaw" text,"blockNumber" text,"blockHash" text,timestamp timestamptz)
      WHERE NOT EXISTS(SELECT 1 FROM trades t WHERE t.tx_hash=m."txHash" AND t.wallet_address=m."walletAddress" AND t.token_address=m."tokenAddress" AND t.block_number IS NOT NULL AND t.side IN('buy','sell'))
      ON CONFLICT(id) DO UPDATE SET delta_raw=EXCLUDED.delta_raw,block_number=EXCLUDED.block_number,block_hash=EXCLUDED.block_hash,timestamp=EXCLUDED.timestamp
      WHERE wallet_transfers.wallet_address=EXCLUDED.wallet_address AND wallet_transfers.token_address=EXCLUDED.token_address`, [JSON.stringify(events)]);
    await client.query('COMMIT');
  } catch (problem) { await client.query('ROLLBACK').catch(() => {}); throw problem; }
  finally { client.release(); }
};
export interface KolTokenInventoryRequest {
  wallet: string; token: string; firstBlock: string | null; decimals: number | null; trades: Trade[]; tradesComplete: boolean;
}

/** Resume canonical movement scans independently of the indexed swap ledger.
 * Empty indexed transfer tables never establish coverage or an opening balance. */
export function createKolTokenInventory({ rpc = rpcRequest, query = (sql, values) => pool.query(sql, values),
  persist = persistCanonicalInventoryTransfers, directory = path.join(process.env.TOKEN_CHART_CACHE_DIR || path.join(process.cwd(), '.cache', 'token-charts'), 'inventory'), budgetMs = 6000, now = Date.now, pageSize = 65_536,
}: { rpc?: Rpc; query?: Query; persist?: Persist; directory?: string | null; budgetMs?: number; now?: () => number; pageSize?: number } = {}) {
  const states = new Map<string, State>(), jobs = new Map<string, Promise<KolTokenInventoryEvidence>>();
  const save = async (key: string, state: State) => {
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${key}.json`), temporary = `${file}.${randomUUID()}.tmp`;
    const checksum = createHash('sha256').update(JSON.stringify(state)).digest('hex');
    await writeFile(temporary, JSON.stringify({ checksum, state })); await rename(temporary, file);
  };
  const evidence = (request: KolTokenInventoryRequest, state: State | undefined, reason: string, complete = false, reconciled = false): KolTokenInventoryEvidence => {
    const tradeTransactions = new Set(request.trades.map(trade => trade.txHash.toLowerCase()));
    return { decimals: state?.decimals ?? request.decimals ?? 0, initialBalanceRaw: complete ? state?.initialRaw ?? null : null,
      endingBalanceRaw: state?.endingRaw ?? null,
      transfers: (state?.movements ?? []).filter(event => !tradeTransactions.has(event.txHash)).map(({ blockHash: _hash, ...event }) => event),
      coverage: { complete, reconciled, fromBlock: request.firstBlock, toBlock: state ? String(state.target) : null,
        blockHash: state?.endpoint.hash ?? null, checkedAt: state?.checkedAt ?? null,
        balance: state?.endingRaw != null ? units(BigInt(state.endingRaw), state.decimals) : null,
        status: reconciled ? 'verified' : ['scan_pending', 'scan_queued', 'confirmation_pending', 'unindexed_swap_pending', 'indexed_snapshot_changed'].includes(reason) ? 'pending' : 'unavailable',
        initialBalanceSource: complete ? state?.initialSource ?? null : null, scannedThroughBlock: state ? String(state.scanned) : null,
        ...(reason ? { reason } : {}),
      } };
  };
  return async (request: KolTokenInventoryRequest): Promise<KolTokenInventoryEvidence> => {
    request = { ...request, wallet: request.wallet.toLowerCase(), token: request.token.toLowerCase() };
    if (!address.test(request.wallet) || !address.test(request.token) || !/^\d+$/.test(request.firstBlock ?? '')
      || !Number.isSafeInteger(Number(request.firstBlock))) return evidence(request, undefined, 'inventory_range_unavailable');
    const key = `${request.wallet}-${request.token}-${request.firstBlock}`;
    const existing = jobs.get(key); if (existing) return existing;
    if (jobs.size >= 2) return evidence(request, states.get(key), 'scan_queued');
    const job = (async () => {
      const signal = AbortSignal.timeout(budgetMs);
      const call = (method: string, params: unknown[]) => bounded(rpc(method, params, signal), signal);
      const block = async (height: number): Promise<Block> => {
        const value = await call('eth_getBlockByNumber', [hex(height), false]);
        if (!value || Number(BigInt(value.number)) !== height || !hash.test(value.hash?.toLowerCase() ?? '') || !/^0x[0-9a-f]+$/i.test(value.timestamp ?? '')) throw new Error('canonical_block_unavailable');
        return { number: value.number, hash: value.hash.toLowerCase(), timestamp: value.timestamp };
      };
      let state = states.get(key);
      try {
        if (!state && directory) {
          try {
            const text = await readFile(path.join(directory, `${key}.json`), 'utf8');
            if (text.length > 8_000_000) throw new Error('inventory_limit');
            const document = JSON.parse(text) as { checksum?: string; state?: State };
            const saved = document.state;
            if (!saved || document.checksum !== createHash('sha256').update(JSON.stringify(saved)).digest('hex')) throw new Error('inventory_cache_invalid');
            if (saved.version === 1 && saved.wallet === request.wallet && saved.token === request.token && saved.first === Number(request.firstBlock)
              && Array.isArray(saved.movements) && saved.movements.length <= 10_000 && Number.isSafeInteger(saved.scanned) && Number.isSafeInteger(saved.target)
              && saved.scanned >= saved.first - 1 && saved.scanned <= saved.target && saved.target >= saved.first
              && Number.isInteger(saved.decimals) && saved.decimals >= 0 && saved.decimals <= 36
              && Number.isSafeInteger(saved.pageSize) && saved.pageSize > 0 && saved.pageSize <= 65_536
              && hash.test(saved.endpoint?.hash ?? '') && Number(BigInt(saved.endpoint.number)) === saved.target
              && (saved.initialRaw === null || /^\d+$/.test(saved.initialRaw)) && (saved.endingRaw === null || /^\d+$/.test(saved.endingRaw))
              && saved.movements.every(event => event.walletAddress === request.wallet && event.tokenAddress === request.token && hash.test(event.txHash)
                && hash.test(event.blockHash) && /^-?\d+$/.test(event.deltaRaw) && /^\d+$/.test(event.blockNumber)
                && Number(event.blockNumber) >= saved.first && Number(event.blockNumber) <= saved.target && Number.isFinite(Date.parse(event.timestamp))
                && Number.isSafeInteger(event.logIndex) && event.logIndex! >= 0 && Number.isSafeInteger(event.transactionIndex) && event.transactionIndex! >= 0)
              && (!saved.page || Array.isArray(saved.page.logs) && Array.isArray(saved.page.canonicalTransactions) && Array.isArray(saved.page.transactions) && Array.isArray(saved.page.checked)
                && saved.page.from === saved.scanned + 1 && saved.page.to <= saved.target && hash.test(saved.page.hash)
                && saved.page.transactions.every(tx => hash.test(tx)) && saved.page.checked.every(tx => saved.page!.transactions.includes(tx))
                && saved.page.canonicalTransactions.every(tx => saved.page!.transactions.includes(tx)))) state = saved;
          } catch { /* Missing or invalid cached evidence starts a fresh scan. */ }
        }
        if (state && state.scanned >= state.first && state.checkpointHash !== (await block(state.scanned)).hash) state = undefined;
        if (state?.page && state.page.hash !== (await block(state.page.to)).hash) state = undefined;
        if (state && request.trades.some(trade => trade.blockNumber !== null && Number(trade.blockNumber) <= state!.scanned
          && !state!.movements.some(event => event.txHash === trade.txHash.toLowerCase()))) state = undefined;
        const head = Number(BigInt(await call('eth_blockNumber', []))), target = Math.max(0, head - 6), first = Number(request.firstBlock);
        if (target < first || request.trades.some(trade => trade.blockNumber != null && Number(trade.blockNumber) > target)) return evidence(request, state, 'confirmation_pending');
        if (!state) {
          const endpoint = await block(target);
          const rawDecimals = await call('eth_call', [{ to: request.token, data: '0x313ce567' }, hex(target)]);
          const decimals = Number(BigInt(rawDecimals));
          if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36 || request.decimals != null && request.decimals !== decimals) return evidence(request, undefined, 'decimals_unreconciled');
          state = { version: 1, wallet: request.wallet, token: request.token, first, target, endpoint, scanned: first - 1,
            checkpointHash: null, pageSize, movements: [], initialRaw: null, endingRaw: null, decimals, initialSource: null, checkedAt: null };
          if (first > 0) {
            try { state.initialRaw = BigInt(await call('eth_call', [{ to: request.token, data: `0x70a08231${request.wallet.slice(2).padStart(64, '0')}` }, hex(first - 1)])).toString(); state.initialSource = 'historical_call'; }
            catch { /* Derivation requires the completed movement scan and same-block end balance below. */ }
          }
        } else if (state.scanned === state.target && target > state.target) {
          state.target = target; state.endpoint = await block(target); state.endingRaw = null; state.checkedAt = null;
        }
        states.set(key, state);
        const ledger = await bounded(query(`SELECT tx_hash AS "txHash",block_number::text AS "blockNumber" FROM wallet_transfers
          WHERE wallet_address=$1 AND token_address=$2 AND block_number BETWEEN $3 AND $4 ORDER BY block_number,log_index LIMIT 10001`,
        [request.wallet, request.token, state.first, state.target]), signal);
        if (ledger.rows.length > 10_000) return evidence(request, state, 'inventory_limit');
        const verifyReceipt = async (txHash: string): Promise<Movement[]> => {
          const receipt = await call('eth_getTransactionReceipt', [txHash]);
          if (!receipt || receipt.status !== '0x1' || receipt.transactionHash?.toLowerCase() !== txHash || !Array.isArray(receipt.logs)) throw new Error('canonical_receipt_unavailable');
          const height = Number(BigInt(receipt.blockNumber)), canonical = await block(height);
          if (receipt.blockHash?.toLowerCase() !== canonical.hash || !state!.page || height < state!.page.from || height > state!.page.to) throw new Error('canonical_receipt_mismatch');
          if (!request.trades.some(trade => trade.txHash.toLowerCase() === txHash)) {
            const transaction = await call('eth_getTransactionByHash', [txHash]);
            if (!transaction || transaction.hash?.toLowerCase() !== txHash || transaction.blockHash?.toLowerCase() !== canonical.hash
              || Number(BigInt(transaction.blockNumber)) !== height || !address.test(transaction.from?.toLowerCase() ?? '')
              || !/^0x[0-9a-f]+$/i.test(transaction.value ?? '')) throw new Error('canonical_transaction_unavailable');
            const value = transaction.from.toLowerCase() === request.wallet ? BigInt(transaction.value) : 0n;
            if (walletSwapFlows(request.wallet, value, receipt.logs).has(request.token)
              && (transaction.from.toLowerCase() === request.wallet || hasRecognizedSwap(receipt.logs))) throw new Error('unindexed_swap_pending');
          }
          for (const observed of state!.page.logs.filter(log => log.transactionHash.toLowerCase() === txHash)) {
            const actual = (receipt.logs as Log[]).find(log => log.logIndex === observed.logIndex && log.address.toLowerCase() === request.token);
            if (!actual || observed.blockHash.toLowerCase() !== canonical.hash || Number(BigInt(observed.blockNumber)) !== height
              || actual.data.toLowerCase() !== observed.data.toLowerCase() || actual.topics.join(':').toLowerCase() !== observed.topics.join(':').toLowerCase()) throw new Error('canonical_log_mismatch');
          }
          const movements: Movement[] = [];
          for (const log of receipt.logs as Log[]) {
            if (log.address?.toLowerCase() !== request.token || log.topics?.[0]?.toLowerCase() !== transferTopic || log.topics.length !== 3) continue;
            const from = `0x${log.topics[1].slice(-40)}`.toLowerCase(), to = `0x${log.topics[2].slice(-40)}`.toLowerCase();
            if (from !== request.wallet && to !== request.wallet || from === to) continue;
            if (log.removed || log.blockHash?.toLowerCase() !== canonical.hash || Number(BigInt(log.blockNumber)) !== height || !/^0x[0-9a-f]{64}$/i.test(log.data)) throw new Error('canonical_log_mismatch');
            const logIndex = Number(BigInt(log.logIndex)), transactionIndex = Number(BigInt(receipt.transactionIndex));
            const delta = BigInt(log.data) * (to === request.wallet ? 1n : -1n);
            if (!delta) continue;
            movements.push({ id: `${txHash}:${logIndex}:${request.wallet}`, txHash, walletAddress: request.wallet, tokenAddress: request.token,
              deltaRaw: delta.toString(), timestamp: new Date(Number(BigInt(canonical.timestamp)) * 1000).toISOString(), blockNumber: String(height),
              transactionIndex, logIndex, blockHash: canonical.hash });
          }
          return movements;
        };
        while (!signal.aborted) {
          // A resumed scan may finish a target pinned by a much earlier request.
          // Cover the confirmed head captured now before publishing fresh proof.
          if (state.scanned === state.target && target > state.target) {
            state.target = target; state.endpoint = await block(target); state.endingRaw = null; state.checkedAt = null;
          }
          if (state.scanned >= state.target) break;
          if (!state.page) {
            const from = state.scanned + 1, to = Math.min(state.target, from + state.pageSize - 1), endpoint = await block(to);
            let rows: Log[];
            try {
              const responses = await Promise.all([
                call('eth_getLogs', [{ address: request.token, fromBlock: hex(from), toBlock: hex(to), topics: [transferTopic, topic(request.wallet)] }]),
                call('eth_getLogs', [{ address: request.token, fromBlock: hex(from), toBlock: hex(to), topics: [transferTopic, null, topic(request.wallet)] }]),
              ]);
              if (responses.some(value => !Array.isArray(value))) throw new Error('movement_scan_unavailable');
              rows = responses.flat();
            } catch (problem) {
              if (!signal.aborted && state.pageSize > 512) { state.pageSize = Math.max(512, Math.floor(state.pageSize / 2)); continue; }
              throw problem;
            }
            if (rows.length > 20_000) throw new Error('inventory_limit');
            const transactions = new Set<string>();
            for (const log of rows) {
              if (log.removed || !hash.test(log.transactionHash?.toLowerCase() ?? '') || !log.blockNumber || Number(BigInt(log.blockNumber)) < from || Number(BigInt(log.blockNumber)) > to
                || log.address?.toLowerCase() !== request.token || log.topics?.[0]?.toLowerCase() !== transferTopic) throw new Error('movement_scan_invalid');
              transactions.add(log.transactionHash.toLowerCase());
            }
            // Indexed movements are acceleration hints, never coverage proof.
            const canonicalTransactions = [...transactions];
            for (const row of ledger.rows) if (Number(row.blockNumber) >= from && Number(row.blockNumber) <= to && hash.test(String(row.txHash).toLowerCase())) transactions.add(String(row.txHash).toLowerCase());
            state.page = { from, to, hash: endpoint.hash, logs: rows, canonicalTransactions, transactions: [...transactions], checked: [] };
          }
          const pending = state.page.transactions.filter(tx => !state!.page!.checked.includes(tx));
          for (let offset = 0; offset < pending.length && !signal.aborted; offset += 4) {
            const results = await Promise.all(pending.slice(offset, offset + 4).map(async tx => {
              try { return { tx, movements: await verifyReceipt(tx) }; }
              catch (problem) {
                // Orphan/missing indexed hints cannot block canonical getLogs
                // coverage after a reorg or a worker-ledger cleanup.
                const indexingEvidence = problem instanceof Error && /^(unindexed_|indexed_)/.test(problem.message);
                if (!signal.aborted && !indexingEvidence && !state!.page!.canonicalTransactions.includes(tx)) return { tx, movements: [] as Movement[] };
                throw problem;
              }
            }));
            const byId = new Map(state.movements.map(event => [event.id, event]));
            for (const result of results) { for (const event of result.movements) byId.set(event.id, event); state.page.checked.push(result.tx); }
            state.movements = [...byId.values()];
            if (state.movements.length > 10_000) throw new Error('inventory_limit');
          }
          if (state.page.checked.length !== state.page.transactions.length) break;
          if ((await block(state.page.to)).hash !== state.page.hash) throw new Error('canonical_page_changed');
          state.scanned = state.page.to; state.checkpointHash = state.page.hash; state.page = undefined;
        }
        if (state.scanned !== state.target) return evidence(request, state, 'scan_pending');
        const endpointTime = Number(BigInt(state.endpoint.timestamp)) * 1000;
        if (endpointTime > now() || now() - endpointTime > 180_000) return evidence(request, state, 'confirmed_endpoint_stale');
        state.endingRaw = BigInt(await call('eth_call', [{ to: request.token, data: `0x70a08231${request.wallet.slice(2).padStart(64, '0')}` }, hex(state.target)])).toString();
        if ((await block(state.target)).hash !== state.endpoint.hash) throw new Error('canonical_endpoint_changed');
        state.checkedAt = new Date(now()).toISOString();
        const indexed = await bounded(query(`SELECT tx_hash AS "txHash" FROM trades WHERE wallet_address=$1 AND token_address=$2
          AND block_number BETWEEN $3 AND $4 AND side IN('buy','sell','swap','unknown')`, [request.wallet, request.token, state.first, state.target]), signal);
        const selectedTransactions = new Set(request.trades.map(trade => trade.txHash.toLowerCase()));
        if (indexed.rows.some(row => !selectedTransactions.has(String(row.txHash).toLowerCase()))) return evidence(request, state, 'indexed_snapshot_changed');
        const swapTransactions = new Set(request.trades.map(trade => trade.txHash.toLowerCase()));
        await bounded(persist(state.movements.filter(event => !swapTransactions.has(event.txHash)), { height: state.target, hash: state.endpoint.hash }, async () => {
          if ((await block(state!.target)).hash !== state!.endpoint.hash) throw new Error('canonical_endpoint_changed');
        }, signal), signal);
        const net = state.movements.reduce((sum, event) => sum + BigInt(event.deltaRaw), 0n), ending = BigInt(state.endingRaw);
        if (state.initialRaw === null) { const opening = ending - net; if (opening < 0n) return evidence(request, state, 'negative_derived_opening', true); state.initialRaw = opening.toString(); state.initialSource = 'derived_complete_movements'; }
        if (BigInt(state.initialRaw) + net !== ending) {
          const failed = evidence(request, state, 'movement_balance_unreconciled', true);
          // A missing cached movement must not make every future request reuse
          // the same inconsistent proof. Re-read the canonical window next time.
          states.delete(key); state = undefined;
          if (directory) await unlink(path.join(directory, `${key}.json`)).catch(() => {});
          return failed;
        }
        if (!request.tradesComplete) return evidence(request, state, 'indexed_trades_incomplete', true);
        const netByTx = new Map<string, bigint>();
        for (const event of state.movements) netByTx.set(event.txHash, (netByTx.get(event.txHash) ?? 0n) + BigInt(event.deltaRaw));
        const expected = new Map<string, bigint>();
        for (const trade of request.trades) {
          if (!['buy', 'sell'].includes(trade.side)) return evidence(request, state, 'unresolved_swap', true);
          const raw = quantity(trade.tokenAmount, state.decimals), tx = trade.txHash.toLowerCase();
          if (raw === null || raw <= 0n || !hash.test(tx)) return evidence(request, state, 'trade_quantity_unavailable', true);
          const canonical = state.movements.find(event => event.txHash === tx);
          if (!canonical || canonical.blockNumber !== trade.blockNumber || trade.blockHash && trade.blockHash.toLowerCase() !== canonical.blockHash
            || trade.transactionIndex != null && trade.transactionIndex !== canonical.transactionIndex) return evidence(request, state, 'swap_canonical_unreconciled', true);
          expected.set(tx, (expected.get(tx) ?? 0n) + raw * (trade.side === 'buy' ? 1n : -1n));
        }
        for (const [tx, expectedRaw] of expected) if (netByTx.get(tx) !== expectedRaw) return evidence(request, state, 'swap_quantity_unreconciled', true);
        return evidence(request, state, '', true, true);
      } catch (problem) {
        const reason = signal.aborted ? 'scan_pending' : problem instanceof Error && /^(canonical_|movement_|inventory_|unindexed_|indexed_)/.test(problem.message) ? problem.message : 'inventory_rpc_unavailable';
        if (/^canonical_.*(changed|mismatch)$/.test(reason)) { state = undefined; states.delete(key); }
        return evidence(request, state, reason);
      } finally {
        if (state) { states.set(key, state); await save(key, state).catch(() => {}); }
        if (states.size > 100) for (const savedKey of states.keys()) { if (!jobs.has(savedKey)) { states.delete(savedKey); break; } }
      }
    })().finally(() => jobs.delete(key));
    jobs.set(key, job); return job;
  };
}
export const currentKolTokenInventory = createKolTokenInventory();
