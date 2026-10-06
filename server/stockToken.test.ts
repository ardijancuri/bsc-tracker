import { describe, expect, it } from 'vitest';
import { isMemeToken } from './memeToken.js';
import { isStockToken } from './stockToken.js';
import { stockTokenAddresses } from './stockTokenAddresses.js';

describe('tokenized securities filtering', () => {
  it.each([
    ['SPCXB', '0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1'],
    ['QQQB', '0x205812cdbed920aff76c6580abd681a46d11efc7'],
    ['NVDAB', '0x02fca66c1d1afb4e2a7884261eb00f63598a7436'],
    ['FXIon', '0x9b8e987e6fec8cf1380c4dca7071e2c7853aeea1'],
    ['AAPLon', '0x390a684ef9cade28a7ad0dfa61ab1eb3842618c4'],
  ])('excludes %s even without metadata or with a misleading meme logo', (symbol, address) => {
    expect(isStockToken(address)).toBe(true);
    expect(isStockToken(address.toUpperCase())).toBe(true);
    expect(isMemeToken({ address, symbol, logoUrl: 'https://genius.fun/api/image?src=stock' })).toBe(false);
  });

  it.each(['SPCXB', 'QQQB', 'bStocks', 'xStocks', '4Stock', 'NVDA6900'])('preserves a meme named %s at a different contract', symbol => {
    const address = '0x0000000000000000000000000000000000007777';
    expect(isStockToken(address)).toBe(false);
    expect(isMemeToken({ address, symbol, name: symbol })).toBe(true);
  });

  it('contains only unique, normalized BSC contracts', () => {
    expect(stockTokenAddresses.length).toBeGreaterThan(500);
    expect(new Set(stockTokenAddresses).size).toBe(stockTokenAddresses.length);
    expect(stockTokenAddresses.every(address => /^0x[0-9a-f]{40}$/.test(address))).toBe(true);
    expect(isStockToken('0xba2ae424d960c26247dd6c32edc70b295c744c43')).toBe(false);
  });
});
