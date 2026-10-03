import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenTranslation } from '../shared/tokenTranslation';
import { TokenTranslationStore } from './tokenTranslations';

const address = `0x${'a'.repeat(40)}`;
const result = (key = address, source = '熊猫', name: string | null = 'Panda'): TokenTranslation => ({ tokenAddress: key, sourceText: source, englishName: name });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('shared token translations', () => {
  it('deduplicates repeated trade rows and reuses translations across pages', async () => {
    const lookup = vi.fn().mockResolvedValue(result());
    const store = new TokenTranslationStore(lookup);
    const trade = store.watch(address, '熊猫'), radar = store.watch(address.toUpperCase(), '熊猫');
    const changed = vi.fn(), radarChanged = vi.fn(), stopTrade = trade.subscribe(changed), stopRadar = radar.subscribe(radarChanged);
    await flush();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(trade.getSnapshot().englishName).toBe('Panda');
    expect(radar.getSnapshot()).toBe(trade.getSnapshot());
    expect(changed).toHaveBeenCalledTimes(1);
    expect(radarChanged).toHaveBeenCalledTimes(1);
    stopTrade(); stopRadar();
    const stopCard = store.watch(address, '熊猫').subscribe(changed);
    await flush();
    expect(lookup).toHaveBeenCalledTimes(1);
    stopCard();
  });

  it('limits requests to two and processes every queued token', async () => {
    const resolve: (() => void)[] = [];
    const lookup = vi.fn((key: string) => new Promise<TokenTranslation>(done => resolve.push(() => done(result(key)))));
    const store = new TokenTranslationStore(lookup);
    const stops = ['a', 'b', 'c', 'd'].map(char => store.watch(`0x${char.repeat(40)}`, '熊猫').subscribe(() => {}));
    await flush(); expect(lookup).toHaveBeenCalledTimes(2);
    resolve[0](); await flush(); expect(lookup).toHaveBeenCalledTimes(3);
    resolve[1](); await flush(); expect(lookup).toHaveBeenCalledTimes(4);
    resolve[2](); resolve[3](); await flush();
    stops.forEach(stop => stop());
  });

  it('skips queued identities that have left the page', async () => {
    const lookup = vi.fn().mockResolvedValue(result());
    const store = new TokenTranslationStore(lookup);
    const stop = store.watch(address, '熊猫').subscribe(() => {});
    stop(); await flush(); expect(lookup).not.toHaveBeenCalled();
  });

  it('retries missing translations without dropping or inventing names', async () => {
    vi.useFakeTimers();
    const lookup = vi.fn().mockResolvedValueOnce(result(address, '熊猫', null)).mockResolvedValue(result());
    const store = new TokenTranslationStore(lookup), entry = store.watch(address, '熊猫');
    const stop = entry.subscribe(() => {});
    await flush(); expect(entry.getSnapshot().englishName).toBeNull();
    await vi.advanceTimersByTimeAsync(59999); expect(lookup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(entry.getSnapshot().englishName).toBe('Panda');
    stop();
  });

  it('does not attach old metadata translations to a renamed token', async () => {
    const lookup = vi.fn().mockResolvedValue(result());
    const store = new TokenTranslationStore(lookup), entry = store.watch(address, '老虎');
    const stop = entry.subscribe(() => {});
    await flush(); expect(entry.getSnapshot().englishName).toBeNull();
    stop();
  });

  it('recovers from network errors and stops retries when no rows remain', async () => {
    vi.useFakeTimers();
    const lookup = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(result());
    const store = new TokenTranslationStore(lookup), entry = store.watch(address, '熊猫');
    const stop = entry.subscribe(() => {});
    await flush(); expect(entry.getSnapshot().englishName).toBeNull();
    stop(); await vi.advanceTimersByTimeAsync(60000); expect(lookup).toHaveBeenCalledTimes(1);
    const stopAgain = entry.subscribe(() => {}); await flush();
    expect(entry.getSnapshot().englishName).toBe('Panda'); stopAgain();
  });
});
