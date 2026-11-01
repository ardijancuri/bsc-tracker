import { describe, expect, it, vi } from 'vitest';
import twitterText from 'twitter-text';
import type { TokenPostEvidence, TokenPostNarrative, TokenPostSource } from '../shared/xTokenPosts.js';
import { buildTokenPostCaption, collectTokenPostSources, prepareTokenPostContent, prepareTokenPostNarrative, sanitizeTokenPostIdentity, tokenPostOfficialUsername, tokenPostKolUsername, tokenPostSourceUrl, tokenPostVisibleText, tokenPostWeightedLength, validateTokenPostNarrative, type TokenPostContentOptions } from './xTokenPostContent.js';

const CA = '0x483c9746b455e296622945758437f8c7593b7777';
const NOW = Date.parse('2026-10-20T12:00:00Z');
const theme = 'A community meme inspired by sleepy orange cats';
const evidence: TokenPostEvidence = {
  version: 1, chainId: 56, token: { address: CA, name: 'Sleepy Cat', symbol: 'CAT', websiteUrl: 'https://sleepycat.example/', xUrl: 'https://x.com/sleepycat' },
  evaluatedAt: new Date(NOW).toISOString(), windowStart: new Date(NOW - 3600_000).toISOString(), blockNumber: 1234, blockHash: `0x${'a'.repeat(64)}`,
  quoteBlockNumber: 1234, quoteBlockHash: `0x${'a'.repeat(64)}`, quoteObservedAt: new Date(NOW).toISOString(), kolCount: 5, buyerCount: 4, sellerCount: 2,
  marketVolumeUsd: '25345.25', marketVolumeLowerBound: false, marketCapUsd: '153456.78', coverageComplete: true,
  participants: [{ wallet: `0x${'1'.repeat(40)}`, name: 'Cat trader', twitterUsername: 'cat_trader', side: 'both' }], tradeEvidenceIds: ['trade-1'], marketEvidenceIds: ['swap-1'],
};
const facts: TokenPostNarrative = { kind: 'facts_only', text: 'Narrative unavailable.', sourceIds: [], reason: 'openai_not_configured', aiAssisted: false };
function source(text = `${theme}. Contract: ${CA}`): TokenPostSource {
  return { id: 'source-1', kind: 'website', url: 'https://sleepycat.example/', text, contractAddress: CA, observedAt: new Date(NOW).toISOString() };
}
function responseFor(value: unknown, extras: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }], ...extras }));
}
function modelOptions(overrides: TokenPostContentOptions = {}): TokenPostContentOptions {
  return { apiKey: 'test-not-a-secret', now: () => NOW, fetchWebsite: vi.fn(async () => `${theme}. Contract: ${CA}`), ...overrides };
}

describe('automated token post deterministic captions', () => {
  it('uses recorded complete X usernames with the full CA, blank lines and the Kollens URL',()=>{
    const caption=buildTokenPostCaption(evidence,facts);
    expect(caption).toBe(`Sleepy Cat (CAT)\n\n5 KOLs still holding\nObserved market vol $25.35K · MCAP $153K\nKOLs: @cat_trader, +4 more\n\nCA: ${CA}\nhttps://kollens.com`);
    expect(twitterText.extractMentions(caption)).toEqual(['cat_trader']);
    expect(twitterText.extractUrls(caption)).toEqual(['https://kollens.com']);
    expect(tokenPostWeightedLength(caption)).toBeLessThanOrEqual(280);
    expect(caption).not.toContain('Cat trader');
  });
  it('does not require financial metrics or quotes to describe current holders',()=>{
    const caption=buildTokenPostCaption({...evidence,marketCapUsd:null,marketVolumeUsd:null,quoteObservedAt:null});
    expect(caption).toContain('5 KOLs still holding');expect(caption).not.toMatch(/MCAP|market vol|null|undefined/);
  });
  it.each(['Trader name','@valid @evil','https://evil.test/person','https://x.com/user/status/1','https://x.com.evil.test/user','user\u202e','user-name','x'.repeat(16)])('rejects invalid username input %s',raw=>{
    expect(tokenPostKolUsername(raw)).toBeNull();
  });
  it.each([['cat_trader','cat_trader'],['@Cat_Trader','Cat_Trader'],['https://x.com/cat_trader','cat_trader'],['https://twitter.com/cat_trader/','cat_trader']])('accepts a stored username or exact profile %s',(raw,expected)=>{
    expect(tokenPostKolUsername(raw)).toBe(expected);
  });
  it('does not infer usernames from display names or emit them when missing',()=>{
    const caption=buildTokenPostCaption({...evidence,participants:[{...evidence.participants[0],name:'@invented_user',twitterUsername:null}]});
    expect(caption).not.toContain('KOLs:');expect(caption).not.toContain('@invented_user');expect(caption).toContain('5 KOLs still holding');
  });
  it('allows only intended participant mentions and strips token metadata URLs/mentions',()=>{
    const caption=buildTokenPostCaption({...evidence,token:{...evidence.token,name:'Cat https://evil.test @attacker',symbol:'CAT @everyone'},
      participants:[{...evidence.participants[0],name:'Bad @attacker',twitterUsername:'@cat_trader'}]});
    expect(twitterText.extractMentions(caption)).toEqual(['cat_trader']);expect(twitterText.extractUrls(caption)).toEqual(['https://kollens.com']);
    expect(caption).not.toMatch(/evil|attacker|@everyone/);
    expect(sanitizeTokenPostIdentity('Cat @everyone https://evil.example evil.com\u202e #pump')).toBe('Cat pump');
  });
  it('deduplicates wallets and case-insensitive X handles without inventing more mentions',()=>{
    const people:TokenPostEvidence['participants']=[
      {wallet:'0x'+'1'.repeat(40),name:'One',twitterUsername:'first_user',side:'buy'},
      {wallet:'0x'+'1'.repeat(40),name:'Duplicate wallet',twitterUsername:'wrong_user',side:'buy'},
      {wallet:'0x'+'2'.repeat(40),name:'Same X account',twitterUsername:'FIRST_USER',side:'buy'},
      {wallet:'0x'+'3'.repeat(40),name:'Three',twitterUsername:'second_user',side:'buy'},
      {wallet:'bad',name:'Invalid wallet',twitterUsername:'wrong_user',side:'buy'}];
    const caption=buildTokenPostCaption({...evidence,participants:people});
    expect(twitterText.extractMentions(caption)).toEqual(['first_user','second_user']);expect(caption).toContain('+3 more');
  });
  it('fits long Unicode token names and full 15-character usernames without shortening handles',()=>{
    const people:TokenPostEvidence['participants']=Array.from({length:6},(_,i)=>({wallet:'0x'+String(i+1).repeat(40),name:'Name '+i,twitterUsername:'long_username_'+i,side:'buy'}));
    const caption=buildTokenPostCaption({...evidence,kolCount:6,token:{...evidence.token,name:'猫'.repeat(60),symbol:'CAT'.repeat(8)},participants:people});
    const mentions=twitterText.extractMentions(caption);expect(mentions.length).toBeGreaterThan(0);
    expect(mentions.every(m=>people.some(p=>p.twitterUsername===m))).toBe(true);
    expect(caption).not.toMatch(/@[A-Za-z0-9_]+…/);expect(tokenPostWeightedLength(caption)).toBeLessThanOrEqual(280);
    expect(caption.endsWith(`\n\nCA: ${CA}\nhttps://kollens.com`)).toBe(true);
  });
  it('never names more than five handles or more than the holder count',()=>{
    const people:TokenPostEvidence['participants']=Array.from({length:7},(_,i)=>({wallet:'0x'+String(i+1).repeat(40),name:'Name '+i,twitterUsername:'kol_'+i,side:'buy'}));
    const five=buildTokenPostCaption({...evidence,kolCount:7,participants:people});expect(twitterText.extractMentions(five)).toHaveLength(5);expect(five).toContain('+2 more');
    const two=buildTokenPostCaption({...evidence,kolCount:2,participants:people});expect(twitterText.extractMentions(two)).toHaveLength(2);expect(two).not.toContain('more');
  });
  it('keeps malformed financial facts invalid and never allows supplied narrative content',()=>{
    expect(()=>buildTokenPostCaption({...evidence,marketCapUsd:'NaN'})).toThrow();expect(()=>buildTokenPostCaption({...evidence,kolCount:Infinity})).toThrow();
    expect(()=>buildTokenPostCaption({...evidence,token:{...evidence.token,address:'bad'}})).toThrow();
    const caption=buildTokenPostCaption(evidence,{...facts,kind:'sourced',aiAssisted:true,text:'Narrative @attacker https://evil.test'});
    expect(caption).not.toMatch(/Narrative|evil|@attacker/);
  });
});

describe('bounded contract-matched project sources', () => {
  it('accepts public HTTPS only and validates exact official X profile paths', () => {
    for (const value of ['http://example.com', 'https://127.0.0.1', 'https://[::1]', 'https://2130706433', 'https://user:pass@example.com', 'https://example.com:3000', 'file:///a', 'https://foo.local', 'https://localhost']) expect(tokenPostSourceUrl(value)).toBeNull();
    expect(tokenPostSourceUrl('https://sleepycat.example/path#section')).toBe('https://sleepycat.example/path');
    expect(tokenPostOfficialUsername('https://x.com/sleepycat')).toBe('sleepycat');
    expect(tokenPostOfficialUsername('https://twitter.com/sleepycat/')).toBe('sleepycat');
    for (const value of ['https://evil.example/sleepycat', 'https://x.com/home', 'https://x.com/sleepycat/status/123', 'https://x.com/a?bad=true', 'https://x.com/name-that-is-too-long']) {
      // Query parameters do not alter author identity; all other examples are rejected.
      if (value.includes('?')) expect(tokenPostOfficialUsername(value)).toBe('a'); else expect(tokenPostOfficialUsername(value)).toBeNull();
    }
  });
  it('discards scripts/comments/head text before matching the CA', () => {
    expect(tokenPostVisibleText(`<head>head</head><script>${CA}</script><!-- hidden --> <b>Cat &amp; dog</b>`)).toBe('Cat & dog');
  });
  it('does not infer identity from symbol, hidden CA or another contract', async () => {
    for (const body of [`<script>${CA}</script><main>${theme}</main>`, `${theme} 0x${'a'.repeat(40)}`, `Sleepy Cat CAT ${theme}`, `${theme} ${CA}a`]) {
      expect(await collectTokenPostSources(evidence, { now: () => NOW, fetchWebsite: async () => body })).toEqual([]);
    }
  });
  it('gathers only bounded exact-contract posts from the requested official account', async () => {
    const fetchOfficialPosts = vi.fn(async () => [
      { id: '1', text: `${theme} ${CA}`, url: 'https://x.com/sleepycat/status/1', createdAt: new Date(NOW).toISOString() },
      { id: '2', text: 'CAT same ticker', url: 'https://x.com/sleepycat/status/2', createdAt: new Date(NOW).toISOString() },
      { id: '3', text: `${theme} ${CA}`, url: 'https://evil.example/3', createdAt: new Date(NOW).toISOString() },
      { id: '4', text: `${theme} ${CA}`, url: 'https://x.com/impersonator/status/4', createdAt: new Date(NOW).toISOString() },
    ]);
    const sources = await collectTokenPostSources(evidence, { now: () => NOW, fetchWebsite: async () => `<p>${theme} ${CA.toUpperCase().replace('0X', '0x')}</p>`, fetchOfficialPosts });
    expect(sources.map(item => item.kind)).toEqual(['website', 'x']);
    expect(sources.every(item => item.contractAddress === CA)).toBe(true);
    expect(fetchOfficialPosts).toHaveBeenCalledWith('sleepycat', expect.objectContaining({ maxResults: 5 }));
    expect(sources[1].url).toBe('https://x.com/sleepycat/status/1');
  });
  it('discovers a single official X handle from a contract-matched website when metadata has no X link', async () => {
    const fetchOfficialPosts = vi.fn(async () => [{ id: '1', text: `${theme} ${CA}`, url: 'https://x.com/sleepycat/status/1', createdAt: new Date(NOW).toISOString() }]);
    const sources = await collectTokenPostSources({ ...evidence, token: { ...evidence.token, xUrl: undefined } }, {
      now: () => NOW, fetchOfficialPosts,
      fetchWebsite: async () => `<p>${theme} ${CA}</p><a href="https://x.com/sleepycat">X</a><a href='https://twitter.com/SleepyCat'>Same identity</a>`,
    });
    expect(fetchOfficialPosts).toHaveBeenCalledWith('SleepyCat', expect.objectContaining({ maxResults: 5 }));
    // X usernames are case-insensitive, while host, exact author and post ID remain constrained.
    expect(sources.map(item => item.kind)).toEqual(['website', 'x']);
    fetchOfficialPosts.mockResolvedValue([{ id: '1', text: `${theme} ${CA}`, url: 'https://x.com/SleepyCat/status/1', createdAt: new Date(NOW).toISOString() }]);
    const matched = await collectTokenPostSources({ ...evidence, token: { ...evidence.token, xUrl: null } }, {
      now: () => NOW, fetchOfficialPosts, fetchWebsite: async () => `<p>${theme} ${CA}</p><a href='https://x.com/SleepyCat'>X</a>`,
    });
    expect(matched.map(item => item.kind)).toEqual(['website', 'x']);
  });
  it('does not guess between multiple website handles, or trust hidden links and pages without the CA', async () => {
    const token = { ...evidence.token, xUrl: undefined };
    for (const html of [
      `<p>${CA}</p><a href="https://x.com/cat1">One</a><a href="https://x.com/cat2">Two</a>`,
      `<p>${CA}</p><!-- <a href="https://x.com/sleepycat">hidden</a> --><script><a href="https://x.com/sleepycat">hidden</a></script>`,
      `<p>${CA}</p><a data-href="https://x.com/sleepycat">Not a link</a>`,
      `<p>${CA}</p><a title=" href='https://x.com/sleepycat' ">Quoted metadata, not a link</a>`,
      `<p>${CA}</p><a href="https://evil.example/x.com/sleepycat">Spoof</a>`,
      `<p>same ticker only</p><a href="https://x.com/sleepycat">X</a>`,
    ]) {
      const fetchOfficialPosts = vi.fn();
      await collectTokenPostSources({ ...evidence, token }, { now: () => NOW, fetchOfficialPosts, fetchWebsite: async () => html });
      expect(fetchOfficialPosts).not.toHaveBeenCalled();
    }
  });
  it('keeps configured metadata identity and still rejects discovered posts without exact CA', async () => {
    const fetchOfficialPosts = vi.fn(async () => [{ id: '1', text: 'same name but no contract', url: 'https://x.com/sleepycat/status/1', createdAt: new Date(NOW).toISOString() }]);
    const sources = await collectTokenPostSources(evidence, { now: () => NOW, fetchOfficialPosts, fetchWebsite: async () => `<p>${CA}</p><a href="https://x.com/different">X</a>` });
    expect(fetchOfficialPosts).toHaveBeenCalledWith('sleepycat', expect.objectContaining({ maxResults: 5 }));
    expect(sources.map(item => item.kind)).toEqual(['website']);
  });
  it('persists and reuses bounded sources with their original observation time', async () => {
    const get = vi.fn(async () => null as { sources: TokenPostSource[]; expiresAt: string } | null), set = vi.fn(async (_key: string, _value: { sources: TokenPostSource[]; expiresAt: string }) => {});
    const fetchWebsite = vi.fn(async () => `${theme} ${CA}`);
    const first = await collectTokenPostSources(evidence, { now: () => NOW, fetchWebsite, sourceCache: { get, set } });
    const stored = set.mock.calls[0][1];
    get.mockResolvedValue(stored);
    const second = await collectTokenPostSources(evidence, { now: () => NOW + 60_000, fetchWebsite, sourceCache: { get, set } });
    expect(second).toEqual(first);
    expect(second[0].observedAt).toBe(new Date(NOW).toISOString());
    expect(fetchWebsite).toHaveBeenCalledTimes(1);
  });
  it('does not trust corrupted or expired cached source identity', async () => {
    const fetchWebsite = vi.fn(async () => null);
    const cache = { get: vi.fn(async () => ({ sources: [source()], expiresAt: new Date(NOW + 1).toISOString() })), set: vi.fn(async () => {}) };
    expect(await collectTokenPostSources(evidence, { now: () => NOW, sourceCache: cache, fetchWebsite })).toEqual([]);
    cache.get.mockResolvedValue({ sources: [source()], expiresAt: new Date(NOW - 1).toISOString() });
    expect(await collectTokenPostSources(evidence, { now: () => NOW, sourceCache: cache, fetchWebsite })).toEqual([]);
    expect(fetchWebsite).toHaveBeenCalledTimes(1);
  });
});

describe('facts-only automated content and optional narrative helpers', () => {
  it('makes no research, cache or model calls for automated posts even when a key is configured', async () => {
    const responsesFetch = vi.fn(), fetchWebsite = vi.fn(), fetchOfficialPosts = vi.fn(), get = vi.fn(), set = vi.fn(), onDiagnostic = vi.fn();
    for (const apiKey of [null, 'test-not-a-secret']) {
      const result = await prepareTokenPostContent(evidence, { apiKey, fetchWebsite, fetchOfficialPosts, responsesFetch, sourceCache: { get, set }, onDiagnostic });
      expect(result.narrative).toEqual({ kind: 'facts_only', text: '', sourceIds: [], reason: 'narrative_disabled', aiAssisted: false });
      expect(result.caption).not.toMatch(/Narrative|Theme:|AI-assisted/);
      expect(result.caption.startsWith('Sleepy Cat (CAT)\n\n5 KOLs still holding')).toBe(true);
      expect(result.sources).toEqual([]);
    }
    expect(responsesFetch).not.toHaveBeenCalled(); expect(fetchWebsite).not.toHaveBeenCalled(); expect(fetchOfficialPosts).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
    expect(onDiagnostic).toHaveBeenCalledWith({ stage: 'model', outcome: 'narrative_disabled', requestCount: 0, durationMs: 0 });
  });
  it('makes no network or source calls when the optional helper has no key', async () => {
    const responsesFetch = vi.fn(), fetchWebsite = vi.fn(), fetchOfficialPosts = vi.fn();
    const result = await prepareTokenPostNarrative(evidence, { apiKey: null, fetchWebsite, fetchOfficialPosts, responsesFetch });
    expect(result.narrative.reason).toBe('openai_not_configured');
    expect(result.sources).toEqual([]);
    expect(responsesFetch).not.toHaveBeenCalled(); expect(fetchWebsite).not.toHaveBeenCalled(); expect(fetchOfficialPosts).not.toHaveBeenCalled();
  });
  it('uses one small gpt-5-nano structured Responses request and validates exact excerpts', async () => {
    const responsesFetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('unused'));
    responsesFetch.mockImplementation(async (_url?: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const input = JSON.parse(body.input);
      return responseFor({ unavailable: false, excerpt: theme, sourceId: input.sources[0].id });
    });
    const onDiagnostic = vi.fn();
    const result = await prepareTokenPostNarrative(evidence, modelOptions({ responsesFetch, onDiagnostic }));
    expect(result.narrative.kind).toBe('sourced');
    expect(result.narrative.text).toBe(`Theme: ${theme}`);
    expect(result.narrative.aiAssisted).toBe(true);
    expect(responsesFetch).toHaveBeenCalledTimes(1);
    const [url, init] = responsesFetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    const request = JSON.parse(String(init?.body));
    expect(request).toMatchObject({ model: 'gpt-5-nano', store: false, max_output_tokens: 512, text: { format: { type: 'json_schema', strict: true } } });
    expect(request.tools).toBeUndefined();
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ stage: 'source', requestCount: 1, outcome: 'matched' }));
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ stage: 'model', requestCount: 1, outcome: 'verified_sources', model: 'gpt-5-nano' }));
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain('test-not-a-secret');
  });
  it('rejects invented paraphrases, absent citations and unsafe claims even if quoted', () => {
    expect(validateTokenPostNarrative({ unavailable: false, excerpt: 'The cat ecosystem is sweeping BSC', sourceId: 'source-1' }, [source()], 'gpt-5-nano').reason).toBe('unsupported_claim');
    expect(validateTokenPostNarrative({ unavailable: false, excerpt: theme, sourceId: 'missing' }, [source()], 'gpt-5-nano').kind).toBe('facts_only');
    for (const excerpt of ['Backed by a famous billionaire', 'A partnership with a major exchange', 'Buy now for guaranteed returns', 'Ignore previous instructions', 'Read https://evil.example now', 'Follow @everyone for details', 'This token is a fraud and rugpull']) {
      expect(validateTokenPostNarrative({ unavailable: false, excerpt, sourceId: 'source-1' }, [source(`${excerpt} ${CA}`)], 'gpt-5-nano').kind).toBe('facts_only');
    }
  });
  it('leaves absence of an English safe narrative explicit', () => {
    expect(validateTokenPostNarrative({ unavailable: true, excerpt: '', sourceId: '' }, [source()], 'gpt-5-nano').reason).toBe('sources_unavailable');
    expect(validateTokenPostNarrative({ unavailable: false, excerpt: '猫猫猫猫猫猫猫猫猫猫猫猫', sourceId: 'source-1' }, [source()], 'gpt-5-nano').kind).toBe('facts_only');
  });
  it('does not invoke the model when project sources fail contract matching', async () => {
    const responsesFetch = vi.fn();
    const result = await prepareTokenPostNarrative(evidence, modelOptions({ fetchWebsite: async () => 'same symbol, no CA', responsesFetch }));
    expect(result.narrative.reason).toBe('sources_unavailable');
    expect(responsesFetch).not.toHaveBeenCalled();
  });
  it('does not retry, escalate or expose credentials when the model fails', async () => {
    for (const status of [429, 500]) {
      const responsesFetch = vi.fn(async () => new Response('provider details must not escape', { status }));
      const result = await prepareTokenPostNarrative(evidence, modelOptions({ responsesFetch }));
      expect(result.narrative.reason).toBe('model_unavailable');
      expect(responsesFetch).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain('provider details');
      expect(JSON.stringify(result)).not.toContain('test-not-a-secret');
    }
  });
  it('fails closed on malformed, refused, incomplete and oversized output', async () => {
    const responses = [new Response('{bad json'), responseFor({ unavailable: false, excerpt: theme, sourceId: 'source-1' }, { status: 'incomplete' }), new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }] })), new Response('x'.repeat(32_001))];
    for (const response of responses) {
      const result = await prepareTokenPostNarrative(evidence, modelOptions({ responsesFetch: vi.fn(async () => response) }));
      expect(result.narrative.kind).toBe('facts_only');
    }
  });
});
