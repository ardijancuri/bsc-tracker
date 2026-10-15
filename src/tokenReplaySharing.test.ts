import { afterEach, describe, expect, it, vi } from 'vitest';
import { shareTokenReplayFile, tokenReplaySharing } from './tokenReplaySharing';
import type { Token } from './types';
afterEach(() => vi.unstubAllGlobals());
const token = { address: '0x' + '1'.repeat(40), symbol: 'TEST', name: null } as Token;
describe('token replay sharing', () => {
  it('uses the token page and selected period in the editable X draft', () => {
    const details = tokenReplaySharing(token, '7d'), url = new URL(details.xIntent);
    expect(url.origin).toBe('https://x.com');
    expect(url.searchParams.get('url')).toBe(`https://kollens.com/token/${token.address}`);
    expect(url.searchParams.get('text')).toBe('TEST · 7d market-cap replay, tracked with kollens.');
  });
  it('shares the prepared file from the user click without regenerating it', async () => {
    const share = vi.fn().mockResolvedValue(undefined), file = new File(['frames'], 'test-token-replay.mp4', { type: 'video/mp4' });
    vi.stubGlobal('navigator', { canShare: () => true, share });
    await shareTokenReplayFile(file, token, '24h');
    expect(share).toHaveBeenCalledWith({ files: [file], title: 'TEST | kollens', text: 'TEST · 24h market-cap replay, tracked with kollens.' });
  });
  it('uses a safe fallback URL and normalizes untrusted token names', () => {
    const data = tokenReplaySharing({ ...token, address: 'javascript:bad', symbol: '  Long\n token  ' }, '30d');
    expect(data.name).toBe('Long token'); expect(data.url).toBe('https://kollens.com/');
  });
});
