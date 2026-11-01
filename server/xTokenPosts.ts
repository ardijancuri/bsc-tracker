import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { TokenPostEvidence, TokenPostNarrative, TokenPostSource } from '../shared/xTokenPosts.js';
import { buildTokenPostCaption, prepareTokenPostContent, type prepareTokenPostNarrative, type TokenPostContentOptions } from './xTokenPostContent.js';
import { renderXTokenPostCard } from './xTokenPostCard.js';
import { loadXTokenPostArtwork } from './xTokenPostArtwork.js';
import { readTokenPostCandidates, revalidateTokenPostEvidence, tokenPostEvidenceIsCanonical } from './xTokenPostEligibility.js';
import { createXTokenPostTransport, XTokenPostTransportError } from './xTokenPostTransport.js';

export type XTokenPostMode = 'disabled' | 'dry_run' | 'live';
type Transport = ReturnType<typeof createXTokenPostTransport>;
type Job = { id: string; token_address: string; status: string; evidence: TokenPostEvidence; narrative: TokenPostNarrative | null;
  caption: string | null; image: Buffer | null; media_id: string | null; media_key: string | null; media_expires_at: Date | null;
  lease_id: string; first_qualified_at: Date; dispatch_started_at: Date | null; content_started_at: Date | null; sources: TokenPostSource[] };
type Options = { db: Pool; mode?: XTokenPostMode; transport?: Transport | null; now?: () => number; content?: TokenPostContentOptions;
  candidates?: typeof readTokenPostCandidates; revalidate?: typeof revalidateTokenPostEvidence; canonical?: typeof tokenPostEvidenceIsCanonical;
  narrative?: typeof prepareTokenPostNarrative; card?: typeof renderXTokenPostCard;
  log?: (event: Record<string, unknown>) => void };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const date = (time: number) => new Date(time).toISOString();
const delay = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  if (signal?.aborted) { resolve(); return; }
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); signal?.addEventListener('abort', done, { once: true });
});

export function createXTokenPosts(options: Options) {
  const { db } = options, mode = options.mode ?? 'disabled', now = options.now ?? Date.now;
  const candidates = options.candidates ?? readTokenPostCandidates, revalidate = options.revalidate ?? revalidateTokenPostEvidence;
  const canonical = options.canonical ?? tokenPostEvidenceIsCanonical, narrative = options.narrative ?? prepareTokenPostContent;
  const card = options.card ?? renderXTokenPostCard, transport = options.transport ?? null;
  const log = (event: Record<string, unknown>) => { try { options.log?.(event); } catch { /* Diagnostics cannot retry a publication. */ } };
  const onDiagnostic = (event: { tokenAddress?: string; reason: string }) => log({ event: 'x_token_eligibility', ...event });
  async function transaction<T>(run: (client: PoolClient) => Promise<T>) {
    const client = await db.connect();
    try { await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock_shared(73621941)');
      await client.query('SELECT pg_advisory_xact_lock(782346)'); const value = await run(client); await client.query('COMMIT'); return value;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  const content: TokenPostContentOptions = { ...options.content, sourceCache: options.content?.sourceCache ?? {
    async get(key) { const row = (await db.query('SELECT sources,expires_at FROM x_token_post_sources WHERE cache_key=$1', [key])).rows[0];
      return row ? { sources: row.sources, expiresAt: new Date(row.expires_at).toISOString() } : null; },
    async set(key, value) { await db.query(`INSERT INTO x_token_post_sources(cache_key,sources,checked_at,expires_at) VALUES($1,$2,$3,$4)
      ON CONFLICT(cache_key) DO UPDATE SET sources=EXCLUDED.sources,checked_at=EXCLUDED.checked_at,expires_at=EXCLUDED.expires_at`,
    [key, JSON.stringify(value.sources), date(now()), value.expiresAt]); },
  }, now };
  async function status() {
    const initialized=(await db.query("SELECT to_regclass('x_token_post_settings') IS NOT NULL AS ready")).rows[0]?.ready===true;
    if(!initialized)return{mode,initialized:false,settings:{enabled:false,expected_username:'kollens'},connection:null,counts:[]};
    const settings = (await db.query('SELECT enabled,expected_username,account_id,activated_at,last_sent_at,last_dispatch_at,cooldown_until FROM x_token_post_settings WHERE id=1')).rows[0];
    const counts = (await db.query('SELECT status,count(*)::int AS count FROM x_token_post_jobs GROUP BY status')).rows;
    const connection = (await db.query('SELECT account_id,username,expires_at FROM x_token_post_connections WHERE id=1')).rows[0] ?? null;
    return { mode, initialized:true, settings, connection, counts };
  }
  async function enable() {
    if (mode !== 'live' || !transport) throw new Error('x_live_transport_unavailable');
    const identity = await transport.verifyAccount();
    await transaction(async client => {
      const settings = (await client.query('SELECT * FROM x_token_post_settings WHERE id=1 FOR UPDATE')).rows[0];
      if (identity.username.toLowerCase() !== settings.expected_username || settings.account_id && settings.account_id !== identity.id) throw new Error('x_account_mismatch');
      await client.query('UPDATE x_token_post_settings SET enabled=true,account_id=$1,activated_at=COALESCE(activated_at,$2),updated_at=$2 WHERE id=1', [identity.id, date(now())]);
    });
    return status();
  }
  async function pause() {
    await transaction(client => client.query('UPDATE x_token_post_settings SET enabled=false,updated_at=$1 WHERE id=1', [date(now())]));
    return status();
  }
  async function permitted(client: Pick<Pool | PoolClient, 'query'>, force = false) {
    if (force) return true;
    const settings = (await client.query('SELECT enabled,cooldown_until FROM x_token_post_settings WHERE id=1')).rows[0];
    return mode === 'live' && settings?.enabled && (!settings.cooldown_until || new Date(settings.cooldown_until).getTime() <= now());
  }
  async function collect(input: { force?: boolean } = {}) {
    if (!await permitted(db, input.force)) return { collected: 0, reason: 'disabled' };
    const start = performance.now(), result = await candidates(db, { now: now(), limit: 40, discovery: true, onDiagnostic });
    let count = 0;
    await transaction(async client => {
      for (const evidence of result.candidates) {
        if (!await canonical(client, evidence)) continue;
        const row = await client.query(`INSERT INTO x_token_post_jobs(id,token_address,evidence,first_qualified_at,due_at)
          VALUES($1,$2,$3,$4,$4) ON CONFLICT(chain_id,token_address,account_username) DO UPDATE
          SET status='pending',evidence=EXCLUDED.evidence,due_at=EXCLUDED.due_at,invalidated_at=NULL,last_error=NULL,updated_at=EXCLUDED.due_at
          WHERE x_token_post_jobs.status IN ('deferred','cancelled') AND x_token_post_jobs.post_id IS NULL
            AND x_token_post_jobs.dispatch_started_at IS NULL RETURNING id`, [randomUUID(), evidence.token.address, evidence, date(now())]);
        count += row.rowCount ?? 0;
      }
    });
    log({ event: 'x_token_collection', collected: count, candidates: result.candidates.length, reason: result.reason, durationMs: Math.round(performance.now() - start) });
    return { collected: count, reason: result.reason };
  }
  async function reclaim(client: PoolClient) {
    await client.query(`UPDATE x_token_post_jobs SET status=CASE WHEN status='sending' THEN 'uncertain' WHEN status='uploading' THEN 'ready' ELSE 'pending' END,
      needs_inspection=(status='sending'),last_error='lease_expired',lease_id=NULL,lease_until=NULL,updated_at=$1,
      due_at=CASE WHEN status='sending' THEN $1::timestamptz+interval '2 minutes' ELSE $1::timestamptz END
      WHERE status IN ('preparing','uploading','sending') AND lease_until<$1 AND invalidated_at IS NULL`, [date(now())]);
  }
  async function claim(status: 'pending' | 'ready' | 'uncertain', force = false): Promise<Job | null> {
    return transaction(async client => {
      await reclaim(client);
      if (status !== 'uncertain' && !await permitted(client, force)) return null;
      if (status === 'pending' && !force && mode === 'live') {
        if (!transport || !await pacingAllows(client)) return null;
        const reserved = await client.query(`SELECT 1 FROM x_token_post_jobs WHERE status='ready'
          OR status='preparing' AND lease_until>$1 LIMIT 1`, [date(now())]);
        if (reserved.rowCount) return null;
      }
      if (status === 'ready' && (!transport || mode !== 'live' || !await pacingAllows(client))) return null;
      if (status === 'uncertain' && !transport) return null;
      const job = (await client.query<Job>(`SELECT * FROM x_token_post_jobs WHERE status=$1 AND due_at<=$2
        AND (lease_until IS NULL OR lease_until<$2) AND (invalidated_at IS NULL OR status='uncertain')
        ORDER BY first_qualified_at,id FOR UPDATE SKIP LOCKED LIMIT 1`, [status, date(now())])).rows[0];
      if (!job) return null;
      const lease = randomUUID(), next = status === 'pending' ? 'preparing' : status === 'ready' ? 'uploading' : 'uncertain';
      await client.query(`UPDATE x_token_post_jobs SET status=$2,lease_id=$3,lease_until=$4,updated_at=$5 WHERE id=$1`,
        [job.id, next, lease, date(now() + 180_000), date(now())]);
      return { ...job, lease_id: lease, status: next };
    });
  }
  async function pacingAllows(client: Pick<Pool | PoolClient, 'query'>) {
    const settings = (await client.query('SELECT last_dispatch_at,cooldown_until FROM x_token_post_settings WHERE id=1')).rows[0];
    if (settings.cooldown_until && new Date(settings.cooldown_until).getTime() > now()
      || settings.last_dispatch_at && now() - new Date(settings.last_dispatch_at).getTime() < 600_000) return false;
    const row = (await client.query(`SELECT count(*)::int AS count FROM x_token_post_jobs
      WHERE (sent_at IS NOT NULL OR status IN ('sending','uncertain'))
        AND (COALESCE(sent_at,dispatch_started_at) AT TIME ZONE 'Europe/Skopje')::date=($1::timestamptz AT TIME ZONE 'Europe/Skopje')::date`, [date(now())])).rows[0];
    return row.count < 12 && !(await client.query("SELECT 1 FROM x_token_post_jobs WHERE status IN ('uploading','sending') AND lease_until>$1 LIMIT 1", [date(now())])).rowCount;
  }
  async function defer(job: Job, reason: string) {
    await db.query(`UPDATE x_token_post_jobs SET status='deferred',last_error=$3,lease_id=NULL,lease_until=NULL,updated_at=$4
      WHERE id=$1 AND lease_id=$2 AND status IN ('preparing','uploading')`, [job.id, job.lease_id, reason, date(now())]);
  }
  async function prepareOne(force = false) {
    const job = await claim('pending', force); if (!job) return false;
    const start = performance.now();
    try {
      const fresh = await revalidate(db, job.evidence, { now: now(), onDiagnostic });
      if (!fresh) { await defer(job, 'no_longer_eligible'); return true; }
      const reserved = !job.content_started_at && !job.narrative && (await db.query(`UPDATE x_token_post_jobs SET content_started_at=$3
        WHERE id=$1 AND lease_id=$2 AND status='preparing' AND content_started_at IS NULL AND invalidated_at IS NULL RETURNING id`,
      [job.id, job.lease_id, date(now())])).rowCount;
      const prepared = job.narrative ? { narrative: job.narrative, sources: job.sources }
        : reserved ? await narrative(fresh, force ? { ...content, apiKey: null } : content) : { narrative: { kind: 'facts_only' as const, text: '', sourceIds: [],
          reason: 'model_unavailable' as const, aiAssisted: false }, sources: [] };
      await db.query(`UPDATE x_token_post_jobs SET narrative=$3,sources=$4 WHERE id=$1 AND lease_id=$2 AND status='preparing' AND invalidated_at IS NULL`,
        [job.id, job.lease_id, prepared.narrative, JSON.stringify(prepared.sources)]);
      const caption = buildTokenPostCaption(fresh, prepared.narrative);
      const image = await card({ evidence: fresh, narrative: prepared.narrative, ...await loadXTokenPostArtwork(db, fresh) });
      await db.query(`UPDATE x_token_post_jobs SET status='ready',evidence=$3,narrative=$4,sources=$5,caption=$6,image=$7,image_sha256=$8,
        lease_id=NULL,lease_until=NULL,last_error=NULL,updated_at=$9 WHERE id=$1 AND lease_id=$2 AND status='preparing' AND invalidated_at IS NULL`,
      [job.id, job.lease_id, fresh, prepared.narrative, JSON.stringify(prepared.sources), caption, image, hash(image), date(now())]);
      log({ event: 'x_token_prepared', token: fresh.token.address, fallback: prepared.narrative.reason, model: prepared.narrative.model ?? null,
        sources: prepared.sources.length, queueAgeMs: Math.max(0, now() - job.first_qualified_at.getTime()), durationMs: Math.round(performance.now() - start) });
    } catch { await retry(job, 'preparation_unavailable', false); }
    return true;
  }
  async function retry(job: Job, category: string, uncertain: boolean, retryAt = now() + 60_000) {
    await transaction(async client => {
      if (category === 'auth') await client.query('UPDATE x_token_post_settings SET enabled=false,updated_at=$1 WHERE id=1', [date(now())]);
      if (category === 'cooldown') await client.query('UPDATE x_token_post_settings SET cooldown_until=$1,updated_at=$2 WHERE id=1', [date(retryAt), date(now())]);
      await client.query(`UPDATE x_token_post_jobs SET status=CASE WHEN invalidated_at IS NOT NULL THEN status ELSE $3 END,
        last_error=CASE WHEN invalidated_at IS NOT NULL THEN 'chain_reorganization' ELSE $4 END,due_at=$5,lease_id=NULL,lease_until=NULL,
        needs_inspection=needs_inspection OR $6,updated_at=$7 WHERE id=$1 AND lease_id=$2 AND status IN ('preparing','uploading','sending','uncertain')`,
      [job.id, job.lease_id, uncertain ? 'uncertain' : category === 'rejected' ? 'failed' : job.status === 'preparing' ? 'pending' : 'ready', category,
        date(uncertain ? Math.max(retryAt, now() + 120_000) : retryAt), uncertain, date(now())]);
    });
    log({ event: 'x_token_waiting', token: job.token_address, reason: category, uncertain });
  }
  async function finishSent(job: Job, postId: string, sentAt: string) {
    await transaction(async client => {
      await client.query(`UPDATE x_token_post_jobs SET status='sent',post_id=$3,sent_at=$4,lease_id=NULL,lease_until=NULL,
        needs_inspection=(invalidated_at IS NOT NULL),last_error=CASE WHEN invalidated_at IS NOT NULL THEN 'chain_reorganization' ELSE NULL END,
        updated_at=$5 WHERE id=$1 AND lease_id=$2`, [job.id, job.lease_id, postId, sentAt, date(now())]);
      await client.query('UPDATE x_token_post_settings SET last_sent_at=$1,updated_at=$2 WHERE id=1', [sentAt, date(now())]);
    });
    log({ event: 'x_token_sent', token: job.token_address, postId, queueAgeMs: Math.max(0, now() - job.first_qualified_at.getTime()) });
  }
  async function deliverOne() {
    if (mode !== 'live' || !transport) return false;
    const job = await claim('ready'); if (!job) return false;
    let dispatched = false, attempt: string | null = null;
    try {
      const fresh = await revalidate(db, job.evidence, { now: now(), onDiagnostic });
      if (!fresh) { await defer(job, 'no_longer_eligible'); return true; }
      const identity = await transport.verifyAccount();
      const sameIdentity = fresh.token.name === job.evidence.token.name && fresh.token.symbol === job.evidence.token.symbol;
      const summary = sameIdentity && job.narrative ? job.narrative : { kind: 'facts_only' as const, text: '', sourceIds: [], reason: 'sources_unavailable' as const, aiAssisted: false };
      const caption = buildTokenPostCaption(fresh, summary), image = await card({ evidence: fresh, narrative: summary, ...await loadXTokenPostArtwork(db, fresh) });
      const media = await transport.uploadPng(image);
      const stillEligible = await revalidate(db, fresh, { now: now(), onDiagnostic });
      if (!stillEligible) { await defer(job, 'no_longer_eligible'); return true; }
      attempt = randomUUID();
      const allowed = await transaction(async client => {
        const settings = (await client.query('SELECT * FROM x_token_post_settings WHERE id=1 FOR UPDATE')).rows[0];
        const current = (await client.query('SELECT status,lease_id,invalidated_at FROM x_token_post_jobs WHERE id=$1 FOR UPDATE', [job.id])).rows[0];
        if (!current || current.lease_id !== job.lease_id || current.status !== 'uploading' || current.invalidated_at) return false;
        if (identity.username.toLowerCase() !== settings.expected_username || settings.account_id && identity.id !== settings.account_id) throw new XTokenPostTransportError('auth', 'account_mismatch');
        // This job owns the upload lease, so exclude its own reservation from the pacing query.
        const active = (await client.query("SELECT 1 FROM x_token_post_jobs WHERE id<>$1 AND status IN ('uploading','sending') AND lease_until>$2 LIMIT 1", [job.id, date(now())])).rowCount;
        const daily = (await client.query(`SELECT count(*)::int AS count FROM x_token_post_jobs WHERE (sent_at IS NOT NULL OR status IN ('sending','uncertain'))
          AND (COALESCE(sent_at,dispatch_started_at) AT TIME ZONE 'Europe/Skopje')::date=($1::timestamptz AT TIME ZONE 'Europe/Skopje')::date`, [date(now())])).rows[0].count;
        if (!settings.enabled || active || daily >= 12 || settings.cooldown_until && new Date(settings.cooldown_until).getTime() > now()
          || settings.last_dispatch_at && now() - new Date(settings.last_dispatch_at).getTime() < 600_000 || !await canonical(client, fresh)) return false;
        // Financial metrics are optional; only the confirmed holdings evaluation
        // must be current. Missing quotes may never gate a holdings-only post.
        if (now() - Date.parse(fresh.evaluatedAt) > 120_000) return false;
        await client.query(`UPDATE x_token_post_jobs SET status='sending',evidence=$3,narrative=$4,caption=$5,image=$6,image_sha256=$7,
          media_id=$8,media_key=$9,media_expires_at=$10,dispatch_started_at=$11,attempts=attempts+1,updated_at=$11 WHERE id=$1 AND lease_id=$2`,
        [job.id, job.lease_id, fresh, summary, caption, image, hash(image), media.mediaId, media.mediaKey, media.expiresAt, date(now())]);
        await client.query(`INSERT INTO x_token_post_attempts(id,job_id,stage,outcome,started_at,media_id,caption_sha256,image_sha256)
          VALUES($1,$2,'publish','started',$3,$4,$5,$6)`, [attempt, job.id, date(now()), media.mediaId, hash(caption), hash(image)]);
        await client.query('UPDATE x_token_post_settings SET account_id=$1,last_dispatch_at=$2,updated_at=$2 WHERE id=1', [identity.id, date(now())]);
        return true;
      });
      if (!allowed) { await db.query("UPDATE x_token_post_jobs SET status='ready',lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2 AND status='uploading'", [job.id, job.lease_id]); return true; }
      dispatched = true;
      const result = await transport.publish({ caption, mediaId: media.mediaId, madeWithAi: false });
      await finishSent(job, result.postId, result.createdAt);
      await db.query("UPDATE x_token_post_attempts SET outcome='sent',post_id=$2,completed_at=$3 WHERE id=$1", [attempt, result.postId, date(now())]);
    } catch (error) {
      const category = error instanceof XTokenPostTransportError ? error.category : 'unavailable';
      const uncertain = dispatched && (! (error instanceof XTokenPostTransportError) || category === 'ambiguous');
      if (attempt) await db.query('UPDATE x_token_post_attempts SET outcome=$2,category=$3,completed_at=$4 WHERE id=$1', [attempt, uncertain ? 'uncertain' : 'failed', category, date(now())]);
      await retry(job, category, uncertain, error instanceof XTokenPostTransportError && error.retryAt ? Date.parse(error.retryAt) : now() + 60_000);
    }
    return true;
  }
  async function reconcileOne() {
    const job = await claim('uncertain'); if (!job || !transport || !job.caption || !job.media_id || !job.dispatch_started_at) return false;
    try {
      const found = await transport.reconcile({ caption: job.caption, mediaId: job.media_id, mediaKey: job.media_key ?? '', notBefore: job.dispatch_started_at.toISOString() });
      if (found.status === 'found') await finishSent(job, found.postId, found.createdAt);
      else await db.query(`UPDATE x_token_post_jobs SET needs_inspection=true,last_error='send_not_confirmed',due_at='infinity',
        lease_id=NULL,lease_until=NULL,updated_at=$3 WHERE id=$1 AND lease_id=$2`, [job.id, job.lease_id, date(now())]);
    } catch { await db.query(`UPDATE x_token_post_jobs SET last_error='reconciliation_unavailable',due_at=$3,lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2`, [job.id, job.lease_id, date(now() + 300_000)]); }
    return true;
  }
  async function preview(token?: string) {
    const result = await candidates(db, { now: now(), token, limit: token ? 1 : 5, onDiagnostic });
    const items = [];
    for (const evidence of result.candidates) { const prepared = await narrative(evidence, content); items.push({ evidence, ...prepared,
      caption: buildTokenPostCaption(evidence, prepared.narrative), image: await card({ evidence, narrative: prepared.narrative, ...await loadXTokenPostArtwork(db, evidence) }) }); }
    return { items, reason: result.reason, evaluatedAt: result.evaluatedAt };
  }
  async function run(signal?: AbortSignal) {
    const collection = async () => { while (!signal?.aborted) {
      try { if (mode !== 'disabled') await collect({ force: mode === 'dry_run' }); } catch { log({ event: 'x_token_collection_waiting', reason: 'database_unavailable' }); }
      await delay(30_000, signal);
    } };
    const delivery = async () => { while (!signal?.aborted) {
      try { if (mode !== 'disabled') { await prepareOne(mode === 'dry_run'); if (mode === 'live') { await reconcileOne(); await deliverOne(); } } }
      catch { log({ event: 'x_token_delivery_waiting', reason: 'service_unavailable' }); }
      await delay(2000, signal);
    } };
    await Promise.all([collection(), delivery()]);
  }
  return { status, enable, pause, collect, prepareOne, deliverOne, reconcileOne, preview, run };
}
