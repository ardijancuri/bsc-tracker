import { afterEach, describe, expect, it, vi } from 'vitest';
import { chineseTokenName, fetchEnglishName, translatedName } from './tokenTranslation.js';

afterEach(() => vi.restoreAllMocks());
const response = (text: unknown) => ({ responseStatus: 200, responseData: { translatedText: text } });
describe('Chinese token names', () => {
  it('uses the full Chinese name, falling back to a Chinese symbol', () => {
    expect(chineseTokenName({ name: '  毛毯小象 ', symbol: 'ELEPHANT' })).toBe('毛毯小象');
    expect(chineseTokenName({ name: 'Coin', symbol: '团力克' })).toBe('团力克');
    expect(chineseTokenName({ symbol: 'BNB 熊猫 🐼' })).toBe('BNB 熊猫 🐼');
    expect(chineseTokenName({ name: '財富自由' })).toBe('財富自由');
  });
  it('skips English, Japanese, Korean, invalid and overlong metadata', () => {
    for (const symbol of ['Bitcoin', 'お金', '富カネ', '한국漢', '熊猫\0', '熊'.repeat(167)]) expect(chineseTokenName({ symbol })).toBeNull();
    expect(chineseTokenName({ name: null, symbol: null })).toBeNull();
  });
});
describe('English translation responses', () => {
  it('reads plain English and decodes entities without displaying markup', () => {
    expect(translatedName(response(' Blanket elephant '), '毛毯小象')).toBe('Blanket elephant');
    expect(translatedName(response('Bear &amp; bull &#39;club&#39;'), '熊牛')).toBe("Bear & bull 'club'");
    expect(translatedName(response('&lt;script&gt;test&lt;/script&gt;'), '熊猫')).toBeNull();
  });
  it('rejects failed, quota, untranslated and malformed results', () => {
    for (const value of [null, [], { responseStatus: 429 }, { ...response('LIMIT REACHED'), quotaFinished: true }, response('熊猫'), response('🐼'), response(42), response('x'.repeat(301))]) expect(translatedName(value, '熊猫')).toBeNull();
  });
  it('sends only the name and language pair to the fixed translation provider', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(response('Panda')));
    expect(await fetchEnglishName('熊猫')).toEqual({ text: 'Panda', limited: false });
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.origin).toBe('https://api.mymemory.translated.net');
    expect([...url.searchParams.entries()]).toEqual([['q', '熊猫'], ['langpair', 'zh-CN|en']]);
  });
  it('recognizes provider rate limits without treating their messages as names', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 429 }));
    expect(await fetchEnglishName('熊猫')).toEqual({ text: null, limited: true });
  });
  it('keeps timeouts and upstream failures optional', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('timeout'));
    expect(await fetchEnglishName('熊猫')).toEqual({ text: null, limited: false });
  });
});
