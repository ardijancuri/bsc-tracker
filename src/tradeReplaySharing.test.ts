import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TradeReplayData } from './tradeReplayData';
import { shareableTradeReplay, shareTradeReplayFile, tradeReplayXIntent } from './tradeReplaySharing';

afterEach(() => { vi.unstubAllGlobals(); });

function replay(): TradeReplayData {
  return {
    kol: { address: '0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD', name: 'Tavern', avatarUrl: null, twitter: null },
    token: { address: '0x2222222222222222222222222222222222222222', symbol: 'SAFU', name: 'Safu', logoUrl: null, priceUsd: null, marketCapUsd: null },
    trades: [],
    position: { status: 'unknown', tokenBalance: null, tradeFlowMatched: false, tradesComplete: false, checkedAt: null },
    chart: { points: [], marketCapSupply: null, resolution: '5m', source: 'Recorded fills' },
    source: { chart: 'Recorded fills', tradesComplete: false },
    generatedAt: '2026-10-11T12:00:00Z',
  };
}

function video(): File {
  return new File(['recorded video'], 'tavern-safu-trade-replay.mp4', { type: 'video/mp4' });
}

describe('replay X draft', () => {
  it('uses an editable draft with the exact validated lower-case KOL page and no fabricated profit', () => {
    const intent = new URL(tradeReplayXIntent(replay()));
    expect(intent.origin).toBe('https://x.com');
    expect(intent.pathname).toBe('/intent/post');
    expect(intent.searchParams.get('url')).toBe('https://kollens.com/kol/0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
    expect(intent.searchParams.get('text')).toBe("Tavern's SAFU trade replay, tracked with kollens.");
    expect([...intent.searchParams.keys()]).toEqual(['text', 'url']);
  });

  it('encodes Unicode and query syntax as text while normalizing whitespace', () => {
    const data = replay();
    data.kol.name = '  旺柴\n & ? trader  ';
    data.token.symbol = 'GM + #1 = %';
    const intent = new URL(tradeReplayXIntent(data));
    expect(intent.searchParams.get('text')).toBe("旺柴 & ? trader's GM + #1 = % trade replay, tracked with kollens.");
    expect(intent.hash).toBe('');
    expect([...intent.searchParams.keys()]).toEqual(['text', 'url']);
  });

  it('bounds names by whole Unicode characters and falls back safely for an invalid wallet', () => {
    const data = replay();
    data.kol.name = '🐢'.repeat(120);
    data.token.symbol = 'A'.repeat(120);
    data.kol.address = '0x1234?redirect=https://other.example/';
    const intent = new URL(tradeReplayXIntent(data));
    expect(intent.searchParams.get('text')).toBe(`${'🐢'.repeat(50)}'s ${'A'.repeat(50)} trade replay, tracked with kollens.`);
    expect(intent.searchParams.get('url')).toBe('https://kollens.com/');
  });

  it('uses neutral labels when display names are missing', () => {
    const data = replay();
    data.kol.name = '   ';
    data.token.symbol = null;
    data.token.name = null;
    expect(new URL(tradeReplayXIntent(data)).searchParams.get('text')).toBe("KOL's Token trade replay, tracked with kollens.");
  });
});

describe('native replay file sharing', () => {
  it('requires both native share functions and safely rejects unavailable or throwing file support', () => {
    const file = video();
    vi.stubGlobal('navigator', undefined);
    expect(shareableTradeReplay(file)).toBe(false);
    vi.stubGlobal('navigator', { canShare: vi.fn(() => true) });
    expect(shareableTradeReplay(file)).toBe(false);
    vi.stubGlobal('navigator', { share: vi.fn() });
    expect(shareableTradeReplay(file)).toBe(false);
    vi.stubGlobal('navigator', { share: vi.fn(), canShare: vi.fn(() => false) });
    expect(shareableTradeReplay(file)).toBe(false);
    vi.stubGlobal('navigator', { share: vi.fn(), canShare: vi.fn(() => { throw new Error('Policy blocked'); }) });
    expect(shareableTradeReplay(file)).toBe(false);
  });

  it('checks and hands off the exact generated file without a separate link', async () => {
    const file = video();
    const canShare = vi.fn(() => true);
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { canShare, share });
    await shareTradeReplayFile(file, replay());
    expect(canShare).toHaveBeenCalledWith({ files: [file] });
    expect(share).toHaveBeenCalledOnce();
    expect(share).toHaveBeenCalledWith({ files: [file], title: 'Tavern · SAFU | kollens', text: "Tavern's SAFU trade replay, tracked with kollens." });
    expect(share.mock.calls[0][0].files[0]).toBe(file);
    expect(share.mock.calls[0][0]).not.toHaveProperty('url');
  });

  it('returns manual attachment instructions without pretending a file was shared', async () => {
    const share = vi.fn();
    vi.stubGlobal('navigator', { canShare: () => false, share });
    await expect(shareTradeReplayFile(video(), replay())).rejects.toThrow('File sharing is unavailable. Download the video and attach it on X.');
    expect(share).not.toHaveBeenCalled();
  });

  it('preserves cancelled sharing and other native errors for the caller', async () => {
    const cancelled = new DOMException('Cancelled by user', 'AbortError');
    const share = vi.fn().mockRejectedValue(cancelled);
    vi.stubGlobal('navigator', { canShare: () => true, share });
    await expect(shareTradeReplayFile(video(), replay())).rejects.toBe(cancelled);
    const denied = new DOMException('Policy blocked', 'NotAllowedError');
    share.mockRejectedValue(denied);
    await expect(shareTradeReplayFile(video(), replay())).rejects.toBe(denied);
  });
});
