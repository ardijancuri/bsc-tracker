import { createHash } from 'node:crypto';

export type XTokenPostErrorCategory = 'auth' | 'cooldown' | 'rejected' | 'ambiguous' | 'unavailable';

/** Provider responses and credentials deliberately never become exception messages. */
export class XTokenPostTransportError extends Error {
  constructor(readonly category: XTokenPostErrorCategory, readonly reason: string, readonly retryAt?: string) {
    super(`X publishing ${reason}`);
    this.name = 'XTokenPostTransportError';
  }
}

export type XTokenPostAccount = { id: string; username: string };
export type XTokenPostMedia = { mediaId: string; mediaKey: string; expiresAt: string };
export type XTokenPostPublished = { postId: string; createdAt: string };
export type XTokenPostReconciliation = ({ status: 'found' } & XTokenPostPublished) | { status: 'not_found' };
export type XTokenPostTransportOptions = {
  getAccessToken: () => Promise<string | null>;
  /** Must persist rotated tokens before returning. Refresh is never used to retry an ambiguous send. */
  refreshAccessToken?: () => Promise<string | null>;
  fetch?: typeof fetch;
  expectedUsername?: string;
  timeoutMs?: number;
  now?: () => number;
};

const API = 'https://api.x.com';
const MAX_RESPONSE_BYTES = 256 * 1024;
const id = (value: unknown): value is string => typeof value === 'string' && /^[0-9]{1,25}$/.test(value);
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const fail = (category: XTokenPostErrorCategory, reason: string, retryAt?: string): never => { throw new XTokenPostTransportError(category, reason, retryAt); };
const KOLLENS_WEBSITE = 'https://kollens.com';

/** Resolve an entity against the actual short URL, accepting either X character-index convention. */
function entitySpan(text: string, entry: Record<string, unknown>, url: string) {
  const { start, end } = entry;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0 || (end as number) <= (start as number)) return null;
  const matches = new Map<string, { start: number; end: number }>();
  const add = (from: number, to: number) => {
    if (from >= 0 && to <= text.length && text.slice(from, to) === url) matches.set(`${from}:${to}`, { start: from, end: to });
  };
  add(start as number, end as number);
  const characters = Array.from(text);
  if ((end as number) <= characters.length) add(characters.slice(0, start as number).join('').length, characters.slice(0, end as number).join('').length);
  return matches.size === 1 ? [...matches.values()][0] : null;
}

/** Only reconstruct our explicit website; arbitrary expanded/display URLs never become caption text. */
function reconciliationCaption(post: Record<string, unknown>, account: XTokenPostAccount, expectedCaption: string) {
  const note = object(post.note_tweet);
  const useNote = typeof note.text === 'string';
  const text = useNote ? note.text as string : typeof post.text === 'string' ? post.text : '';
  const urls = object(useNote ? note.entities : post.entities).urls;
  if (urls === undefined) return text;
  if (!Array.isArray(urls) || urls.length > 100) return null;
  const escapedUser = account.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const photo = new RegExp(`^https://(?:twitter|x)\\.com/${escapedUser}/status/${post.id}/photo/[1-4]$`, 'i');
  const changes: { start: number; end: number; value: string }[] = [];
  let website = false;
  for (const value of urls) {
    const entry = object(value);
    if (typeof entry.url !== 'string' || typeof entry.expanded_url !== 'string') continue;
    const isWebsite = entry.expanded_url === KOLLENS_WEBSITE || entry.expanded_url === `${KOLLENS_WEBSITE}/`;
    const isPhoto = photo.test(entry.expanded_url) && text.endsWith(` ${entry.url}`);
    if (!isWebsite && !isPhoto) continue;
    if (!/^https:\/\/t\.co\/[a-zA-Z0-9]+$/.test(entry.url)) return null;
    if (isWebsite) {
      if (website || !expectedCaption.endsWith(`\n${KOLLENS_WEBSITE}`)) return null;
      const span = entitySpan(text, entry, entry.url);
      if (!span) return null;
      website = true;
      changes.push({ ...span, value: KOLLENS_WEBSITE });
    } else {
      // Older media entities may omit indices. Their exact authenticated same-post URL must still be the suffix.
      const span = entry.start === undefined && entry.end === undefined
        ? { start: text.length - entry.url.length, end: text.length } : entitySpan(text, entry, entry.url);
      if (!span || span.end !== text.length || text[span.start - 1] !== ' ') return null;
      changes.push({ start: span.start - 1, end: span.end, value: '' });
    }
  }
  changes.sort((a, b) => b.start - a.start);
  if (changes.some((change, index) => index > 0 && change.end > changes[index - 1].start)) return null;
  let caption = text;
  for (const change of changes) caption = caption.slice(0, change.start) + change.value + caption.slice(change.end);
  return caption;
}

function cooldownAt(headers: Headers, now: number) {
  const retry = headers.get('retry-after');
  const seconds = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) : NaN;
  const retryDate = retry ? Date.parse(retry) : NaN;
  const resetSeconds = Number(headers.get('x-rate-limit-reset'));
  const desired = Number.isFinite(seconds) ? now + seconds * 1_000 : Number.isFinite(retryDate) ? retryDate
    : resetSeconds > now / 1_000 ? resetSeconds * 1_000 : now + 60_000;
  return new Date(Math.max(now + 1_000, Math.min(desired, now + 86_400_000))).toISOString();
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('bounded_response');
  }
  if (!response.body) throw new Error('empty_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error('request_timeout');
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error('bounded_response');
      chunks.push(result.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { await reader.cancel().catch(() => undefined); }
}

export function createXTokenPostTransport(options: XTokenPostTransportOptions) {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = Math.max(10, Math.min(options.timeoutMs ?? 10_000, 30_000));
  const expected = (options.expectedUsername ?? 'kollens').replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(expected)) throw new Error('Invalid configured X username');
  let verified: { fingerprint: string; account: XTokenPostAccount; until: number } | undefined;
  let verification: Promise<XTokenPostAccount> | undefined;

  async function token() {
    let value: string | null;
    try { value = await options.getAccessToken(); } catch { return fail('auth', 'credentials_unavailable'); }
    if (!value || value.length > 8_192 || /[\r\n]/.test(value)) return fail('auth', 'credentials_unavailable');
    return value;
  }

  async function request(path: string, init: RequestInit = {}, settings: { publish?: boolean; token?: string; signal?: AbortSignal; allowRefresh?: boolean; onToken?: (token: string) => void } = {}): Promise<unknown> {
    const accessToken = settings.token ?? await token();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    settings.signal?.addEventListener('abort', onAbort, { once: true });
    if (settings.signal?.aborted) controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('request_timeout')); }, timeoutMs);
    });
    const perform = async () => {
      if (controller.signal.aborted) return fail('unavailable', 'request_cancelled');
      let response: Response;
      try {
        settings.onToken?.(accessToken);
        response = await fetcher(`${API}${path}`, {
          ...init, redirect: 'error', signal: controller.signal,
          headers: { ...Object.fromEntries(new Headers(init.headers).entries()), Authorization: `Bearer ${accessToken}` },
        });
      } catch { return fail(settings.publish ? 'ambiguous' : 'unavailable', settings.publish ? 'delivery_unknown' : 'request_failed'); }
      if (response.status === 401 && settings.allowRefresh !== false && options.refreshAccessToken && !settings.publish) {
        await response.body?.cancel();
        let refreshed: string | null = null;
        try { refreshed = await options.refreshAccessToken(); } catch { /* Keep refresh secrets out of errors. */ }
        verified = undefined;
        if (!refreshed) return fail('auth', 'credentials_expired');
        return request(path, init, { ...settings, token: refreshed, allowRefresh: false });
      }
      if (response.status === 429) {
        await response.body?.cancel();
        return fail('cooldown', 'provider_cooldown', cooldownAt(response.headers, now()));
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel(); verified = undefined;
        return fail('auth', 'authorization_required');
      }
      if (!response.ok) {
        await response.body?.cancel();
        return fail(settings.publish && response.status >= 500 ? 'ambiguous' : response.status >= 500 ? 'unavailable' : 'rejected',
          settings.publish && response.status >= 500 ? 'delivery_unknown' : 'request_rejected');
      }
      try { return await boundedJson(response, controller.signal); }
      catch { return fail(settings.publish ? 'ambiguous' : 'unavailable', settings.publish ? 'delivery_unknown' : 'response_invalid'); }
    };
    try { return await Promise.race([perform(), deadline]); }
    catch (error) {
      if (error instanceof XTokenPostTransportError) throw error;
      return fail(settings.publish ? 'ambiguous' : 'unavailable', settings.publish ? 'delivery_unknown' : 'request_timeout');
    } finally {
      if (timer) clearTimeout(timer);
      settings.signal?.removeEventListener('abort', onAbort);
    }
  }

  async function verifyAccount(): Promise<XTokenPostAccount> {
    const accessToken = await token();
    const fingerprint = createHash('sha256').update(accessToken).digest('hex');
    if (verified?.fingerprint === fingerprint && verified.until > now()) return verified.account;
    if (verification) return verification;
    verification = (async () => {
      let verifiedToken = accessToken;
      const result = object(await request('/2/users/me?user.fields=username', {}, { token: accessToken, onToken: value => { verifiedToken = value; } }));
      const data = object(result.data);
      if (!id(data.id) || typeof data.username !== 'string' || data.username.toLowerCase() !== expected) return fail('auth', 'account_mismatch');
      const account = { id: data.id, username: data.username };
      verified = { fingerprint: createHash('sha256').update(verifiedToken).digest('hex'), account, until: now() + 60_000 };
      return account;
    })().finally(() => { verification = undefined; });
    return verification;
  }

  async function verifiedAccessToken() {
    for (let attempt = 0; attempt < 2; attempt++) {
      await verifyAccount();
      const accessToken = await token();
      if (verified?.fingerprint === createHash('sha256').update(accessToken).digest('hex') && verified.until > now()) return accessToken;
    }
    return fail('auth', 'credentials_changed');
  }

  async function uploadPng(image: Buffer): Promise<XTokenPostMedia> {
    if (image.byteLength < 8 || image.byteLength > 5_000_000 || image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return fail('rejected', 'invalid_png');
    const accessToken = await verifiedAccessToken();
    const result = object(await request('/2/media/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media: image.toString('base64'), media_category: 'tweet_image' }),
    }, { token: accessToken, allowRefresh: false }));
    const data = object(result.data);
    const expires = Number(data.expires_after_secs);
    if (!id(data.id) || typeof data.media_key !== 'string' || !/^[0-9]+_[0-9]+$/.test(data.media_key) || !Number.isFinite(expires) || expires <= 0) return fail('unavailable', 'media_response_invalid');
    const processing = object(data.processing_info);
    if (processing.state && processing.state !== 'succeeded') return fail('unavailable', 'media_not_ready');
    return { mediaId: data.id, mediaKey: data.media_key, expiresAt: new Date(now() + Math.min(expires, 604_800) * 1_000).toISOString() };
  }

  async function publish(input: { caption: string; mediaId: string; madeWithAi: boolean }): Promise<XTokenPostPublished> {
    if (!input.caption.trim() || input.caption.length > 2_000 || !id(input.mediaId)) return fail('rejected', 'invalid_post');
    const accessToken = await verifiedAccessToken();
    const result = object(await request('/2/tweets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: input.caption, media: { media_ids: [input.mediaId] }, ...(input.madeWithAi ? { made_with_ai: true } : {}) }),
    }, { token: accessToken, publish: true, allowRefresh: false }));
    const data = object(result.data);
    if (!id(data.id)) return fail('ambiguous', 'delivery_unknown');
    return { postId: data.id, createdAt: new Date(now()).toISOString() };
  }

  async function reconcile(input: { caption: string; mediaId: string; mediaKey: string; notBefore: string; signal?: AbortSignal }): Promise<XTokenPostReconciliation> {
    if (!id(input.mediaId) || !new RegExp(`^[0-9]+_${input.mediaId}$`).test(input.mediaKey) || !Number.isFinite(Date.parse(input.notBefore))) return fail('rejected', 'invalid_reconciliation');
    const account = await verifyAccount();
    const params = new URLSearchParams({ max_results: '100', start_time: new Date(Date.parse(input.notBefore) - 1_000).toISOString(),
      'tweet.fields': 'created_at,attachments,entities,note_tweet', expansions: 'attachments.media_keys', 'media.fields': 'media_key' });
    // Bounded two-page lookup. If more data exists, absence is inconclusive and must never permit a resend.
    for (let page = 0; page < 2; page++) {
      const result = object(await request(`/2/users/${account.id}/tweets?${params}`, {}, { signal: input.signal }));
      if (Array.isArray(result.errors) && result.errors.length) return fail('unavailable', 'timeline_invalid');
      const posts = result.data === undefined ? [] : result.data;
      if (!Array.isArray(posts)) return fail('unavailable', 'timeline_invalid');
      for (const value of posts) {
        const post = object(value);
        const attachments = object(post.attachments);
        if (!id(post.id) || !Array.isArray(attachments.media_keys) || !attachments.media_keys.includes(input.mediaKey)) continue;
        const createdAt = typeof post.created_at === 'string' ? post.created_at : '';
        if (!Number.isFinite(Date.parse(createdAt)) || Date.parse(createdAt) < Date.parse(input.notBefore) - 1_000) continue;
        const caption = reconciliationCaption(post, account, input.caption);
        if (caption === input.caption) return { status: 'found', postId: post.id, createdAt };
      }
      const next = object(result.meta).next_token;
      if (next === undefined) return { status: 'not_found' };
      if (typeof next !== 'string' || next.length > 1_024) return fail('unavailable', 'timeline_invalid');
      params.set('pagination_token', next);
    }
    return fail('unavailable', 'reconciliation_incomplete');
  }

  async function fetchOfficialPosts(username: string, settings: { signal?: AbortSignal; maxResults?: number } = {}) {
    const clean = username.replace(/^@/, '');
    if (!/^[a-zA-Z0-9_]{1,15}$/.test(clean)) return fail('rejected', 'invalid_source_account');
    const lookup = object(await request(`/2/users/by/username/${clean}?user.fields=username`, {}, { signal: settings.signal }));
    const user = object(lookup.data);
    if (!id(user.id) || typeof user.username !== 'string' || user.username.toLowerCase() !== clean.toLowerCase()) return fail('unavailable', 'source_account_unavailable');
    const query = new URLSearchParams({ max_results: '5', exclude: 'retweets,replies', 'tweet.fields': 'created_at,note_tweet' });
    const result = object(await request(`/2/users/${user.id}/tweets?${query}`, {}, { signal: settings.signal }));
    if (result.data === undefined) return [];
    if (!Array.isArray(result.data)) return fail('unavailable', 'timeline_invalid');
    return result.data.slice(0, Math.max(1, Math.min(settings.maxResults ?? 5, 5))).flatMap(value => {
      const post = object(value);
      const text = typeof object(post.note_tweet).text === 'string' ? object(post.note_tweet).text : post.text;
      return id(post.id) && typeof text === 'string' && text.length <= 20_000 && typeof post.created_at === 'string' && Number.isFinite(Date.parse(post.created_at))
        ? [{ id: post.id, text, url: `https://x.com/${user.username}/status/${post.id}`, createdAt: post.created_at }] : [];
    });
  }

  return { verifyAccount, uploadPng, publish, reconcile, fetchOfficialPosts };
}

export type XTokenPostTransport = ReturnType<typeof createXTokenPostTransport>;
