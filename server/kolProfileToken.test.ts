import { describe, expect, it } from 'vitest';
import { isExcludedKolProfileTokenAddress, isKolProfileToken, kolProfileTokenSql } from './kolProfileToken.js';

const meme = '0x409f0bcdc9a70565a71af56cb50b2a6688cb7777';

describe('KOL profile token eligibility', () => {
  it.each([
    ['XAUt', '0x21caef8a43163eea865baee23b9c2e327696a3bf'],
    ['BTCB', '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c'],
    ['xOPAI', '0x7ddef360f3c2db4cc41c3967984fefa2598cc9a6'],
    ['oANTHROPIC', '0x24b518b332543a4e1c3649d063dab199d103760a'],
    ['TRX', '0xce7de646e7208a4ef112cb6ed5038fa6cc6b12e3'],
    ['ZEC', '0x1ba42e5193dfa8b03d15dd1b86a3113bbbef8eeb'],
    ['user-excluded reward/pair asset', '0xce24439f2d9c6a2289f741120fe202248b666666'],
    ['user-excluded KOL profile asset', '0x000ae314e2a2172a039b26378814c252734f556a'],
    ['TRX (second contract)', '0x85eac5ac2f758618dfa09bdbe0cf174e7d574d5b'],
    ['TWT', '0x4b0f1812e5df2a09796481ff14017e6005508003'],
    ['SOL', '0x570a5d26f7765ecb712c0924e4de545b89fd43df'],
    ['UNI', '0xbf5140a22578168fd562dccf235e5d43a02ce9b1'],
    ['LISTA', '0xfceb31a79f71ac9cbdcf853519c1b12d379edc46'],
    ['lisUSD', '0x0782b6d8c4551b9760e74c0545a9bcd90bdc41e5'],
    ['XRP', '0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe'],
    ['UST', '0x23396cf899ca06c4472205fc903bdb4de249d6fc'],
    ['DOT', '0x7083609fce4d1d8dc0c979aab8c869ea2c873402'],
    ['LTC', '0x4338665cbb7b2485a8855a139b75d5e34ab0db94'],
    ['slisBNB', '0xb0b84d294e0c75a6abe60171b70edeb2efd14a1b'],
    ['NEAR', '0x1fa4a73a3f0133f0025378af00236f3abdee5d63'],
    ['AAVE', '0xfb6115445bff7b52feb98650c87f44907e58f802'],
    ['CMC20', '0x2f8a339b5889ffac4c5a956787cda593b3c36867'],
    ['pPOLY', '0x1d80392d12caaaf9e333bb0bb7f021eacf297fe6'],
    ['xKLSH', '0xe0cbb7ffc0883810569d84d78f02bbcb747cfe43'],
    ['wTCENTx', '0x41333df9e7639188bbfca5522dc4844398af9f9e'],
    ['wPOPMTx', '0x4ebf5fd25b02022afad96e2fa25da54a246fded0'],
    ['wXIAOx', '0x076cf393e701839fc7a5832d2c68aafa235682ae'],
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

  it.each(['XAUt', 'xOPAI', 'SPCXB', 'oANTHROPIC', 'TRX', 'ZEC', 'SOL', 'TWT', 'LISTA', 'lisUSD', 'XRP', 'UST', 'DOT', 'LTC', 'slisBNB', 'Tether Gold', 'Paimon Tradable OpenAI SPV Token', 'Dividend Dog', 'Rewards', 'Yield Meme'])('preserves an unrelated meme named %s', name => {
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
    expect(sql).toContain('0x24b518b332543a4e1c3649d063dab199d103760a');
    expect(sql).toContain('0xce7de646e7208a4ef112cb6ed5038fa6cc6b12e3');
    expect(sql).toContain('0x1ba42e5193dfa8b03d15dd1b86a3113bbbef8eeb');
    expect(sql).toContain('0xce24439f2d9c6a2289f741120fe202248b666666');
    expect(sql).toContain('0x000ae314e2a2172a039b26378814c252734f556a');
    expect(sql).toContain('0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1');
    expect(sql).toContain('\\mLP\\M');
    expect(sql).not.toContain('is_meme');
    expect(sql).not.toContain('logo_url');
    expect(kolProfileTokenSql()).toContain('lower(v.address)');
  });
});
