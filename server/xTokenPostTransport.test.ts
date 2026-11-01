import { describe, expect, it, vi } from 'vitest';
import { createXTokenPostTransport, XTokenPostTransportError } from './xTokenPostTransport.js';

const NOW = Date.parse('2026-10-20T18:00:00Z');
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers });
const me = () => json({ data: { id: '123', username: 'Kollens' } });
const subject = (mock: ReturnType<typeof vi.fn>, extra: Partial<Parameters<typeof createXTokenPostTransport>[0]> = {}) => createXTokenPostTransport({ getAccessToken: async () => 'private-access-token', fetch: mock as typeof fetch, now: () => NOW, ...extra });
const reconcile = { caption: 'Token facts\nCA: 0x' + '1'.repeat(40), mediaId: '999', mediaKey: '3_999', notBefore: new Date(NOW - 5_000).toISOString() };

describe('official X token publishing transport', () => {
  it('verifies the intended account and uploads base64 PNG with the official v2 category', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(me()).mockResolvedValueOnce(json({ data: { id: '999', media_key: '3_999', expires_after_secs: 86_400 } }));
    const transport = subject(fetcher);
    expect(await transport.uploadPng(png)).toEqual({ mediaId: '999', mediaKey: '3_999', expiresAt: '2026-10-21T18:00:00.000Z' });
    expect(fetcher.mock.calls[0][0]).toBe('https://api.x.com/2/users/me?user.fields=username');
    const [url, init] = fetcher.mock.calls[1];
    expect(url).toBe('https://api.x.com/2/media/upload');
    expect(JSON.parse(init.body)).toEqual({ media: png.toString('base64'), media_category: 'tweet_image' });
    expect(init.redirect).toBe('error');
    expect(init.headers.Authorization).toBe('Bearer private-access-token');
  });

  it('coalesces concurrent account verification and refuses a different publishing identity', async () => {
    const fetcher = vi.fn(async () => me());
    const transport = subject(fetcher);
    await Promise.all([transport.verifyAccount(), transport.verifyAccount()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const wrong = vi.fn(async () => json({ data: { id: '123', username: 'other' } }));
    await expect(subject(wrong).publish({ caption: 'facts', mediaId: '999', madeWithAi: false })).rejects.toMatchObject({ category: 'auth', reason: 'account_mismatch' });
    expect(wrong).toHaveBeenCalledTimes(1);
  });

  it('refreshes an explicit expired GET credential once and persists the new verification', async () => {
    let access = 'expired';
    const fetcher = vi.fn().mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(me());
    const refresh = vi.fn(async () => { access = 'rotated'; return access; });
    const transport = subject(fetcher, { getAccessToken: async () => access, refreshAccessToken: refresh });
    expect(await transport.verifyAccount()).toEqual({ id: '123', username: 'Kollens' });
    await transport.verifyAccount();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][1].headers.Authorization).toBe('Bearer rotated');
  });

  it('verifies a credential changed concurrently before any mutation can use it', async () => {
    let access = 'first';
    const fetcher = vi.fn().mockImplementationOnce(async () => { access = 'changed'; return me(); }).mockResolvedValueOnce(json({ data: { id: '456', username: 'another_account' } }));
    await expect(subject(fetcher, { getAccessToken: async () => access }).publish({ caption: 'facts', mediaId: '999', madeWithAi: false })).rejects.toMatchObject({ category: 'auth', reason: 'account_mismatch' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(call => call[1].method === undefined)).toBe(true);
  });

  it('posts one uploaded image and sets AI disclosure only for an AI-assisted card', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(me()).mockResolvedValueOnce(json({ data: { id: '456', text: 'facts' } })).mockResolvedValueOnce(json({ data: { id: '457' } }));
    const transport = subject(fetcher);
    expect(await transport.publish({ caption: 'facts', mediaId: '999', madeWithAi: true })).toEqual({ postId: '456', createdAt: '2026-10-20T18:00:00.000Z' });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ text: 'facts', media: { media_ids: ['999'] }, made_with_ai: true });
    await transport.publish({ caption: 'facts only', mediaId: '999', madeWithAi: false });
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).not.toHaveProperty('made_with_ai');
  });

  it.each([500, 502, 503])('treats HTTP %s after post dispatch as ambiguous and never resends', async status => {
    const fetcher = vi.fn().mockResolvedValueOnce(me()).mockResolvedValueOnce(json({ secret: 'provider echoed token' }, status));
    const refresh = vi.fn();
    await expect(subject(fetcher, { refreshAccessToken: refresh }).publish({ caption: 'facts', mediaId: '999', madeWithAi: false })).rejects.toMatchObject({ category: 'ambiguous', reason: 'delivery_unknown' });
    expect(fetcher).toHaveBeenCalledTimes(2); expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    () => Promise.reject(new Error('private-access-token complete provider response')),
    () => Promise.resolve(new Response('not JSON')),
    () => Promise.resolve(json({ data: {} })),
    () => Promise.resolve(json({ data: { id: '456' } }, 200, { 'content-length': '99999999' })),
  ])('keeps post network and invalid-success outcomes ambiguous without exposing response details', async reply => {
    const fetcher = vi.fn().mockResolvedValueOnce(me()).mockImplementationOnce(reply);
    let error: unknown;
    try { await subject(fetcher).publish({ caption: 'facts', mediaId: '999', madeWithAi: false }); } catch (value) { error = value; }
    expect(error).toBeInstanceOf(XTokenPostTransportError);
    expect(error).toMatchObject({ category: 'ambiguous', message: 'X publishing delivery_unknown' });
    expect(String(error)).not.toContain('private-access-token');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('bounds the entire post fetch and response-body operation', async () => {
    const slowFetch = vi.fn().mockResolvedValueOnce(me()).mockImplementationOnce(() => new Promise(() => undefined));
    await expect(subject(slowFetch, { timeoutMs: 10 }).publish({ caption: 'facts', mediaId: '999', madeWithAi: false })).rejects.toMatchObject({ category: 'ambiguous' });
    const body = new ReadableStream({ start() { /* The response never completes. */ } });
    const slowBody = vi.fn().mockResolvedValueOnce(me()).mockResolvedValueOnce(new Response(body));
    await expect(subject(slowBody, { timeoutMs: 10 }).publish({ caption: 'facts', mediaId: '999', madeWithAi: false })).rejects.toMatchObject({ category: 'ambiguous' });
  });

  it('does not refresh or repeat an explicit rejected POST and sanitizes errors', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(me()).mockResolvedValueOnce(json({ token: 'secret' }, 401));
    const refresh = vi.fn();
    await expect(subject(fetcher, { refreshAccessToken: refresh }).publish({ caption: 'facts', mediaId: '999', madeWithAi: false })).rejects.toMatchObject({ category: 'auth', reason: 'authorization_required' });
    expect(refresh).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('honors bounded Retry-After rather than retrying or switching accounts', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(me()).mockResolvedValueOnce(json({}, 429, { 'retry-after': '120' }));
    await expect(subject(fetcher).publish({ caption: 'facts', mediaId: '999', madeWithAi: false })).rejects.toMatchObject({ category: 'cooldown', retryAt: '2026-10-20T18:02:00.000Z' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('checks PNG magic and byte limits before contacting X', async () => {
    const fetcher = vi.fn();
    await expect(subject(fetcher).uploadPng(Buffer.from('not png'))).rejects.toMatchObject({ category: 'rejected' });
    await expect(subject(fetcher).uploadPng(Buffer.alloc(5_000_001))).rejects.toMatchObject({ category: 'rejected' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects media that is still processing rather than posting an unready attachment', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(me()).mockResolvedValueOnce(json({ data: { id: '999', media_key: '3_999', expires_after_secs: 86400, processing_info: { state: 'pending' } } }));
    await expect(subject(fetcher).uploadPng(png)).rejects.toMatchObject({ reason: 'media_not_ready' });
  });

  it('reconciles exact caption plus the uploaded media key and known auto-appended media URL', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(me()).mockResolvedValueOnce(json({ data: [{ id: '456', text: reconcile.caption + ' https://t.co/photo', created_at: '2026-10-20T17:59:58Z', attachments: { media_keys: ['3_999'] }, entities: { urls: [{ url: 'https://t.co/photo', expanded_url: 'https://x.com/Kollens/status/456/photo/1' }] } }] }));
    expect(await subject(fetcher).reconcile(reconcile)).toEqual({ status: 'found', postId: '456', createdAt: '2026-10-20T17:59:58Z' });
    expect(fetcher.mock.calls[1][0]).toContain('/2/users/123/tweets?');
    expect(fetcher.mock.calls[1][0]).toContain('start_time=');
  });

  it.each(['https://kollens.com', 'https://kollens.com/'])('reconstructs the trusted website %s alongside an authenticated photo suffix', async expanded => {
    const input = { ...reconcile, caption: `${reconcile.caption}\nhttps://kollens.com` };
    const short = 'https://t.co/kollens';
    const text = `${reconcile.caption}\n${short} https://t.co/photo`;
    const fetcher = vi.fn().mockResolvedValueOnce(me()).mockResolvedValueOnce(json({ data: [{
      id: '456', text, created_at: '2026-10-20T17:59:58Z', attachments: { media_keys: ['3_999'] }, entities: { urls: [
        { start: text.indexOf(short), end: text.indexOf(short) + short.length, url: short, expanded_url: expanded },
        { start: text.indexOf('https://t.co/photo'), end: text.length, url: 'https://t.co/photo', expanded_url: 'https://x.com/Kollens/status/456/photo/1' },
      ] },
    }] }));
    expect(await subject(fetcher).reconcile(input)).toEqual({ status: 'found', postId: '456', createdAt: '2026-10-20T17:59:58Z' });
  });

  it.each(['unicode', 'utf16'])('checks actual entity spans with %s indices after emoji and multilingual names', async convention => {
    const prefix = '🟡 金狗 Token\n\nFacts';
    const short = 'https://t.co/kollens';
    const text = `${prefix}\n${short}`;
    const start = convention === 'unicode' ? Array.from(prefix + '\n').length : prefix.length + 1;
    const fetcher = vi.fn().mockResolvedValueOnce(me()).mockResolvedValueOnce(json({ data: [{
      id: '456', text, created_at: '2026-10-20T17:59:58Z', attachments: { media_keys: ['3_999'] },
      entities: { urls: [{ start, end: start + short.length, url: short, expanded_url: 'https://kollens.com' }] },
    }] }));
    expect(await subject(fetcher).reconcile({ ...reconcile, caption: `${prefix}\nhttps://kollens.com` })).toMatchObject({ status: 'found' });
  });

  it('uses note entities only with note text rather than substituting mismatched outer entities', async () => {
    const short = 'https://t.co/kollens';
    const text = `${reconcile.caption}\n${short}`;
    const post = { id: '456', text: 'outer truncated text', created_at: '2026-10-20T17:59:58Z', attachments: { media_keys: ['3_999'] },
      entities: { urls: [{ start: 0, end: short.length, url: short, expanded_url: 'https://evil.test' }] },
      note_tweet: { text, entities: { urls: [{ start: text.indexOf(short), end: text.length, url: short, expanded_url: 'https://kollens.com' }] } } };
    const fetcher = vi.fn().mockResolvedValueOnce(me()).mockResolvedValueOnce(json({ data: [post] }));
    expect(await subject(fetcher).reconcile({ ...reconcile, caption: `${reconcile.caption}\nhttps://kollens.com` })).toMatchObject({ status: 'found' });
    const wrong = vi.fn().mockResolvedValueOnce(me()).mockResolvedValueOnce(json({ data: [{ ...post, note_tweet: { text } }] }));
    expect(await subject(wrong).reconcile({ ...reconcile, caption: `${reconcile.caption}\nhttps://kollens.com` })).toEqual({ status: 'not_found' });
  });

  it.each([
    ['arbitrary destination', { expanded_url: 'https://evil.test' }],
    ['lookalike origin', { expanded_url: 'https://kollens.com.evil.test' }],
    ['userinfo spoof', { expanded_url: 'https://kollens.com@evil.test' }],
    ['insecure origin', { expanded_url: 'http://kollens.com' }],
    ['unexpected path', { expanded_url: 'https://kollens.com/other' }],
    ['unexpected query', { expanded_url: 'https://kollens.com?redirect=evil' }],
    ['display URL only', { expanded_url: 'https://evil.test', display_url: 'kollens.com' }],
    ['missing indices', { start: undefined, end: undefined }],
    ['negative indices', { start: -1 }],
    ['wrong indices', { start: 0 }],
    ['string indices', { start: '1' }],
    ['oversized indices', { end: Number.MAX_SAFE_INTEGER }],
    ['non t.co source', { url: 'https://evil.test' }],
  ])('never reconstructs a website from %s', async (_reason, override) => {
    const short = 'https://t.co/kollens';
    const text = `${reconcile.caption}\n${short}`;
    const entry = { start: text.indexOf(short), end: text.length, url: short, expanded_url: 'https://kollens.com', ...override };
    const fetcher = vi.fn().mockResolvedValueOnce(me()).mockResolvedValueOnce(json({ data: [{
      id: '456', text, created_at: '2026-10-20T17:59:58Z', attachments: { media_keys: ['3_999'] }, entities: { urls: [entry] },
    }] }));
    expect(await subject(fetcher).reconcile({ ...reconcile, caption: `${reconcile.caption}\nhttps://kollens.com` })).toEqual({ status: 'not_found' });
  });

  it('rejects duplicate website entities and does not use a website entity to erase a photo URL', async () => {
    const short = 'https://t.co/kollens';
    const text = `${reconcile.caption}\n${short}`;
    const entry = { start: text.indexOf(short), end: text.length, url: short, expanded_url: 'https://kollens.com' };
    const input = { ...reconcile, caption: `${reconcile.caption}\nhttps://kollens.com` };
    const fetcher = vi.fn().mockResolvedValueOnce(me()).mockResolvedValueOnce(json({ data: [{
      id: '456', text, created_at: '2026-10-20T17:59:58Z', attachments: { media_keys: ['3_999'] }, entities: { urls: [entry, entry] },
    }] }));
    expect(await subject(fetcher).reconcile(input)).toEqual({ status: 'not_found' });
    const wrongPhoto = vi.fn().mockResolvedValueOnce(me()).mockResolvedValueOnce(json({ data: [{
      id: '456', text: `${input.caption} ${short}`, created_at: '2026-10-20T17:59:58Z', attachments: { media_keys: ['3_999'] }, entities: { urls: [entry] },
    }] }));
    expect(await subject(wrongPhoto).reconcile(input)).toEqual({ status: 'not_found' });
  });

  it('does not infer a match from caption alone, wrong media, stale time or unrelated links', async () => {
    const posts = [
      { id: '451', text: reconcile.caption, created_at: '2026-10-20T17:59:58Z' },
      { id: '452', text: reconcile.caption, created_at: '2026-10-20T17:59:58Z', attachments: { media_keys: ['3_998'] } },
      { id: '453', text: reconcile.caption, created_at: '2026-10-19T17:59:58Z', attachments: { media_keys: ['3_999'] } },
      { id: '454', text: reconcile.caption + ' https://t.co/other', created_at: '2026-10-20T17:59:58Z', attachments: { media_keys: ['3_999'] }, entities: { urls: [{ url: 'https://t.co/other', expanded_url: 'https://example.com/' }] } },
    ];
    const fetcher = vi.fn().mockResolvedValueOnce(me()).mockResolvedValueOnce(json({ data: posts, meta: { result_count: 4 } }));
    expect(await subject(fetcher).reconcile(reconcile)).toEqual({ status: 'not_found' });
  });

  it('refuses inconclusive pagination instead of asserting absence', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(me()).mockResolvedValueOnce(json({ data: [], meta: { next_token: 'one' } })).mockResolvedValueOnce(json({ data: [], meta: { next_token: 'two' } }));
    await expect(subject(fetcher).reconcile(reconcile)).rejects.toMatchObject({ category: 'unavailable', reason: 'reconciliation_incomplete' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('does not interpret a partial provider error as an empty timeline', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(me()).mockResolvedValueOnce(json({ errors: [{ detail: 'private provider text' }] }));
    await expect(subject(fetcher).reconcile(reconcile)).rejects.toMatchObject({ category: 'unavailable', reason: 'timeline_invalid' });
  });

  it('loads at most five official recent posts using exact username identity', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ data: { id: '555', username: 'TokenProject' } })).mockResolvedValueOnce(json({ data: Array.from({ length: 8 }, (_, index) => ({ id: String(index + 1), text: 'Project says CA', created_at: '2026-10-20T17:00:00Z' })) }));
    const posts = await subject(fetcher).fetchOfficialPosts('TokenProject');
    expect(posts).toHaveLength(5);
    expect(posts[0].url).toBe('https://x.com/TokenProject/status/1');
    expect(fetcher.mock.calls[0][0]).toContain('/2/users/by/username/TokenProject');
    expect(fetcher.mock.calls[1][0]).toContain('max_results=5');
  });
});
