import { describe, expect, it } from 'vitest';
import { isExcludedKolProfileTokenAddress, isKolProfileToken, kolProfileTokenSql } from './kolProfileToken.js';

const meme = '0x409f0bcdc9a70565a71af56cb50b2a6688cb7777';

describe('KOL profile token eligibility', () => {
  it.each([
    ['XAUt', '0x21caef8a43163eea865baee23b9c2e327696a3bf'],
    ['BTCB', '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c'],
    ['xOPAI', '0x7ddef360f3c2db4cc41c3967984fefa2598cc9a6'],
    ['SPCXB', '0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1'],
  ])('excludes the %s contract before metadata is available', (_symbol, address) => {
    expect(isExcludedKolProfileTokenAddress(address)).toBe(true);
    expect(isExcludedKolProfileTokenAddress(address.toUpperCase())).toBe(true);
    expect(isKolProfileToken({ address })).toBe(false);
    expect(isKolProfileToken({ address: address.toUpperCase(), symbol: 'MEME', name: 'Meme token' })).toBe(false);
  });

  it.each([
    ['BIBI', meme],
    ['SPA', '0x1a9fd6ec3144da3dd6ea13ec1c25c58423a379b1'],
    ['PEPE', '0x25d887ce7a35172c62febfd67a1856f20faebb00'],
    ['DOGE', '0xba2ae424d960c26247dd6c32edc70b295c744c43'],
    [null, '0x0000000000000000000000000000000000000123'],
  ])('preserves %s without requiring a known meme classification', (symbol, address) => {
    expect(isExcludedKolProfileTokenAddress(address)).toBe(false);
    expect(isKolProfileToken({ address, symbol })).toBe(true);
  });

  it.each(['XAUt', 'xOPAI', 'SPCXB', 'Tether Gold', 'Paimon Tradable OpenAI SPV Token', 'Dividend Dog', 'Rewards', 'Yield Meme'])('preserves an unrelated meme named %s', name => {
    expect(isKolProfileToken({ address: meme, symbol: name, name })).toBe(true);
  });

  it.each(['BNB', 'wbnb', 'ETH', 'WETH', 'BTC', 'BTCB', 'WBTC', 'USDT', 'USDC', 'BUSD', 'FDUSD', 'DAI', 'USD1', 'CAKE', 'UNI-V2', 'Cake-LP', 'Pancake-LP'])('excludes the existing quote/pool symbol %s', symbol => {
    expect(isKolProfileToken({ address: meme, symbol })).toBe(false);
  });

  it.each(['ETHBack_Dividend_Tracker', 'DIVIDEND TRACKER', 'DividendTracker', 'Pancake LP', 'Liquidity Token'])('excludes auxiliary metadata %s in either field', name => {
    expect(isKolProfileToken({ address: meme, symbol: name })).toBe(false);
    expect(isKolProfileToken({ address: meme, symbol: 'OTHER', name })).toBe(false);
  });

  it('keeps missing metadata and LP substrings that are not a word', () => {
    expect(isKolProfileToken({ address: meme, symbol: null, name: null })).toBe(true);
    expect(isKolProfileToken({ address: meme, symbol: 'ALPHA', name: 'Help' })).toBe(true);
  });

  it('renders the same exclusions for token query aliases without a positive meme gate', () => {
    const sql = kolProfileTokenSql('asset');
    expect(sql).toContain('lower(asset.address)');
    expect(sql).toContain("COALESCE(asset.symbol,'') !~*");
    expect(sql).toContain("concat_ws(' ',asset.symbol,asset.name)");
    expect(sql).toContain('0x21caef8a43163eea865baee23b9c2e327696a3bf');
    expect(sql).toContain('0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c');
    expect(sql).toContain('0x7ddef360f3c2db4cc41c3967984fefa2598cc9a6');
    expect(sql).toContain('0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1');
    expect(sql).toContain('\\mLP\\M');
    expect(sql).not.toContain('is_meme');
    expect(sql).not.toContain('logo_url');
    expect(kolProfileTokenSql()).toContain('lower(v.address)');
  });
});
