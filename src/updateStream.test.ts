import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUpdateStream } from './updateStream';

class MockSource extends EventTarget { close = vi.fn(); }
class Visibility extends EventTarget { visibilityState: DocumentVisibilityState = 'visible'; }
const subscriptions: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { subscriptions.splice(0).forEach(stop => stop()); vi.clearAllTimers(); vi.useRealTimers(); });

function setup() {
  const sources: MockSource[] = [];
  const factory = vi.fn((_url: string) => { const source = new MockSource(); sources.push(source); return source; });
  const lifecycle = new EventTarget(), visibility = new Visibility();
  let online = true;
  const updates = createUpdateStream({ createEventSource: factory, lifecycle, visibility, isOnline: () => online });
  const subscribe = (listener: () => void) => { const stop = updates.subscribe(listener); subscriptions.push(stop); return stop; };
  return { sources, factory, lifecycle, visibility, subscribe, setOnline: (value: boolean) => { online = value; lifecycle.dispatchEvent(new Event(value ? 'online' : 'offline')); } };
}

describe('shared app update stream', () => {
  it('shares one connection across data subscriptions and closes only when the last subscriber leaves', () => {
    const { sources, factory, subscribe } = setup();
    const one = vi.fn(), two = vi.fn();
    const stopOne = subscribe(one), stopTwo = subscribe(two);
    expect(factory).toHaveBeenCalledExactlyOnceWith('/api/stream');
    sources[0].dispatchEvent(new Event('update'));
    expect(one).toHaveBeenCalledOnce(); expect(two).toHaveBeenCalledOnce();
    stopOne();
    expect(sources[0].close).not.toHaveBeenCalled();
    sources[0].dispatchEvent(new Event('update'));
    expect(one).toHaveBeenCalledOnce(); expect(two).toHaveBeenCalledTimes(2);
    stopTwo(); stopTwo();
    expect(sources[0].close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('deduplicates identical update callbacks without discarding an active subscription', () => {
    const { sources, subscribe } = setup();
    const listener = vi.fn();
    const one = subscribe(listener), two = subscribe(listener);
    sources[0].dispatchEvent(new Event('update'));
    expect(listener).toHaveBeenCalledOnce();
    one();
    sources[0].dispatchEvent(new Event('update'));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(sources[0].close).not.toHaveBeenCalled();
    two(); expect(sources[0].close).toHaveBeenCalledOnce();
  });

  it('closes failed browser connections and bounds repeated transport retries with increasing delays', () => {
    const { sources, factory, subscribe } = setup();
    subscribe(vi.fn());
    for (const delay of [2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
      const source = sources.at(-1)!;
      source.dispatchEvent(new Event('open'));
      source.dispatchEvent(new Event('error'));
      source.dispatchEvent(new Event('error'));
      expect(source.close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(1);
      const attempts = factory.mock.calls.length;
      vi.advanceTimersByTime(delay - 1);
      expect(factory).toHaveBeenCalledTimes(attempts);
      vi.advanceTimersByTime(1);
      expect(factory).toHaveBeenCalledTimes(attempts + 1);
    }
  });

  it('does not open another connection when a subscription joins during transport backoff', () => {
    const { sources, factory, subscribe } = setup();
    subscribe(vi.fn()); sources[0].dispatchEvent(new Event('error'));
    subscribe(vi.fn());
    expect(factory).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('resets backoff after receiving a real server update', () => {
    const { sources, factory, subscribe } = setup();
    subscribe(vi.fn());
    sources[0].dispatchEvent(new Event('error')); vi.advanceTimersByTime(2000);
    sources[1].dispatchEvent(new Event('error')); vi.advanceTimersByTime(4000);
    sources[2].dispatchEvent(new Event('update')); sources[2].dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(2000);
    expect(factory).toHaveBeenCalledTimes(4);
  });

  it('resets backoff after the connection remains open for thirty seconds', () => {
    const { sources, factory, subscribe } = setup();
    subscribe(vi.fn());
    sources[0].dispatchEvent(new Event('error')); vi.advanceTimersByTime(2000);
    sources[1].dispatchEvent(new Event('open')); vi.advanceTimersByTime(30000);
    sources[1].dispatchEvent(new Event('error')); vi.advanceTimersByTime(2000);
    expect(factory).toHaveBeenCalledTimes(3);
  });

  it('pauses failed connection retries offline and resumes when connectivity returns', () => {
    const { sources, factory, subscribe, setOnline } = setup();
    subscribe(vi.fn()); sources[0].dispatchEvent(new Event('error'));
    setOnline(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120000); expect(factory).toHaveBeenCalledOnce();
    setOnline(true); expect(factory).toHaveBeenCalledTimes(2);
    setOnline(true); expect(factory).toHaveBeenCalledTimes(2);
  });

  it('releases a hidden tab connection and opens one when it becomes visible', () => {
    const { sources, factory, subscribe, visibility } = setup();
    subscribe(vi.fn());
    visibility.visibilityState = 'hidden'; visibility.dispatchEvent(new Event('visibilitychange'));
    expect(sources[0].close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    subscribe(vi.fn()); expect(factory).toHaveBeenCalledOnce();
    visibility.visibilityState = 'visible'; visibility.dispatchEvent(new Event('visibilitychange'));
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('does not connect initially while the browser is offline', () => {
    const { factory, subscribe, setOnline } = setup();
    setOnline(false); subscribe(vi.fn());
    expect(factory).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    setOnline(true); expect(factory).toHaveBeenCalledOnce();
  });

  it('removes reconnect timers and lifecycle listeners when the last subscription ends', () => {
    const { sources, factory, subscribe, setOnline, visibility } = setup();
    const stop = subscribe(vi.fn()); sources[0].dispatchEvent(new Event('error'));
    stop();
    expect(vi.getTimerCount()).toBe(0);
    setOnline(false); setOnline(true); visibility.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(120000);
    expect(factory).toHaveBeenCalledOnce();
  });

  it('keeps subscriptions usable without EventSource support so caller polling can continue', () => {
    const updates = createUpdateStream({ createEventSource: null });
    const stop = updates.subscribe(vi.fn()); subscriptions.push(stop);
    expect(vi.getTimerCount()).toBe(0);
    expect(stop).not.toThrow();
  });

  it('does not propagate connection construction errors into the screen', () => {
    const factory = vi.fn(() => { throw new Error('Transport unavailable'); });
    const updates = createUpdateStream({ createEventSource: factory });
    const stop = updates.subscribe(vi.fn()); subscriptions.push(stop);
    expect(factory).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(factory).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(1);
  });
});
