import type { PoolClient } from 'pg';
import { pool, notifyUpdate, setState } from './db.js';
import type { SignalEvidence } from '../shared/intelligence.js';
import { classifyPosition, compareTrades, cooldownAllows, defaultSignalSettings, detectSignals, profileKey, type ObservedTrade, type PositionMovement } from './intelligenceLogic.js';
import { blockHex, chainRpc } from './rpc.js';
import { FOUR_MANAGERS, FLAP_PORTAL, launchEventTopics, parseLaunchLog } from './launchpad.js';
import { hasRecognizedSwap, transferTopic } from './swap.js';
import { nonStockTokenSql } from './stockToken.js';
import { transactionWallets, walletTransactionContext } from './smartAccountTrades.js';
import type { NodeExecution } from './nodeExecution.js';
import { prunePositionSnapshots } from './positionSnapshotRetention.js';

type ChainLog = { address: string; topics: string[]; data: string; transactionHash: string; logIndex?: string; blockNumber?: string; blockHash?: string; removed?: boolean };
type Block = { number: string; hash: string; timestamp: string };
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const normalized = (value: string) => value.toLowerCase();
const evidence = (trade: ObservedTrade): SignalEvidence => ({ id: trade.id, txHash: trade.txHash, walletAddress: trade.walletAddress,
  kolName: trade.kolName, side: trade.side, timestamp: trade.timestamp, blockNumber: trade.blockNumber, blockHash: trade.blockHash });

export async function recordWalletTransfers(tx: { hash: string; from: string; to?: string | null; value?: string }, receipt: { status: string; logs: ChainLog[] }, block: Block, wallets: Set<string>, database: Pick<PoolClient, 'query'> = pool, executions?: NodeExecution[]) {
  if (receipt.status !== '0x1') return;
  const logs = receipt.logs.filter(log => !log.removed && log.topics[0]?.toLowerCase() === transferTopic && log.topics.length === 3
    && /^0x0{24}[0-9a-f]{40}$/i.test(log.topics[1]) && /^0x0{24}[0-9a-f]{40}$/i.test(log.topics[2]) && /^0x[0-9a-f]{64}$/i.test(log.data));
  if (!logs.length) return;
  // An incoming token may precede the first purchase (or never be purchased).
  // Keep its raw evidence before display exclusions; unknown decimals stay NULL.
  const tokens = new Set(logs.filter(log => wallets.has(`0x${log.topics[1].slice(-40)}`.toLowerCase()) || wallets.has(`0x${log.topics[2].slice(-40)}`.toLowerCase()))
    .map(log => normalized(log.address)).filter(address => /^0x[0-9a-f]{40}$/.test(address)));
  if (!tokens.size) return;
  await database.query(`INSERT INTO tokens(address) SELECT unnest($1::text[]) ON CONFLICT(address) DO NOTHING`, [[...tokens]]);
  const trades = await database.query('SELECT wallet_address,token_address,side FROM trades WHERE tx_hash=$1 AND block_number IS NOT NULL', [normalized(tx.hash)]);
  const sides = new Map(trades.rows.map(row => [`${row.wallet_address}:${row.token_address}`, row.side]));
  const initiated = new Map(transactionWallets(tx, receipt).filter(wallet => wallets.has(wallet))
    .map(wallet => [wallet, new Set(walletTransactionContext(tx, receipt, wallet)!.logs)]));
  for (let index = 0; index < receipt.logs.length; index++) {
    const log = receipt.logs[index];
    if (!logs.includes(log) || !tokens.has(normalized(log.address))) continue;
    const from = `0x${log.topics[1].slice(-40)}`.toLowerCase();
    const to = `0x${log.topics[2].slice(-40)}`.toLowerCase();
    if (from === to) continue;
    for (const [wallet, sign] of [[from, -1n], [to, 1n]] as const) {
      if (!wallets.has(wallet)) continue;
      const token = normalized(log.address);
      const execution = executions?.find(item => item.walletAddress === wallet && item.status === 'success' && item.kind !== 'transfer'
        && (hasRecognizedSwap(item.logs) || BigInt(item.nativeValueRaw) > 0n) && item.logs.includes(log));
      const flow = execution?.flows.find(item => item.tokenAddress === token);
      const side = flow ? BigInt(flow.deltaRaw) > 0n ? 'buy' : 'sell' : sides.get(`${wallet}:${token}`);
      const kind = (execution || initiated.get(wallet)?.has(log)) && ['buy', 'sell'].includes(side) ? side : 'transfer';
      const logIndex = log.logIndex ? Number(BigInt(log.logIndex)) : index;
      await database.query(`INSERT INTO wallet_transfers(id,tx_hash,log_index,wallet_address,token_address,delta_raw,kind,block_number,block_hash,timestamp,counterparty_address)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10),$11) ON CONFLICT(id) DO UPDATE SET kind=EXCLUDED.kind,counterparty_address=EXCLUDED.counterparty_address
          WHERE wallet_transfers.block_hash=EXCLUDED.block_hash AND wallet_transfers.delta_raw=EXCLUDED.delta_raw`,
      [`${normalized(tx.hash)}:${logIndex}:${wallet}`, normalized(tx.hash), logIndex, wallet, token, (BigInt(log.data) * sign).toString(), kind, Number(BigInt(block.number)), block.hash, Number(BigInt(block.timestamp)), sign < 0n ? to : from]);
    }
  }
}

export async function recordLaunchRange(from: number, to: number, blocks: Block[]) {
  const known = await pool.query('SELECT DISTINCT token_address FROM trades t JOIN kols k ON k.address=t.wallet_address WHERE k.is_tracked AND block_number IS NOT NULL');
  const tokens = new Set<string>(known.rows.map(row => row.token_address));
  if (!tokens.size) return;
  const logs = await chainRpc<ChainLog[]>('eth_getLogs', [{ fromBlock: blockHex(from), toBlock: blockHex(to), address: [...FOUR_MANAGERS, FLAP_PORTAL], topics: [[...new Set(launchEventTopics)]] }]);
  const byHeight = new Map(blocks.map(block => [Number(BigInt(block.number)), block]));
  for (const log of logs) {
    if (log.removed || !log.blockNumber || !log.logIndex) continue;
    const block = byHeight.get(Number(BigInt(log.blockNumber)));
    if (!block || log.blockHash?.toLowerCase() !== block.hash.toLowerCase()) throw new Error('Launch event block mismatch');
    const parsed = parseLaunchLog(log, tokens);
    if (!parsed) continue;
    await pool.query(`INSERT INTO launch_events(id,token_address,platform,kind,block_number,block_hash,tx_hash,timestamp,details)
      VALUES($1,$2,$3,$4,$5,$6,$7,to_timestamp($8),$9::jsonb) ON CONFLICT(id) DO NOTHING`,
    [`${log.transactionHash.toLowerCase()}:${Number(BigInt(log.logIndex))}`, parsed.token, parsed.platform, parsed.kind, Number(BigInt(block.number)), block.hash,
      log.transactionHash.toLowerCase(), Number(BigInt(block.timestamp)), JSON.stringify(parsed)]);
  }
}

export async function rollbackIntelligence(client: PoolClient, from: number) {
  await client.query('SELECT pg_advisory_xact_lock(782319)');
  await client.query(`UPDATE radar_signals SET corrected=true WHERE source_block >= $1 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(evidence) item WHERE (item->>'blockNumber')::bigint >= $1)`, [from]);
  await client.query('DELETE FROM wallet_transfers WHERE block_number >= $1', [from]);
  await client.query('DELETE FROM position_snapshots WHERE block_number >= $1', [from]);
  await client.query('DELETE FROM launch_events WHERE block_number >= $1', [from]);

}

export async function collectSignals() {
  await backfillSignalProfile();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(782319)');
    await client.query(`UPDATE trades SET intelligence_processed=true WHERE NOT intelligence_processed AND block_number IS NOT NULL AND (timestamp<=now()-interval '24 hours' OR NOT ${nonStockTokenSql('token_address')})`);
    const rows = await client.query(`SELECT t.id,t.tx_hash AS "txHash",t.wallet_address AS "walletAddress",t.token_address AS "tokenAddress",k.display_name AS "kolName",
      t.side,t.timestamp,t.block_number::text AS "blockNumber",t.block_hash AS "blockHash",t.transaction_index AS "transactionIndex",t.observed_live AS "observedLive"
      FROM trades t JOIN published_kols k ON k.address=t.wallet_address
      WHERE k.is_tracked AND ${nonStockTokenSql('t.token_address')} AND NOT t.intelligence_processed AND t.block_number IS NOT NULL AND t.timestamp > now()-interval '24 hours'
      AND t.block_number <= COALESCE((SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node'),0)
      ORDER BY t.block_number,t.transaction_index NULLS FIRST,t.id LIMIT 200 FOR SHARE OF t`);
    if (!rows.rows.length) { await client.query('COMMIT'); return; }
    const trades: ObservedTrade[] = rows.rows.map(row => ({ ...row, timestamp: new Date(row.timestamp).toISOString() }));
    const earliest = Math.min(...trades.map(trade => Date.parse(trade.timestamp))) - 86400_000;
    const historyRows = await client.query(`SELECT t.id,t.tx_hash AS "txHash",t.wallet_address AS "walletAddress",t.token_address AS "tokenAddress",k.display_name AS "kolName",
      t.side,t.timestamp,t.block_number::text AS "blockNumber",t.block_hash AS "blockHash",t.transaction_index AS "transactionIndex"
      FROM trades t JOIN published_kols k ON k.address=t.wallet_address WHERE k.is_tracked AND ${nonStockTokenSql('t.token_address')} AND t.block_number IS NOT NULL AND t.token_address=ANY($1::text[]) AND t.timestamp >= $2
      AND t.block_number <= $3 ORDER BY t.block_number,t.transaction_index NULLS FIRST,t.id`,
    [[...new Set(trades.map(trade => trade.tokenAddress))], new Date(earliest).toISOString(), trades.at(-1)!.blockNumber]);
    const history: ObservedTrade[] = historyRows.rows.map(row => ({ ...row, timestamp: new Date(row.timestamp).toISOString() }));
    const profile = defaultSignalSettings;
    let inserted = 0;
    for (const trade of trades.sort(compareTrades)) {
      for (const candidate of detectSignals(trade, history, profile)) {
        const last = await client.query(`SELECT timestamp FROM radar_signals WHERE entity=$1 AND kind=$2 AND window_minutes=$3 AND min_buyers=$4
          AND NOT corrected AND timestamp <= $5 ORDER BY timestamp DESC LIMIT 1`, [candidate.entity, candidate.kind, profile.windowMinutes, profile.minBuyers, candidate.timestamp]);
        if (!cooldownAllows(last.rows[0]?.timestamp ? new Date(last.rows[0].timestamp).toISOString() : null, candidate.timestamp)) continue;
        const live = Boolean(trade.observedLive && Date.now() - Date.parse(trade.timestamp) <= 300_000);
        const result = await client.query(`INSERT INTO radar_signals(id,kind,entity,token_address,wallet_addresses,evidence,window_minutes,min_buyers,timestamp,source_block,source_hash,live)
          VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING RETURNING id`,
        [candidate.id, candidate.kind, candidate.entity, trade.tokenAddress, candidate.wallets, JSON.stringify(candidate.evidence.map(evidence)), profile.windowMinutes, profile.minBuyers,
          candidate.timestamp, trade.blockNumber, trade.blockHash, live]);
        inserted += result.rowCount ?? 0;
      }
    }
    await client.query('UPDATE trades SET intelligence_processed=true WHERE id=ANY($1::text[])', [trades.map(trade => trade.id)]);
    await client.query('COMMIT');
    await setState('radar', { processedAt: new Date().toISOString(), inserted });
    if (inserted) await notifyUpdate();
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function backfillSignalProfile() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(782319)');
    const pending = await client.query('SELECT * FROM radar_profiles WHERE profile=$1 AND backfilled_at IS NULL FOR UPDATE SKIP LOCKED', [profileKey(defaultSignalSettings)]);
    const profile = pending.rows[0];
    if (!profile) { await client.query('COMMIT'); return; }
    const rows = await client.query(`SELECT t.id,t.tx_hash AS "txHash",t.wallet_address AS "walletAddress",t.token_address AS "tokenAddress",k.display_name AS "kolName",
      t.side,t.timestamp,t.block_number::text AS "blockNumber",t.block_hash AS "blockHash",t.transaction_index AS "transactionIndex"
      FROM trades t JOIN published_kols k ON k.address=t.wallet_address WHERE k.is_tracked AND ${nonStockTokenSql('t.token_address')} AND t.block_number IS NOT NULL AND t.timestamp>now()-interval '48 hours'
      AND t.block_number<=COALESCE((SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node'),0)
      ORDER BY t.block_number,t.transaction_index NULLS FIRST,t.id`);
    const history = new Map<string, ObservedTrade[]>(), cooldown = new Map<string, string>();
    const candidates: Record<string, unknown>[] = [];
    for (const row of rows.rows) {
      const trade: ObservedTrade = { ...row, timestamp: new Date(row.timestamp).toISOString() };
      const tokenHistory = history.get(trade.tokenAddress) || []; tokenHistory.push(trade); history.set(trade.tokenAddress, tokenHistory);
      if (Date.now() - Date.parse(trade.timestamp) > 86400_000) continue;
      for (const signal of detectSignals(trade, tokenHistory, defaultSignalSettings)) {
        const key = `${signal.kind}:${signal.entity}`;
        if (!cooldownAllows(cooldown.get(key) ?? null, signal.timestamp)) continue;
        cooldown.set(key, signal.timestamp);
        candidates.push({ id: signal.id, kind: signal.kind, entity: signal.entity, token: trade.tokenAddress, wallets: signal.wallets,
          evidence: signal.evidence.map(evidence), timestamp: signal.timestamp, block: trade.blockNumber, hash: trade.blockHash });
      }
    }
    for (let offset = 0; offset < candidates.length; offset += 200) await client.query(`INSERT INTO radar_signals(id,kind,entity,token_address,wallet_addresses,evidence,window_minutes,min_buyers,timestamp,source_block,source_hash,live)
      SELECT id,kind,entity,token,wallets,evidence,$2,$3,timestamp,block,hash,false FROM jsonb_to_recordset($1::jsonb)
      AS r(id text,kind text,entity text,token text,wallets text[],evidence jsonb,timestamp timestamptz,block bigint,hash text) ON CONFLICT(id) DO NOTHING`,
    [JSON.stringify(candidates.slice(offset, offset + 200)), defaultSignalSettings.windowMinutes, defaultSignalSettings.minBuyers]);
    await client.query('UPDATE radar_profiles SET backfilled_at=now() WHERE profile=$1', [profile.profile]);
    if (profile.profile === '10:3') await client.query(`UPDATE trades SET intelligence_processed=true WHERE NOT intelligence_processed AND NOT observed_live AND block_number IS NOT NULL AND timestamp>now()-interval '24 hours'
      AND block_number<=COALESCE((SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node'),0)`);
    await client.query('COMMIT');
    if (candidates.length) await notifyUpdate();
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function collectPositions() {
  const node = await pool.query(`SELECT (value->>'blockNumber')::bigint AS height,value->>'blockHash' AS hash FROM worker_state WHERE key='node'`);
  if (!node.rows[0]?.height) return;
  const height = Number(node.rows[0].height);
  const block = await chainRpc<Block>('eth_getBlockByNumber', [blockHex(height), false]);
  if (Date.now() - Number(BigInt(block.timestamp)) * 1000 > 300_000) return;
  const pairs = await pool.query(`WITH candidates AS (
    SELECT wallet_address,token_address,MAX(timestamp) AS last_seen FROM trades WHERE block_number IS NOT NULL GROUP BY wallet_address,token_address
    UNION ALL SELECT wallet_address,token_address,MAX(timestamp) FROM wallet_transfers GROUP BY wallet_address,token_address
  ), grouped AS (SELECT wallet_address,token_address,MAX(last_seen) AS last_seen FROM candidates GROUP BY wallet_address,token_address)
  SELECT p.wallet_address,p.token_address,s.block_number,s.checked_at,v.decimals FROM grouped p
    JOIN kols k ON k.address=p.wallet_address AND k.is_tracked JOIN tokens v ON v.address=p.token_address
    LEFT JOIN LATERAL(SELECT * FROM position_snapshots WHERE wallet_address=p.wallet_address AND token_address=p.token_address ORDER BY block_number DESC LIMIT 1) s ON true
    WHERE (s.checked_at IS NULL OR s.checked_at<now()-interval '60 seconds' OR EXISTS(SELECT 1 FROM wallet_transfers m
      WHERE m.wallet_address=p.wallet_address AND m.token_address=p.token_address AND m.block_number>s.block_number AND m.block_number<=$1)) AND (
      p.last_seen>now()-interval '24 hours' OR s.balance_raw>0 OR EXISTS(SELECT 1 FROM active_watch_entries WHERE address IN(p.wallet_address,p.token_address)))
    ORDER BY CASE WHEN EXISTS(SELECT 1 FROM wallet_transfers m WHERE m.wallet_address=p.wallet_address AND m.token_address=p.token_address AND m.block_number>s.block_number AND m.block_number<=$1) THEN 0
      WHEN EXISTS(SELECT 1 FROM active_watch_entries WHERE address IN(p.wallet_address,p.token_address)) THEN 1 ELSE 2 END,
      s.checked_at ASC NULLS FIRST,p.last_seen DESC LIMIT 128`, [height]);
  for (let offset = 0; offset < pairs.rows.length; offset += 4) {
    await Promise.all(pairs.rows.slice(offset, offset + 4).map(async row => {
      const previous = await pool.query(`SELECT * FROM position_snapshots WHERE wallet_address=$1 AND token_address=$2 AND block_number<$3 AND NOT error ORDER BY block_number DESC LIMIT 1`, [row.wallet_address, row.token_address, height]);
      const baseline = previous.rows[0];
      const movements = baseline ? await pool.query(`SELECT kind,delta_raw,timestamp FROM wallet_transfers WHERE wallet_address=$1 AND token_address=$2 AND block_number>$3 AND block_number<=$4 ORDER BY block_number,log_index`, [row.wallet_address, row.token_address, baseline.block_number, height]) : { rows: [] };
      let balance: bigint | null = null;
      let status = 'Unknown';
      let failed = false;
      try {
        const raw = await chainRpc<string>('eth_call', [{ to: row.token_address, data: `0x70a08231${row.wallet_address.slice(2).padStart(64, '0')}` }, blockHex(height)]);
        if (!/^0x[0-9a-f]{64}$/i.test(raw)) throw new Error('Invalid balance response');
        balance = BigInt(raw);
        status = classifyPosition(baseline?.balance_raw != null ? BigInt(baseline.balance_raw) : null, balance,
          movements.rows.map(movement => ({ kind: movement.kind, delta: BigInt(movement.delta_raw) })) as PositionMovement[], baseline?.status);
      } catch { failed = true; }
      const lastMovement = movements.rows.at(-1)?.timestamp ?? baseline?.last_movement_at ?? null;
      // A reorganization may have happened while RPC was in flight.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock_shared(782319)');
        await client.query(`INSERT INTO position_snapshots(wallet_address,token_address,block_number,block_hash,balance_raw,status,last_movement_at,error,block_timestamp)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9) WHERE EXISTS(SELECT 1 FROM processed_blocks WHERE block_number=$3 AND lower(block_hash)=lower($4))
        ON CONFLICT(wallet_address,token_address,block_number) DO UPDATE SET balance_raw=EXCLUDED.balance_raw,status=EXCLUDED.status,checked_at=now(),last_movement_at=EXCLUDED.last_movement_at,error=EXCLUDED.error,block_timestamp=EXCLUDED.block_timestamp`,
      [row.wallet_address, row.token_address, height, block.hash, balance?.toString() ?? null, status, lastMovement, failed, Number(BigInt(block.timestamp))]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }));
  }
  if (pairs.rows.length) { await setState('positions', { checkedAt: new Date().toISOString(), checked: pairs.rows.length }); await notifyUpdate(); }
}

export async function intelligenceLoop() {
  await Promise.all(([['radar', collectSignals], ['positions', collectPositions],
    ['position_retention', () => prunePositionSnapshots(pool)]] as const).map(async ([name, collect]) => {
    for (;;) {
      try { await collect(); }
      catch (error) { console.error(`Intelligence ${name}:`, error instanceof Error ? error.message : 'Unavailable'); await setState(`intelligence_${name}_error`, { at: new Date().toISOString() }); }
      await wait(5000);
    }
  }));
}
