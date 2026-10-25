import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Signal } from '../../shared/intelligence.js';
import { compareTrades, cooldownAllows, defaultSignalSettings, detectSignals, type ObservedTrade } from '../intelligenceLogic.js';
import { kolProfileTokenSql } from '../kolProfileToken.js';
import { resolveAuthUser, authSessionSecret } from '../telegramAuth.js';
import { hashSecret, sessionSecret } from '../watchSessionSecrets.js';
import {freshTrackedEventSql} from './tracking.js';

const address = /^0x[a-f0-9]{40}$/i, signalId = /^[a-f0-9]{64}$/i;
const iso = (value: unknown) => value == null ? null : new Date(value as string).toISOString();
type EventRow = ObservedTrade & { tokenSymbol: string | null; tokenName: string | null; tokenLogoUrl: string | null; avatarUrl: string | null; executionIndex: number; logIndex: number | null };
type FeatureOwner = { id: string; kind: 'account' | 'guest' };
function pageLimit(raw: string | undefined) { const value = raw == null ? 20 : Number(raw); if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error('Invalid limit'); return value; }
function cursor(raw: string | undefined): { ts: string; id: string } | null {
  if (raw === undefined) return null;
  if (raw.length > 512) throw new Error('Invalid cursor');
  const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString());
  if (typeof parsed.ts !== 'string' || !Number.isFinite(Date.parse(parsed.ts)) || typeof parsed.id !== 'string' || parsed.id.length > 128) throw new Error('Invalid cursor');
  return parsed;
}
function page<T>(items: T[], count: number, key: (item: T) => { ts: string; id: string }) {
  const selected = items.slice(0, count), last = selected.at(-1);
  return { items: selected, nextCursor: items.length > count && last ? Buffer.from(JSON.stringify(key(last))).toString('base64url') : null };
}

/** Stateless bounded signals. A private wallet can never enter the evidence
 * query, even when its account also follows the public token or KOL. */
export function deriveFreshSignals(rows: EventRow[], visibleFrom: number): Signal[] {
  const byToken = new Map<string, EventRow[]>(), cooldown = new Map<string, string>(), output: Signal[] = [];
  for (const trigger of [...rows].sort(compareTrades)) {
    const history = byToken.get(trigger.tokenAddress) ?? []; history.push(trigger); byToken.set(trigger.tokenAddress, history);
    for (const candidate of detectSignals(trigger, history, defaultSignalSettings)) {
      const key = `${candidate.kind}:${candidate.entity}`, prior = cooldown.get(key);
      if (!cooldownAllows(prior ?? null, candidate.timestamp)) continue;
      cooldown.set(key, candidate.timestamp);
      if (Date.parse(candidate.timestamp) < visibleFrom) continue;
      const publicIdentities = new Map(history.map(row => [row.walletAddress, row]));
      output.push({ id: candidate.id, kind: candidate.kind, tokenAddress: trigger.tokenAddress, tokenSymbol: trigger.tokenSymbol, tokenName: trigger.tokenName, tokenLogoUrl: trigger.tokenLogoUrl,
        walletAddresses: candidate.wallets, kols: candidate.wallets.map(wallet => ({ address: wallet, name: publicIdentities.get(wallet)?.kolName ?? null, avatarUrl: publicIdentities.get(wallet)?.avatarUrl ?? null })),
        windowMinutes: defaultSignalSettings.windowMinutes, minBuyers: defaultSignalSettings.minBuyers, timestamp: candidate.timestamp, publishedAt: candidate.timestamp, corrected: false,
        evidence: candidate.evidence.map(event => ({ id: event.id, txHash: event.txHash, walletAddress: event.walletAddress, kolName: event.kolName, side: event.side, timestamp: event.timestamp, blockNumber: event.blockNumber, blockHash: event.blockHash })) });
    }
  }
  return output.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id));
}

/** Every route is a current-row/compact-ledger adapter. No RPC, accounting scan,
 * market provider, candle store or copied signal-response table is involved. */
export function registerFreshFeatures(app: FastifyInstance, options: { db: Pool; now?: () => number; resolveUser?: typeof resolveAuthUser }) {
  const { db } = options, now = options.now ?? Date.now, resolveUser = options.resolveUser ?? resolveAuthUser;
  async function owner(request: FastifyRequest, reply: FastifyReply): Promise<FeatureOwner | null | undefined> {
    reply.header('Cache-Control', 'private,no-store').header('Vary', 'Cookie');
    const user = await resolveUser(request, db), expected = request.headers['x-watchlist-owner'];
    if (expected !== undefined && expected !== (user?.id ?? 'guest')) { reply.code(409).send({ error: 'Your account changed. Refresh and try again.' }); return undefined; }
    if (user) return { id: user.id, kind: 'account' };
    if (authSessionSecret(request.headers.cookie)) { reply.code(401).send({ error: 'Your session expired. Log in again.' }); return undefined; }
    const secret = sessionSecret(request.headers.cookie); if (!secret) return null;
    const saved = (await db.query('SELECT id FROM watch_sessions WHERE secret_hash=$1 AND expires_at>now()', [hashSecret(secret)])).rows[0];
    return saved ? { id: saved.id, kind: 'guest' } : null;
  }
  async function signals() {
    const end = new Date(now()).toISOString(), from = new Date(now() - 48 * 60 * 60 * 1_000).toISOString(), visibleFrom = now() - 24 * 60 * 60 * 1_000;
    const result = await db.query(`SELECT e.id,e.transaction_hash AS "txHash",e.wallet_address AS "walletAddress",e.token_address AS "tokenAddress",k.display_name AS "kolName",k.avatar_url AS "avatarUrl",
      e.kind AS side,e.occurred_at AS timestamp,e.block_number::text AS "blockNumber",e.block_hash AS "blockHash",e.transaction_index AS "transactionIndex",e.execution_index AS "executionIndex",e.log_index AS "logIndex",e.observed_live AS "observedLive",
      t.symbol AS "tokenSymbol",t.name AS "tokenName",CASE WHEN t.logo_data IS NOT NULL THEN '/api/token-image/'||t.address ELSE t.logo_url END AS "tokenLogoUrl"
      FROM fresh.financial_events e JOIN published_kols k ON k.address=e.wallet_address AND k.is_tracked JOIN fresh.tokens t ON t.address=e.token_address
      WHERE e.canonical AND e.observed_live AND e.kind IN('buy','sell') AND ${freshTrackedEventSql('e','t')} AND ${kolProfileTokenSql('t')}
      AND e.occurred_at>=$1 AND e.occurred_at<=$2 AND e.block_number<=COALESCE((SELECT block_number FROM fresh.checkpoints WHERE key='capture'),0)
      ORDER BY e.occurred_at DESC,e.block_number DESC,e.transaction_index DESC,e.execution_index DESC,e.id DESC LIMIT 5001`, [from, end]);
    const limited = result.rows.length > 5000, rows = result.rows.slice(0, 5000).map(row => ({ ...row, timestamp: iso(row.timestamp)! })) as EventRow[];
    return { items: deriveFreshSignals(rows, visibleFrom), coverage: { source: 'compact_ledger', mode: 'current', fromAt: new Date(visibleFrom).toISOString(), toAt: end, historyFrom: from, limited,
      availableKinds: ['clustered_buys', 'repeat_buy', 'buyer_selling'] } };
  }
  app.get<{ Querystring: { limit?: string; cursor?: string; watched?: string; token?: string; kol?: string } }>('/api/signals', async (request, reply) => {
    let count: number, after: ReturnType<typeof cursor>;
    try { count = pageLimit(request.query.limit); after = cursor(request.query.cursor); } catch { return reply.code(400).send({ error: 'Invalid signal page' }); }
    if (request.query.watched !== undefined && !['0', '1'].includes(request.query.watched) || request.query.token && !address.test(request.query.token) || request.query.kol && !address.test(request.query.kol)) return reply.code(400).send({ error: 'Invalid signal filter' });
    const selected = await signals(); let items = selected.items;
    if (request.query.watched === '1') {
      const who = await owner(request, reply); if (who === undefined) return; if (!who) return { items: [], nextCursor: null, coverage: selected.coverage };
      const entries = (await db.query(`SELECT kind,address FROM ${who.kind === 'account' ? 'account_watch_entries' : 'watch_entries'} WHERE ${who.kind === 'account' ? 'user_id' : 'session_id'}=$1`, [who.id])).rows;
      const tokens = new Set(entries.filter(row => row.kind === 'token').map(row => row.address)), wallets = new Set(entries.filter(row => row.kind === 'kol').map(row => row.address));
      items = items.filter(item => tokens.has(item.tokenAddress) || item.walletAddresses.some(wallet => wallets.has(wallet)));
    } else reply.header('Cache-Control', 'no-store');
    if (request.query.token) items = items.filter(item => item.tokenAddress === request.query.token!.toLowerCase());
    if (request.query.kol) items = items.filter(item => item.walletAddresses.includes(request.query.kol!.toLowerCase()));
    if (after) items = items.filter(item => item.timestamp < after!.ts || item.timestamp === after!.ts && item.id < after!.id);
    return { ...page(items, count, item => ({ ts: item.timestamp, id: item.id })), coverage: selected.coverage };
  });
  app.get<{ Params: { id: string } }>('/api/signals/:id', async (request, reply) => {
    if (!signalId.test(request.params.id)) return reply.code(404).send({ error: 'Signal not found' });
    const selected = await signals(); return { signal: selected.items.find(item => item.id === request.params.id) ?? null, coverage: selected.coverage };
  });
}
