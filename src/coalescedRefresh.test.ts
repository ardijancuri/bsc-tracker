import { describe, expect, it, vi } from 'vitest';
import { createCoalescedRefresh } from './coalescedRefresh';

class Visibility extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
  set(value: DocumentVisibilityState) { this.visibilityState = value; this.dispatchEvent(new Event('visibilitychange')); }
}
const turn = async () => { await Promise.resolve(); await Promise.resolve(); };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }

describe('bounded background API refreshes', () => {
  it('coalesces a burst during one read into exactly one trailing read', async () => {
    const visibility = new Visibility(), first = deferred(), second = deferred();
    const work = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const refresh = createCoalescedRefresh(work, { visibility });
    const done = refresh.refresh(); await turn();
    expect(work).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 100; index++) expect(refresh.refresh()).toBe(done);
    expect(work).toHaveBeenCalledTimes(1);
    first.resolve(); await turn(); expect(work).toHaveBeenCalledTimes(2);
    second.resolve(); await done; expect(work).toHaveBeenCalledTimes(2);
    refresh.dispose();
  });
  it('keeps later update bursts bounded while an earlier trailing read is still active', async () => {
    const visibility = new Visibility(), reads = [deferred(), deferred(), deferred()];
    let active = 0, maximum = 0;
    const work = vi.fn(async () => { const index = work.mock.calls.length - 1; maximum = Math.max(maximum, ++active); await reads[index].promise; active--; });
    const refresh = createCoalescedRefresh(work, { visibility });
    const done = refresh.refresh(); await turn();
    void refresh.refresh(); reads[0].resolve(); await turn();
    for (let index = 0; index < 100; index++) void refresh.refresh();
    expect(work).toHaveBeenCalledTimes(2); reads[1].resolve(); await turn();
    expect(work).toHaveBeenCalledTimes(3); expect(maximum).toBe(1);
    reads[2].resolve(); await done; refresh.dispose();
  });
  it('aborts a disposed hook read and discards queued work', async () => {
    const visibility = new Visibility();
    let signal!: AbortSignal;
    const work = vi.fn((current: AbortSignal) => { signal = current; return new Promise<void>((_resolve, reject) => current.addEventListener('abort', () => reject(current.reason), { once: true })); });
    const onError = vi.fn(), refresh = createCoalescedRefresh(work, { visibility, onError });
    const done = refresh.refresh(); await turn(); void refresh.refresh();
    refresh.dispose(); refresh.dispose();
    expect(signal.aborted).toBe(true); await done;
    await refresh.refresh(); visibility.set('hidden'); visibility.set('visible'); await turn();
    expect(work).toHaveBeenCalledTimes(1); expect(onError).not.toHaveBeenCalled();
  });
  it('keeps late responses from an obsolete hook from publishing after cleanup', async () => {
    const visibility = new Visibility(), read = deferred(), publish = vi.fn();
    const refresh = createCoalescedRefresh(async signal => { await read.promise; if (!signal.aborted) publish(); }, { visibility });
    const done = refresh.refresh(); await turn(); refresh.dispose(); read.resolve(); await done;
    expect(publish).not.toHaveBeenCalled();
  });
  it('does not read while initially hidden and replaces all missed updates with one visible refresh', async () => {
    const visibility = new Visibility(); visibility.set('hidden');
    const work = vi.fn().mockResolvedValue(undefined), refresh = createCoalescedRefresh(work, { visibility });
    for (let index = 0; index < 100; index++) await refresh.refresh();
    expect(work).not.toHaveBeenCalled(); visibility.set('visible'); await turn();
    expect(work).toHaveBeenCalledTimes(1); refresh.dispose();
  });
  it('releases a hidden page HTTP request and refreshes once when it becomes visible', async () => {
    const visibility = new Visibility(), first = deferred();
    const signals: AbortSignal[] = [], publish = vi.fn();
    const work = vi.fn(async (signal: AbortSignal) => { signals.push(signal); if (signals.length === 1) await first.promise; if (!signal.aborted) publish(); });
    const refresh = createCoalescedRefresh(work, { visibility });
    const done = refresh.refresh(); await turn(); visibility.set('hidden');
    expect(signals[0].aborted).toBe(true);
    for (let index = 0; index < 20; index++) void refresh.refresh();
    first.resolve(); await done; expect(work).toHaveBeenCalledTimes(1); expect(publish).not.toHaveBeenCalled();
    visibility.set('visible'); await turn();
    expect(work).toHaveBeenCalledTimes(2); expect(signals[1].aborted).toBe(false); expect(publish).toHaveBeenCalledTimes(1);
    refresh.dispose();
  });
  it('retains a visible refresh requested before an aborted hidden read has settled', async () => {
    const visibility = new Visibility(), first = deferred(), work = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);
    const refresh = createCoalescedRefresh(work, { visibility });
    const done = refresh.refresh(); await turn(); visibility.set('hidden'); visibility.set('visible');
    expect(work).toHaveBeenCalledTimes(1); first.resolve(); await done;
    expect(work).toHaveBeenCalledTimes(2); refresh.dispose();
  });
  it('handles a failed read and still runs its one pending refresh', async () => {
    const visibility = new Visibility(), first = deferred(), onError = vi.fn();
    const work = vi.fn().mockImplementationOnce(async () => { await first.promise; throw new Error('Temporary failure'); }).mockResolvedValue(undefined);
    const refresh = createCoalescedRefresh(work, { visibility, onError });
    const done = refresh.refresh(); await turn(); void refresh.refresh(); first.resolve(); await done;
    expect(work).toHaveBeenCalledTimes(2); expect(onError).toHaveBeenCalledTimes(1);
    await refresh.refresh(); expect(work).toHaveBeenCalledTimes(3); refresh.dispose();
  });
  it('records ownership before a synchronous callback requests another refresh', async () => {
    const visibility = new Visibility();
    const work = vi.fn(async () => { if (work.mock.calls.length === 1) void refresh.refresh(); });
    const refresh = createCoalescedRefresh(work, { visibility });
    await refresh.refresh(); expect(work).toHaveBeenCalledTimes(2); refresh.dispose();
  });
});
