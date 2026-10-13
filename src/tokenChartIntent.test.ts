import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tokenChartIntent } from './tokenChartIntent';
import { preloadTokenChart } from './useTokenChart';

vi.mock('./useTokenChart', () => ({ preloadTokenChart: vi.fn() }));

const address = '0x' + 'a'.repeat(40);
const otherAddress = '0x' + 'b'.repeat(40);

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('chart intent preloading', () => {
  it('does not request charts merely because token rows render', () => {
    for (let index = 0; index < 50; index++) tokenChartIntent(`0x${index.toString(16).padStart(40, '0')}`);
    expect(preloadTokenChart).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels passing hovers before they request provider work', () => {
    const intent = tokenChartIntent(address);
    intent.onMouseEnter();
    vi.advanceTimersByTime(119);
    expect(preloadTokenChart).not.toHaveBeenCalled();
    intent.onMouseLeave();
    vi.advanceTimersByTime(1000);
    expect(preloadTokenChart).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps one hover timer as the pointer moves between tokens', () => {
    const first = tokenChartIntent(address), second = tokenChartIntent(otherAddress, '1m');
    first.onMouseEnter();
    vi.advanceTimersByTime(60);
    second.onMouseEnter();
    // A late leave from the previous token must not cancel the new target.
    first.onMouseLeave();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(120);
    expect(preloadTokenChart).toHaveBeenCalledExactlyOnceWith(otherAddress, '1m');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restarts the same target hover without creating duplicate timers', () => {
    const intent = tokenChartIntent(address);
    intent.onMouseEnter();
    vi.advanceTimersByTime(60);
    intent.onMouseEnter();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(119);
    expect(preloadTokenChart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(preloadTokenChart).toHaveBeenCalledExactlyOnceWith(address, '5m');
  });

  it.each(['onFocus', 'onPointerDown'] as const)('warms immediately on %s and cancels its pending hover', event => {
    const prepare = vi.fn();
    const intent = tokenChartIntent(address, '1h', prepare);
    intent.onMouseEnter();
    vi.advanceTimersByTime(60);
    intent[event]();
    expect(preloadTokenChart).toHaveBeenCalledExactlyOnceWith(address, '1h');
    expect(prepare).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(preloadTokenChart).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
  });
});
