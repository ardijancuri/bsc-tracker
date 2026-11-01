import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { TokenPostEvidence, TokenPostNarrative } from '../shared/xTokenPosts.js';
import { renderXTokenPostCard, renderXTokenPostCardSvg } from './xTokenPostCard.js';

const evidence: TokenPostEvidence = {
  version: 1, chainId: 56, token: { address: '0x25e3fe8c2bea75768591f63d26c7530690057777', name: 'Kollens test token', symbol: 'TEST' },
  evaluatedAt: '2026-10-20T18:00:00Z', windowStart: '2026-10-20T17:00:00Z', blockNumber: 100, blockHash: '0x' + '1'.repeat(64),
  quoteBlockNumber: 100, quoteBlockHash: '0x' + '1'.repeat(64), quoteObservedAt: '2026-10-20T18:00:00Z',
  kolCount: 6, buyerCount: 5, sellerCount: 2, marketVolumeUsd: '100000.25', marketVolumeLowerBound: false, marketCapUsd: '250000.78',
  participants: Array.from({ length: 6 }, (_, index) => ({ wallet: '0x' + String(index).repeat(40), name: ['CryptoCharming', '阿峰_Afeng', 'Rell', 'Cowboy BNB', 'AntPositions', 'Sixth trader'][index], side: index % 2 ? 'sell' : 'buy' })),
  tradeEvidenceIds: ['trade'], marketEvidenceIds: ['market'], coverageComplete: true,
};
const narrative: TokenPostNarrative = { kind: 'facts_only', text: '', reason: 'openai_not_configured', sourceIds: [], aiAssisted: false };

describe('Kollens automated token card', () => {
  it('renders missing optional financial metrics as dashes without blocking a holdings-qualified token', async () => {
    const optional = { ...evidence, version: 2 as const, marketVolumeUsd: null, marketCapUsd: null };
    const svg = await renderXTokenPostCardSvg({ evidence: optional, narrative });
    expect(svg).toContain('aria-label="—"'); expect(svg).not.toContain('$0');
    expect(svg).not.toContain('Observed volume');
    expect(svg).not.toContain('x="524" y="247"');
    expect(svg).toContain('font-size="108"');
    expect((await sharp(await renderXTokenPostCard({ evidence: optional, narrative })).metadata()).width).toBe(1200);
  });
  it('renders a clean full-size static PNG with the main identity and trading details', async () => {
    const png = await renderXTokenPostCard({ evidence, narrative });
    const metadata = await sharp(png).metadata();
    expect(metadata).toMatchObject({ format: 'png', width: 1200, height: 675 });
    expect(png.length).toBeLessThan(5_000_000);
    const svg = await renderXTokenPostCardSvg({ evidence, narrative });
    expect(svg).toContain(evidence.token.name); expect(svg).toContain('$TEST');
    expect(svg).toContain('$100K'); expect(svg).toContain('$250K');
    expect(svg).toContain('Observed volume · 1h'); expect(svg).toContain('Market cap');
    expect(svg).not.toContain('KOLs'); expect(svg).not.toContain('buyers'); expect(svg).not.toContain('sellers');
    expect(svg).not.toContain(evidence.token.address); expect(svg).not.toContain('>CA<');
    expect(svg).not.toContain('20 Oct 2026'); expect(svg).not.toContain('18:00 UTC');
    expect(svg).not.toContain('Buyer / seller counts may overlap');
    expect(svg).not.toContain('FACTS ONLY'); expect(svg).not.toContain('Narrative unavailable.');
    expect(svg).not.toContain('Confirmed buys and sells'); expect(svg).not.toContain('from public KOL wallets.');
    expect(svg).toContain('kollens.com');
    for (const person of evidence.participants) expect(svg).not.toContain(person.name);
    expect(svg).not.toContain('KOL activity');
    expect(svg).not.toContain('<rect x="46" y="577"');
  });

  it('shows observed volume without comparison symbols, narrative or KOL content', async () => {
    const lowerBoundEvidence = { ...evidence, marketVolumeLowerBound: true };
    const svg = await renderXTokenPostCardSvg({ evidence: lowerBoundEvidence, narrative: { ...narrative, kind: 'sourced', text: 'A community meme centered on a cat mascot.', reason: 'verified_sources', aiAssisted: true, sourceIds: ['website'] } });
    expect(svg).toContain('Observed volume · 1h'); expect(svg).toContain('$100K');
    expect(svg).not.toContain('≥'); expect(svg).not.toContain('&gt;');
    expect(svg).not.toContain('AI-ASSISTED NARRATIVE'); expect(svg).not.toContain('SOURCED NARRATIVE');
    expect(svg).not.toContain('A community meme centered on a cat mascot.');
    expect(svg).not.toContain('FACTS ONLY'); expect(svg).not.toContain('Narrative unavailable.');
    expect(svg).toBe(await renderXTokenPostCardSvg({ evidence: lowerBoundEvidence, narrative }));
    expect(svg).toBe(await renderXTokenPostCardSvg({ evidence, narrative }));
  });

  it('escapes SVG, removes controls and unsolicited URLs/mentions, and bounds long multilingual names', async () => {
    const svg = await renderXTokenPostCardSvg({ evidence: { ...evidence, token: { ...evidence.token, name: '<script>Bad</script> @scam https://evil.test\u202e', symbol: 'X&Y' }, participants: [{ ...evidence.participants[0], name: '阿峰'.repeat(200) }] }, narrative });
    expect(svg).not.toContain('<script>'); expect(svg).toContain('&lt;script&gt;');
    expect(svg).not.toContain('https://evil.test'); expect(svg).not.toContain('@scam'); expect(svg).not.toContain('\u202e');
    expect(svg).toContain('X&amp;Y'); expect(svg).not.toContain('阿峰'.repeat(20));
  });

  it('normalizes optional cached image bytes and ignores invalid, animated, SVG or oversized content', async () => {
    const cached = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#f9c932' } }).png().toBuffer();
    const svg = await renderXTokenPostCardSvg({ evidence, narrative, tokenAvatar: cached });
    // The only raster is the actual token artwork; background and ring are vectors.
    expect(svg.match(/data:image\/png;base64,/g)).toHaveLength(1);
    expect(svg).not.toContain('<script>');
    for (const tokenAvatar of [Buffer.alloc(512_001), Buffer.from('<svg><script>bad</script></svg>')]) {
      const invalid = await renderXTokenPostCardSvg({ evidence, narrative, tokenAvatar });
      expect(invalid).not.toContain('data:image/png;base64,');
    }
  });

  it('fails closed on invalid contract, financial numbers and observation time', async () => {
    await expect(renderXTokenPostCard({ evidence: { ...evidence, token: { ...evidence.token, address: 'short CA' } }, narrative })).rejects.toThrow('Invalid token card evidence');
    await expect(renderXTokenPostCard({ evidence: { ...evidence, marketCapUsd: 'NaN' }, narrative })).rejects.toThrow('Invalid token card metric');
    await expect(renderXTokenPostCard({ evidence: { ...evidence, evaluatedAt: 'unknown' }, narrative })).rejects.toThrow('Invalid token card evidence');
  });
});
