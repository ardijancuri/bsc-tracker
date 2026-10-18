import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { pool } from './db.js';
import { gmgnApiKey, gmgnRequest, GmgnHttpError, type GmgnRequestOptions } from './gmgnApi.js';
import { MarketProviderDeferred } from './geckoApi.js';
import { isKolProfileToken } from './kolProfileToken.js';

const address = /^0x[0-9a-f]{40}$/;
const hash = /^0x[0-9a-f]{64}$/;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Normalize scientific JSON numbers without rounding decimal-string quantities. */
export function journalDecimal(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value), match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(raw);
  if (!match || raw.length > 160) return null;
  const digits = match[1] + (match[2] ?? ''), exponent = Number(match[3] ?? 0), point = match[1].length + exponent;
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 80) return null;
  const expanded = point <= 0 ? `0.${'0'.repeat(-point)}${digits}` : point >= digits.length ? digits + '0'.repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
  const [whole, fraction = ''] = expanded.split('.');
  return `${whole.replace(/^0+(?=\d)/, '')}${fraction.replace(/0+$/, '') ? '.' + fraction.replace(/0+$/, '') : ''}`;
}
export function sumJournalDecimals(values: string[]) {
  if (!values.length) return '0';
  const scale = Math.max(...values.map(value => value.split('.')[1]?.length ?? 0));
  const integer = values.reduce((total, value) => { const [a, b = ''] = value.split('.'); return total + BigInt(a + b.padEnd(scale, '0')); }, 0n);
  const digits = integer.toString().padStart(scale + 1, '0');
  return journalDecimal(scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits)!;
}
export interface JournalProviderMovement {
  eventKey: string; walletAddress: string; tokenAddress: string; kind: 'buy' | 'sell' | 'transfer_in' | 'transfer_out';
  txHash: string; timestamp: string; tokenAmount: string; amountUsd: string | null; feeUsd: string | null;
  quoteAmount: string | null; quoteSymbol: string | null; counterparty: string | null; evidenceHash: string;
  token: { address: string; symbol: string | null; name: string | null; decimals: number | null };
}
export function parseJournalHistoryRows(input: unknown, wallet: string, now: number): JournalProviderMovement[] {
  if (!Array.isArray(input) || input.length > 50) throw Error('provider_history_invalid');
  const seen = new Map<string, JournalProviderMovement>();
  for (const raw of input) {
    const tokenAddress = String(raw?.token?.address ?? '').toLowerCase();
    const txHash = String(raw?.tx_hash ?? '').toLowerCase(), kindText = String(raw?.event_type ?? raw?.type ?? '').replace(/[_-]/g, '').toLowerCase();
    const kind = kindText === 'buy' || kindText === 'sell' ? kindText : kindText === 'transferin' ? 'transfer_in' : kindText === 'transferout' ? 'transfer_out' : null;
    const timestamp = Number(raw?.timestamp), tokenAmount = journalDecimal(raw?.token_amount);
    if (!address.test(tokenAddress) || !hash.test(txHash) || !kind || !tokenAmount || /^0(?:\.0*)?$/.test(tokenAmount)
      || !Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp * 1000 > now
      || String(raw?.wallet ?? wallet).toLowerCase() !== wallet || (raw?.chain ?? 'bsc') !== 'bsc') throw Error('provider_history_invalid');
    const symbol = typeof raw.token.symbol === 'string' ? raw.token.symbol.slice(0, 80) : null;
    const name = typeof raw.token.name === 'string' ? raw.token.name.slice(0, 160) : null;
    if (!isKolProfileToken({ address: tokenAddress, symbol, name })) continue;
    const reportedAmount = journalDecimal(raw.cost_usd);
    // Provider zero acquisition/receipt marks mean no observed valuation; they
    // are not proof that a positive quantity had a free purchase basis.
    const amountUsd = reportedAmount === '0' && ['buy', 'transfer_in', 'transfer_out'].includes(kind) ? null : reportedAmount;
    const gas = journalDecimal(raw.gas_usd), dex = journalDecimal(raw.dex_usd);
    const priority = journalDecimal(raw.priority_fee), tip = journalDecimal(raw.tip_fee);
    const feeUsd = gas !== null && dex !== null && priority === '0' && tip === '0' ? sumJournalDecimals([gas, dex]) : null;
    const counterpartyRaw = kind === 'transfer_in' ? raw.from_address ?? raw.from : kind === 'transfer_out' ? raw.to_address ?? raw.to : null;
    const counterparty = typeof counterpartyRaw === 'string' && address.test(counterpartyRaw.toLowerCase()) ? counterpartyRaw.toLowerCase() : null;
    const decimals = Number(raw.token.decimals);
    const operation = raw.event_id ?? raw.id ?? raw.event_index ?? raw.log_index;
    const operationId = typeof operation === 'string' || typeof operation === 'number' ? String(operation) : null;
    if (operationId !== null && (!/^[A-Za-z0-9:_-]{1,160}$/.test(operationId))) throw Error('provider_execution_identity_ambiguous');
    const eventKey = `${txHash}:${tokenAddress}:${kind}${operationId === null ? '' : ':' + operationId}`;
    const value: JournalProviderMovement = { eventKey, walletAddress: wallet, tokenAddress, kind, txHash,
      timestamp: new Date(timestamp * 1000).toISOString(), tokenAmount, amountUsd, feeUsd,
      quoteAmount: journalDecimal(raw.quote_amount), quoteSymbol: typeof raw.quote_symbol === 'string' ? raw.quote_symbol.slice(0, 32) : null,
      counterparty, evidenceHash: '', token: { address: tokenAddress, symbol, name,
        decimals: raw.token.decimals != null && Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : null } };
    const { token: _metadata, evidenceHash: _previousHash, ...financialEvidence } = value;
    value.evidenceHash = digest(financialEvidence);
    const previous = seen.get(eventKey);
    if (previous && (previous.evidenceHash !== value.evidenceHash || operationId === null)) throw Error('provider_execution_identity_ambiguous');
    seen.set(eventKey, value);
  }
  return [...seen.values()];
}
export interface JournalHistoryState { status: 'pending' | 'ready' | 'cooldown' | 'unavailable'; complete: boolean; coveredTo: string | null; reason?: string; retryAfterMs?: number }
type Requester = (url: URL, options: GmgnRequestOptions) => Promise<any>;
/** Durable provider pages are shared by every account, but contain no private labels. */
export function createJournalHistory({ db = pool, request = gmgnRequest, now = Date.now }: { db?: Pool; request?: Requester; now?: () => number } = {}) {
  const jobs = new Map<string, { foreground: boolean; work: Promise<JournalHistoryState> }>();
  return async (wallet: string, token: string | null, from: string, foreground = false): Promise<JournalHistoryState> => {
    if (!address.test(wallet) || token !== null && !address.test(token) || !Number.isFinite(Date.parse(from))) throw Error('journal_history_request_invalid');
    const scope = token ?? 'all', key = `${wallet}:${scope}`;
    const pending = jobs.get(key); if (pending) { if (foreground) pending.foreground = true; return pending.work; }
    const job = { foreground, work: null as unknown as Promise<JournalHistoryState> };
    const work = (async (): Promise<JournalHistoryState> => {
      const lease = randomUUID(), timestamp = now();
      await db.query(`INSERT INTO journal_history_jobs(wallet_address,scope) VALUES($1,$2) ON CONFLICT DO NOTHING`, [wallet, scope]);
      const previous = (await db.query(`SELECT *,covered_to AS "coveredTo",head_checked_at AS "headCheckedAt" FROM journal_history_jobs WHERE wallet_address=$1 AND scope=$2`, [wallet, scope])).rows[0];
      const enough = !previous.refresh_pending && (previous.complete || previous.coveredTo && Date.parse(previous.coveredTo) <= Date.parse(from));
      if (enough && previous.headCheckedAt && timestamp - Date.parse(previous.headCheckedAt) < 30_000) return { status: 'ready', complete: previous.complete, coveredTo: previous.coveredTo ? new Date(previous.coveredTo).toISOString() : null };
      const retryAt = previous.retry_at ? Date.parse(previous.retry_at) : 0;
      if (retryAt > timestamp) return { status: 'cooldown', complete: previous.complete, coveredTo: previous.coveredTo, reason: previous.error ?? 'provider_cooldown', retryAfterMs: retryAt - timestamp };
      const acquired = await db.query(`UPDATE journal_history_jobs SET lease_id=$3,lease_until=now()+interval '30 seconds',status='pending'
        WHERE wallet_address=$1 AND scope=$2 AND (lease_until IS NULL OR lease_until<now()) RETURNING *`, [wallet, scope, lease]);
      if (!acquired.rowCount) return { status: 'pending', complete: previous.complete, coveredTo: previous.coveredTo, reason: 'history_preparing', retryAfterMs: 1500 };
      try {
        const apiKey = gmgnApiKey('accounting');
        if (!apiKey) throw Error('provider_key_unavailable');
        // Refresh the head without discarding completed history or the older cursor.
        const head = previous.refresh_pending || !previous.headCheckedAt || timestamp - Date.parse(previous.headCheckedAt) >= 30_000;
        const refreshing = head && previous.pages > 0;
        const cursor = previous.refresh_pending ? previous.refresh_cursor : head ? null : previous.cursor;
        const url = new URL('https://openapi.gmgn.ai/v1/user/wallet_activity');
        url.searchParams.set('chain', 'bsc'); url.searchParams.set('wallet', wallet); url.searchParams.set('limit', '50');
        if (token) url.searchParams.set('token', token);
        if (cursor) url.searchParams.set('cursor', cursor);
        const body = await request(url, { apiKey, workload: 'accounting', foreground: () => job.foreground,
          priority: () => job.foreground ? 'chart' : 'prefetch', weight: 3, signal: AbortSignal.timeout(12_000) });
        const data = body?.data ?? body;
        const rows = parseJournalHistoryRows(data?.activities, wallet, timestamp);
        const next = data?.next == null || data?.next === '' ? null : String(data.next);
        if (next && (next.length > 2048 || /[\u0000-\u001f]/.test(next))) throw Error('provider_cursor_invalid');
        if (next && (next === cursor || !head && (previous.cursors ?? []).includes(next))) throw Error('provider_cursor_repeated');
        const client = await db.connect();
        try {
          await client.query('BEGIN');
          // Removal revokes readers and stops further provider work once no account subscribes.
          const subscribed = await client.query('SELECT 1 FROM journal_wallets WHERE wallet_address=$1 LIMIT 1', [wallet]);
          if (!subscribed.rowCount) throw Error('journal_membership_removed');
          let joinsCompletedHistory = !refreshing || next === null;
          for (const row of rows) {
            await client.query(`INSERT INTO tokens(address,symbol,name,decimals) VALUES($1,$2,$3,$4)
              ON CONFLICT(address) DO UPDATE SET symbol=COALESCE(tokens.symbol,EXCLUDED.symbol),name=COALESCE(tokens.name,EXCLUDED.name),decimals=COALESCE(tokens.decimals,EXCLUDED.decimals)`, [row.tokenAddress, row.token.symbol, row.token.name, row.token.decimals]);
            const conflict = await client.query(`SELECT evidence_hash FROM journal_provider_movements WHERE wallet_address=$1 AND event_key=$2`, [wallet, row.eventKey]);
            if (conflict.rows[0] && conflict.rows[0].evidence_hash !== row.evidenceHash) {
              // Provider corrections/enriched fees invalidate derived snapshots;
              // they are then checked against indexed quantities and a new node
              // balance. Keeping the old row forever would make recovery stall.
              await client.query('DELETE FROM journal_pair_preparations WHERE wallet_address=$1 AND token_address=$2', [wallet, row.tokenAddress]);
              await client.query(`DELETE FROM journal_snapshots WHERE user_id IN(SELECT user_id FROM journal_wallets WHERE wallet_address=$1)`, [wallet]);
              await client.query('DELETE FROM journal_replay_snapshots WHERE wallet_address=$1 AND token_address=$2', [wallet, row.tokenAddress]);
            }
            if (conflict.rowCount) joinsCompletedHistory = true;
            await client.query(`INSERT INTO journal_provider_movements(wallet_address,token_address,event_key,kind,tx_hash,timestamp,token_amount,amount_usd,fee_usd,quote_amount,quote_symbol,counterparty,evidence_hash)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(wallet_address,event_key) DO UPDATE SET
                timestamp=EXCLUDED.timestamp,token_amount=EXCLUDED.token_amount,amount_usd=EXCLUDED.amount_usd,fee_usd=EXCLUDED.fee_usd,
                quote_amount=EXCLUDED.quote_amount,quote_symbol=EXCLUDED.quote_symbol,counterparty=EXCLUDED.counterparty,evidence_hash=EXCLUDED.evidence_hash,observed_at=now()
                WHERE journal_provider_movements.evidence_hash<>EXCLUDED.evidence_hash`, [wallet, row.tokenAddress, row.eventKey, row.kind, row.txHash, row.timestamp, row.tokenAmount, row.amountUsd, row.feeUsd, row.quoteAmount, row.quoteSymbol, row.counterparty, row.evidenceHash]);
          }
          // Excluded assets still count toward pagination coverage; filtering
          // them must not make an empty eligible page look like missing history.
          const times = data.activities.map((row: any) => Number(row?.timestamp)).filter((value: number) => Number.isSafeInteger(value) && value > 0 && value * 1000 <= timestamp);
          const oldest = times.length ? new Date(Math.min(...times) * 1000).toISOString() : null;
          // An all-excluded head has no normalized rows to join, but a page
          // ending within the already covered interval still closes that gap.
          if (refreshing && oldest && previous.coveredTo && Date.parse(oldest) <= Date.parse(previous.coveredTo)) joinsCompletedHistory = true;
          const advance = !head || previous.pages === 0;
          await client.query(`UPDATE journal_history_jobs SET cursor=CASE WHEN $4 THEN $5 ELSE cursor END,
            cursors=CASE WHEN $4 AND $5::text IS NOT NULL THEN cursors||jsonb_build_array($5::text) ELSE cursors END,
            complete=CASE WHEN $4 THEN $5::text IS NULL ELSE complete END,
            covered_to=LEAST(covered_to,$6::timestamptz),head_checked_at=CASE WHEN $7 AND $8 THEN now() ELSE head_checked_at END,
            refresh_pending=$7 AND NOT $8,refresh_cursor=CASE WHEN $7 AND NOT $8 THEN $5 ELSE NULL END,
            pages=pages+1,status='ready',retry_at=NULL,error=NULL,lease_id=NULL,lease_until=NULL,updated_at=now()
            WHERE wallet_address=$1 AND scope=$2 AND lease_id=$3`, [wallet, scope, lease, advance, next, oldest, head, joinsCompletedHistory]);
          await client.query('COMMIT');
          const complete = advance ? next === null : previous.complete;
          const coveredTo = oldest && (!previous.coveredTo || Date.parse(oldest) < Date.parse(previous.coveredTo)) ? oldest : previous.coveredTo ? new Date(previous.coveredTo).toISOString() : null;
          const ready = joinsCompletedHistory && (complete || coveredTo && Date.parse(coveredTo) <= Date.parse(from));
          return { status: ready ? 'ready' : 'pending', complete: complete && joinsCompletedHistory, coveredTo,
            ...(!ready ? { reason: 'history_preparing', retryAfterMs: 1500 } : {}) };
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      } catch (error) {
        const reason = error instanceof MarketProviderDeferred ? 'provider_cooldown' : error instanceof GmgnHttpError ? `provider_http_${error.status}`
          : error instanceof Error && /^(provider_|journal_membership_)/.test(error.message) ? error.message : 'provider_unavailable';
        const retryAfterMs = error instanceof MarketProviderDeferred || error instanceof GmgnHttpError ? error.retryAfterMs ?? 5000 : 5000;
        await db.query(`UPDATE journal_history_jobs SET status=$4,error=$5,retry_at=now()+($6::integer*interval '1 millisecond'),lease_id=NULL,lease_until=NULL,updated_at=now()
          WHERE wallet_address=$1 AND scope=$2 AND lease_id=$3`, [wallet, scope, lease, reason === 'provider_cooldown' ? 'cooldown' : 'unavailable', reason, retryAfterMs]);
        return { status: reason === 'provider_cooldown' ? 'cooldown' : 'unavailable', complete: previous.complete, coveredTo: previous.coveredTo, reason, retryAfterMs };
      }
    })().finally(() => jobs.delete(key));
    job.work = work; jobs.set(key, job); return work;
  };
}
export const currentJournalHistory = createJournalHistory();
