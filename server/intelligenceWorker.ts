import type { PoolClient } from 'pg';
import { pool, notifyUpdate, setState } from './db.js';
import { defaultPreferences, type AlertPreferences, type SignalEvidence } from '../shared/intelligence.js';
import { classifyPosition, compareTrades, cooldownAllows, detectSignals, profileKey, signalId, type ObservedTrade, type PositionMovement } from './intelligenceLogic.js';
import { blockHex, chainRpc } from './rpc.js';
import { decodeFlapState, decodeFourState, flapInterface, fourInterface, FOUR_HELPER, FOUR_MANAGERS, FLAP_PORTAL, graduationPool, migrationPair, pairInterface, PCS_V2_FACTORY, WBNB, launchEventTopics, launchTransition, parseLaunchLog } from './launchpad.js';
import { transferTopic } from './swap.js';

type ChainLog = { address: string; topics: string[]; data: string; transactionHash: string; logIndex?: string; blockNumber?: string; blockHash?: string; removed?: boolean };
type Block = { number: string; hash: string; timestamp: string };
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const normalized = (value: string) => value.toLowerCase();
const evidence = (trade: ObservedTrade): SignalEvidence => ({ id: trade.id, txHash: trade.txHash, walletAddress: trade.walletAddress,
  kolName: trade.kolName, side: trade.side, timestamp: trade.timestamp, blockNumber: trade.blockNumber, blockHash: trade.blockHash });

export async function recordWalletTransfers(tx: { hash: string; from: string }, receipt: { logs: ChainLog[] }, block: Block, wallets: Set<string>) {
  const logs = receipt.logs.filter(log => log.topics[0]?.toLowerCase() === transferTopic && log.topics.length === 3 && /^0x[0-9a-f]{64}$/i.test(log.data));
  if (!logs.length) return;
  const known = await pool.query(`SELECT address FROM tokens v WHERE address=ANY($1::text[]) AND EXISTS(SELECT 1 FROM trades WHERE token_address=v.address AND block_number IS NOT NULL)`, [[...new Set(logs.map(log => normalized(log.address)))]]);
  const tokens = new Set<string>(known.rows.map(row => row.address));
  const trades = await pool.query('SELECT wallet_address,token_address,side FROM trades WHERE tx_hash=$1 AND block_number IS NOT NULL', [normalized(tx.hash)]);
  const sides = new Map(trades.rows.map(row => [`${row.wallet_address}:${row.token_address}`, row.side]));
  for (let index = 0; index < receipt.logs.length; index++) {
    const log = receipt.logs[index];
    if (!logs.includes(log) || !tokens.has(normalized(log.address))) continue;
    const from = `0x${log.topics[1].slice(-40)}`.toLowerCase();
    const to = `0x${log.topics[2].slice(-40)}`.toLowerCase();
    if (from === to) continue;
    for (const [wallet, sign] of [[from, -1n], [to, 1n]] as const) {
      if (!wallets.has(wallet)) continue;
      const token = normalized(log.address);
      const side = sides.get(`${wallet}:${token}`);
      const kind = normalized(tx.from) === wallet && ['buy', 'sell'].includes(side) ? side : 'transfer';
      const logIndex = log.logIndex ? Number(BigInt(log.logIndex)) : index;
      await pool.query(`INSERT INTO wallet_transfers(id,tx_hash,log_index,wallet_address,token_address,delta_raw,kind,block_number,block_hash,timestamp)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10)) ON CONFLICT(id) DO NOTHING`,
      [`${normalized(tx.hash)}:${logIndex}:${wallet}`, normalized(tx.hash), logIndex, wallet, token, (BigInt(log.data) * sign).toString(), kind, Number(BigInt(block.number)), block.hash, Number(BigInt(block.timestamp))]);
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
  await client.query('DELETE FROM launch_observations WHERE block_number >= $1', [from]);
  await client.query('DELETE FROM liquidity_observations WHERE block_number >= $1', [from]);
  await client.query(`UPDATE token_launches SET stage='unavailable',progress=NULL,launched_at=NULL,graduated_at=NULL,graduation_tx_hash=NULL,
    pool_address=NULL,pool_id=NULL,migrator_type=NULL,block_number=NULL,block_hash=NULL,checked_at=NULL,
    first_kol_at=NULL,liquidity_usd=NULL,liquidity_baseline_usd=NULL,liquidity_baseline_at=NULL,liquidity_at=NULL WHERE block_number >= $1`, [from]);
}

export async function collectSignals() {
  await backfillSignalProfile();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(782319)');
    await client.query(`UPDATE trades SET intelligence_processed=true WHERE NOT intelligence_processed AND block_number IS NOT NULL AND timestamp<=now()-interval '24 hours'`);
    const rows = await client.query(`SELECT t.id,t.tx_hash AS "txHash",t.wallet_address AS "walletAddress",t.token_address AS "tokenAddress",k.display_name AS "kolName",
      t.side,t.timestamp,t.block_number::text AS "blockNumber",t.block_hash AS "blockHash",t.transaction_index AS "transactionIndex",t.observed_live AS "observedLive"
      FROM trades t JOIN kols k ON k.address=t.wallet_address
      WHERE k.is_tracked AND NOT t.intelligence_processed AND t.block_number IS NOT NULL AND t.timestamp > now()-interval '24 hours'
      AND t.block_number <= COALESCE((SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node'),0)
      ORDER BY t.block_number,t.transaction_index NULLS FIRST,t.id LIMIT 200 FOR SHARE OF t`);
    if (!rows.rows.length) { await client.query('COMMIT'); return; }
    const trades: ObservedTrade[] = rows.rows.map(row => ({ ...row, timestamp: new Date(row.timestamp).toISOString() }));
    const earliest = Math.min(...trades.map(trade => Date.parse(trade.timestamp))) - 86400_000;
    const historyRows = await client.query(`SELECT t.id,t.tx_hash AS "txHash",t.wallet_address AS "walletAddress",t.token_address AS "tokenAddress",k.display_name AS "kolName",
      t.side,t.timestamp,t.block_number::text AS "blockNumber",t.block_hash AS "blockHash",t.transaction_index AS "transactionIndex"
      FROM trades t JOIN kols k ON k.address=t.wallet_address WHERE k.is_tracked AND t.block_number IS NOT NULL AND t.token_address=ANY($1::text[]) AND t.timestamp >= $2
      AND t.block_number <= $3 ORDER BY t.block_number,t.transaction_index NULLS FIRST,t.id`,
    [[...new Set(trades.map(trade => trade.tokenAddress))], new Date(earliest).toISOString(), trades.at(-1)!.blockNumber]);
    const history: ObservedTrade[] = historyRows.rows.map(row => ({ ...row, timestamp: new Date(row.timestamp).toISOString() }));
    const settings = await client.query(`SELECT DISTINCT preferences->>'windowMinutes' AS window, preferences->>'minBuyers' AS buyers FROM watch_sessions WHERE expires_at>now()`);
    const profiles = new Map([[profileKey(defaultPreferences), defaultPreferences]]);
    for (const row of settings.rows) {
      const preference = { ...defaultPreferences, windowMinutes: Number(row.window) as AlertPreferences['windowMinutes'], minBuyers: Number(row.buyers) };
      profiles.set(profileKey(preference), preference);
    }
    let inserted = 0;
    for (const trade of trades.sort(compareTrades)) {
      for (const profile of profiles.values()) {
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
    const pending = await client.query('SELECT * FROM radar_profiles WHERE backfilled_at IS NULL ORDER BY profile LIMIT 1 FOR UPDATE SKIP LOCKED');
    const profile = pending.rows[0];
    if (!profile) { await client.query('COMMIT'); return; }
    const rows = await client.query(`SELECT t.id,t.tx_hash AS "txHash",t.wallet_address AS "walletAddress",t.token_address AS "tokenAddress",k.display_name AS "kolName",
      t.side,t.timestamp,t.block_number::text AS "blockNumber",t.block_hash AS "blockHash",t.transaction_index AS "transactionIndex"
      FROM trades t JOIN kols k ON k.address=t.wallet_address WHERE k.is_tracked AND t.block_number IS NOT NULL AND t.timestamp>now()-interval '48 hours'
      AND t.block_number<=COALESCE((SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node'),0)
      ORDER BY t.block_number,t.transaction_index NULLS FIRST,t.id`);
    const history = new Map<string, ObservedTrade[]>(), cooldown = new Map<string, string>();
    const preferences = { ...defaultPreferences, windowMinutes: profile.window_minutes, minBuyers: profile.min_buyers };
    const candidates: Record<string, unknown>[] = [];
    for (const row of rows.rows) {
      const trade: ObservedTrade = { ...row, timestamp: new Date(row.timestamp).toISOString() };
      const tokenHistory = history.get(trade.tokenAddress) || []; tokenHistory.push(trade); history.set(trade.tokenAddress, tokenHistory);
      if (Date.now() - Date.parse(trade.timestamp) > 86400_000) continue;
      for (const signal of detectSignals(trade, tokenHistory, preferences)) {
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
    [JSON.stringify(candidates.slice(offset, offset + 200)), profile.window_minutes, profile.min_buyers]);
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
      p.last_seen>now()-interval '24 hours' OR s.balance_raw>0 OR EXISTS(SELECT 1 FROM watch_entries WHERE address IN(p.wallet_address,p.token_address)))
    ORDER BY CASE WHEN EXISTS(SELECT 1 FROM wallet_transfers m WHERE m.wallet_address=p.wallet_address AND m.token_address=p.token_address AND m.block_number>s.block_number AND m.block_number<=$1) THEN 0
      WHEN EXISTS(SELECT 1 FROM watch_entries WHERE address IN(p.wallet_address,p.token_address)) THEN 1 ELSE 2 END,
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

async function lookupLaunch(token: string, height: number) {
  const four = await chainRpc<string>('eth_call', [{ to: FOUR_HELPER, data: fourInterface.encodeFunctionData('getTokenInfo', [token]) }, blockHex(height)]).then(decodeFourState).catch(() => null);
  if (four) return four;
  for (const method of ['getTokenV8Safe', 'getTokenV7'] as const) {
    try {
      const raw = await chainRpc<string>('eth_call', [{ to: FLAP_PORTAL, data: flapInterface.encodeFunctionData(method, [token]) }, blockHex(height)]);
      return decodeFlapState(raw, method);
    } catch { /* Try the legacy supported interface, otherwise leave this token unavailable. */ }
  }
  return null;
}

export async function collectLaunches() {
  const node = await pool.query(`SELECT (value->>'blockNumber')::bigint AS height FROM worker_state WHERE key='node'`);
  if (!node.rows[0]?.height) return;
  const height = Number(node.rows[0].height);
  const block = await chainRpc<Block>('eth_getBlockByNumber', [blockHex(height), false]);
  if (Date.now() - Number(BigInt(block.timestamp)) * 1000 > 300_000) return;
  const candidates = await pool.query(`SELECT v.address,l.* FROM tokens v LEFT JOIN token_launches l ON l.token_address=v.address
    WHERE EXISTS(SELECT 1 FROM trades t JOIN kols k ON k.address=t.wallet_address WHERE k.is_tracked AND token_address=v.address AND block_number IS NOT NULL)
    AND (l.checked_at IS NULL OR l.checked_at<now()-CASE WHEN l.platform IS NULL THEN interval '1 hour' ELSE interval '60 seconds' END)
    ORDER BY CASE WHEN EXISTS(SELECT 1 FROM launch_events e WHERE e.token_address=v.address AND e.block_number>COALESCE(l.block_number,0) AND e.kind IN('graduated','pool')) THEN 0
      WHEN EXISTS(SELECT 1 FROM watch_entries w WHERE w.kind='token' AND w.address=v.address) THEN 1
      WHEN l.checked_at IS NULL AND EXISTS(SELECT 1 FROM trades WHERE token_address=v.address AND timestamp>now()-interval '5 minutes' AND block_number IS NOT NULL) THEN 2
      WHEN l.stage='near_graduation' THEN 3
      WHEN l.stage='bonding' AND EXISTS(SELECT 1 FROM trades WHERE token_address=v.address AND timestamp>now()-interval '24 hours' AND block_number IS NOT NULL) THEN 4
      WHEN EXISTS(SELECT 1 FROM trades WHERE token_address=v.address AND timestamp>now()-interval '24 hours' AND block_number IS NOT NULL) THEN 5 ELSE 6 END,
      l.checked_at ASC NULLS FIRST,(SELECT MAX(timestamp) FROM trades WHERE token_address=v.address AND block_number IS NOT NULL) DESC LIMIT 8`);
  for (const previous of candidates.rows) {
    const token = previous.address;
    const state = await lookupLaunch(token, height);
    const client = await pool.connect();
    try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(782319)');
    const canonical = await client.query('SELECT 1 FROM processed_blocks WHERE block_number=$1 AND lower(block_hash)=lower($2)', [height, block.hash]);
    if (!canonical.rowCount) { await client.query('ROLLBACK'); continue; }
    const events = await client.query('SELECT * FROM launch_events WHERE token_address=$1 AND block_number<=$2 ORDER BY block_number DESC', [token, height]);
    const created = events.rows.find(row => row.kind === 'created');
    const graduated = events.rows.find(row => row.kind === 'graduated') ?? (state?.stage === 'graduated' ? events.rows.find(row => row.kind === 'stopped') : undefined);
    const poolEvent = events.rows.find(row => row.kind === 'pool');
    const migrator = events.rows.find(row => row.kind === 'migrator')?.details?.migratorType ?? previous.migrator_type ?? null;
    const poolId = poolEvent?.details?.poolId ?? previous.pool_id ?? null;
    let poolAddress: string | null = state?.poolAddress ?? graduated?.details?.pool ?? previous.pool_address ?? null;
    if (state?.platform === 'flap' && poolAddress && !poolId && migrator == null) {
      // Verify a conventional pair before using a pool-shaped field from Flap.
      try {
        const constituents = await Promise.all(['0x0dfe1681', '0xd21220a7'].map(data => chainRpc<string>('eth_call', [{ to: poolAddress, data }, blockHex(height)])));
        if (!constituents.some(raw => /^0x[0-9a-f]{64}$/i.test(raw) && `0x${raw.slice(-40)}`.toLowerCase() === token)) poolAddress = null;
      } catch { poolAddress = null; }
    }
    if (poolId || migrator === 2 || migrator === 3) poolAddress = null;
    if (state?.platform === 'fourmeme' && state.stage === 'graduated' && !poolAddress) {
      const quote = state.quoteAddress || WBNB;
      try {
        if (graduated?.tx_hash) {
          const receipt = await chainRpc<{ blockHash: string; logs: ChainLog[] }>('eth_getTransactionReceipt', [graduated.tx_hash]);
          if (receipt.blockHash.toLowerCase() === graduated.block_hash.toLowerCase()) poolAddress = migrationPair(receipt.logs, token, quote);
        }
        if (!poolAddress) {
          const raw = await chainRpc<string>('eth_call', [{ to: PCS_V2_FACTORY, data: pairInterface.encodeFunctionData('getPair', [token, quote]) }, blockHex(height)]);
          const pair = String(pairInterface.decodeFunctionResult('getPair', raw)[0]).toLowerCase();
          if (pair !== '0x0000000000000000000000000000000000000000') poolAddress = pair;
        }
      } catch { /* No verified migration destination yet. */ }
    }
    const first = await client.query(`SELECT MIN(timestamp) AS at FROM trades t JOIN kols k ON k.address=t.wallet_address WHERE k.is_tracked AND token_address=$1 AND side='buy' AND block_number IS NOT NULL AND block_number<=$2`, [token, height]);
    const stage = state?.stage ?? (graduated ? 'graduated' : 'unavailable');
    const saved = await client.query(`INSERT INTO token_launches(token_address,platform,stage,progress,launched_at,first_kol_at,graduated_at,graduation_tx_hash,
      quote_address,pool_address,pool_id,migrator_type,block_number,block_hash,checked_at)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now()
      WHERE EXISTS(SELECT 1 FROM processed_blocks WHERE block_number=$13 AND lower(block_hash)=lower($14))
      ON CONFLICT(token_address) DO UPDATE SET platform=EXCLUDED.platform,stage=EXCLUDED.stage,progress=EXCLUDED.progress,
      launched_at=COALESCE(EXCLUDED.launched_at,token_launches.launched_at),first_kol_at=EXCLUDED.first_kol_at,
      graduated_at=EXCLUDED.graduated_at,graduation_tx_hash=EXCLUDED.graduation_tx_hash,
      quote_address=EXCLUDED.quote_address,pool_address=EXCLUDED.pool_address,pool_id=EXCLUDED.pool_id,migrator_type=EXCLUDED.migrator_type,
      block_number=EXCLUDED.block_number,block_hash=EXCLUDED.block_hash,checked_at=now() RETURNING token_address`,
    [token, state?.platform ?? previous.platform ?? graduated?.platform ?? created?.platform ?? null, stage, state?.progress ?? null, state?.launchedAt ?? created?.details?.launchedAt ?? created?.timestamp ?? previous.launched_at ?? null,
      first.rows[0]?.at ?? null, graduated?.timestamp ?? previous.graduated_at ?? null, graduated?.tx_hash ?? previous.graduation_tx_hash ?? null,
      state?.quoteAddress ?? null, poolAddress, poolId, migrator, height, block.hash]);
    if (!saved.rowCount) { await client.query('ROLLBACK'); continue; }
    await client.query(`INSERT INTO launch_observations(token_address,block_number,block_hash,platform,stage,progress)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(token_address,block_number) DO NOTHING`,
    [token, height, block.hash, state?.platform ?? previous.platform ?? graduated?.platform ?? created?.platform ?? null, stage, state?.progress ?? null]);
    const transition = launchTransition(previous.stage ?? null, stage);
    if (transition) {
      const participants = await client.query(`SELECT DISTINCT wallet_address FROM trades t JOIN kols k ON k.address=t.wallet_address WHERE k.is_tracked AND token_address=$1 AND block_number IS NOT NULL AND block_number<=$2`, [token, height]);
      const milestone = transition === 'graduated' ? graduated : null;
      const timestamp = milestone?.timestamp ? new Date(milestone.timestamp).toISOString() : new Date(Number(BigInt(block.timestamp)) * 1000).toISOString();
      const sourceHeight = milestone?.block_number ?? height;
      const sourceHash = milestone?.block_hash ?? block.hash;
      const live = Boolean(previous.checked_at && Date.now() - new Date(previous.checked_at).getTime() <= 300_000 && Date.now() - Date.parse(timestamp) <= 300_000);
      const source: SignalEvidence = { id: `${token}:${sourceHeight}`, txHash: milestone?.tx_hash ?? '', walletAddress: '', kolName: null, side: 'state', timestamp, blockNumber: String(sourceHeight), blockHash: sourceHash };
      await client.query(`INSERT INTO radar_signals(id,kind,entity,token_address,wallet_addresses,evidence,window_minutes,min_buyers,timestamp,source_block,source_hash,live)
        SELECT $1,$2,$3,$3,$4,$5::jsonb,0,0,$6,$7,$8,$9 WHERE EXISTS(SELECT 1 FROM processed_blocks WHERE block_number=$10 AND lower(block_hash)=lower($11))
        AND NOT EXISTS(SELECT 1 FROM radar_signals WHERE entity=$3 AND kind=$2 AND NOT corrected AND timestamp>$6::timestamptz-interval '10 minutes' AND timestamp<=$6)
        ON CONFLICT(id) DO NOTHING`,
      [signalId(transition, token, `${sourceHeight}:${sourceHash}`, 'launch'), transition, token, participants.rows.map(row => row.wallet_address), JSON.stringify([source]), timestamp, sourceHeight, sourceHash, live, height, block.hash]);
    }
    const identifier = graduationPool(poolAddress, poolId, migrator);
    if (stage === 'graduated' && identifier && (!previous.liquidity_at || Date.now() - new Date(previous.liquidity_at).getTime() >= 120_000)) {
      try {
        const response = await fetch(`https://api.dexscreener.com/latest/dex/pairs/bsc/${identifier}`, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error('Liquidity provider unavailable');
        const body = await response.json() as { pairs?: { chainId: string; pairAddress: string; baseToken: { address: string }; quoteToken: { address: string }; liquidity?: { usd?: number } }[] };
        const pair = body.pairs?.find(row => row.chainId === 'bsc' && row.pairAddress.toLowerCase() === identifier.toLowerCase() && [row.baseToken.address.toLowerCase(), row.quoteToken.address.toLowerCase()].includes(token));
        const liquidity = pair?.liquidity?.usd;
        if (typeof liquidity === 'number' && Number.isFinite(liquidity) && liquidity >= 0) {
          await client.query('INSERT INTO liquidity_observations(token_address,liquidity_usd,pool_identifier,block_number,block_hash) VALUES($1,$2,$3,$4,$5)', [token, liquidity, identifier, height, block.hash]);
          await client.query(`UPDATE token_launches SET liquidity_usd=$2,liquidity_at=now(),liquidity_baseline_usd=COALESCE(liquidity_baseline_usd,$2),
            liquidity_baseline_at=COALESCE(liquidity_baseline_at,now()) WHERE token_address=$1 AND block_number=$3 AND block_hash=$4`, [token, liquidity, height, block.hash]);
        }
      } catch { /* Keep the timestamped prior observation while the provider is unavailable. */ }
    }
    await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  if (candidates.rows.length) { await setState('launches', { checkedAt: new Date().toISOString(), checked: candidates.rows.length }); await notifyUpdate(); }
}

export async function intelligenceLoop() {
  await Promise.all(([['radar', collectSignals], ['positions', collectPositions], ['launches', collectLaunches]] as const).map(async ([name, collect]) => {
    for (;;) {
      try { await collect(); }
      catch (error) { console.error(`Intelligence ${name}:`, error instanceof Error ? error.message : 'Unavailable'); await setState(`intelligence_${name}_error`, { at: new Date().toISOString() }); }
      await wait(5000);
    }
  }));
}
