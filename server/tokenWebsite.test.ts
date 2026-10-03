import { afterEach, describe, expect, it, vi } from 'vitest';
import { flapWebsiteFromHtml, lookupTokenWebsite, websiteUrl } from './tokenWebsite.js';

const address = '0xbbf4431aacfc2b22dff09d2bc21fb0775c1c7777';
afterEach(() => vi.restoreAllMocks());

describe('token website metadata', () => {
  it('allows website URLs and rejects executable, credential and social links', () => {
    expect(websiteUrl('https://example.com/about?a=1&b=2')).toBe('https://example.com/about?a=1&b=2');
    for (const value of ['javascript:alert(1)', 'data:text/html,test', 'https://user:password@example.com', 'https://bscscan.com/token/test', 'https://x.com/token', '', null]) expect(websiteUrl(value)).toBeNull();
  });

  it('reads only the matching Flap token website and unescapes URL parameters', () => {
    const html = `\\"coin\\":{\\"address\\":\\"${address}\\",\\"metadata\\":{\\"website\\":\\"https:\\/\\/example.com?a=1\\u0026b=2\\"}}`;
    expect(flapWebsiteFromHtml(html, address)).toBe('https://example.com/?a=1&b=2');
    expect(flapWebsiteFromHtml(html, '0x207529c7aeed063e02fee9a1c07e801792b67777')).toBeNull();
  });

  it('ignores other tokens and falls back to matching GeckoTerminal metadata', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.includes('flap.sh')) return new Response('', { status: 404 });
      if (url.includes('dexscreener')) return Response.json([{ baseToken: { address: 'wrong' }, info: { websites: [{ url: 'https://wrong.example' }] } }]);
      return Response.json({ data: { attributes: { address, websites: ['https://bscscan.com/token/test', 'https://right.example'] } } });
    });
    expect(await lookupTokenWebsite(address)).toBe('https://right.example/');
  });

  it('reads long streamed Flap records without borrowing another token website', () => {
    const coin = { address, holders: 'x'.repeat(40000), metadata: { website: 'https://example.com/?a=1&b=2' } };
    const payload = JSON.stringify({ coin });
    const html = `<script>self.__next_f.push(${JSON.stringify([1, payload])})</script>`;
    expect(flapWebsiteFromHtml(html, address)).toBe('https://example.com/?a=1&b=2');
    const noWebsite = JSON.stringify({ coin: { address } });
    const other = JSON.stringify({ coin: { address: 'other', metadata: { website: 'https://wrong.example' } } });
    expect(flapWebsiteFromHtml(noWebsite + other, address)).toBeNull();
  });

  it('keeps unavailable website metadata optional', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('upstream unavailable'));
    expect(await lookupTokenWebsite(address)).toBeNull();
  });
});
