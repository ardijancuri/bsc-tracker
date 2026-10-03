import { describe, expect, it } from 'vitest';
import { isMemeToken } from './memeToken.js';

describe('meme coin classification', () => {
  const address = '0x0000000000000000000000000000000000004444';
  it('accepts launchpad tokens and known memes without a launchpad suffix', () => {
    expect(isMemeToken({ address, symbol: 'MEME' })).toBe(true);
    expect(isMemeToken({ address: '0xba2ae424d960c26247dd6c32edc70b295c744c43', symbol: 'DOGE' })).toBe(true);
    expect(isMemeToken({ address: '0x0000000000000000000000000000000000000123', logoUrl: 'https://genius.fun/api/image?src=ipfs' })).toBe(true);
  });
  it.each(['WBNB', 'USDT', 'BTCB', 'CAKE', 'Cake-LP', 'ETHBack_Dividend_Tracker'])('rejects quote, pair and tracker token %s', symbol => {
    expect(isMemeToken({ address, symbol })).toBe(false);
  });
  it('rejects confirmed pools and unknown assets', () => {
    expect(isMemeToken({ address, symbol: 'MEME' }, true)).toBe(false);
    expect(isMemeToken({ address: '0x0000000000000000000000000000000000000123', symbol: 'SPCXB' })).toBe(false);
  });
});
