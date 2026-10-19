type Visibility = Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & Pick<Document, 'visibilityState'>;

/** Keep live-update bursts bounded to one active read and one dirty flag.
 * Consumers must check their signal before publishing a response. */
export function createCoalescedRefresh(work: (signal: AbortSignal) => Promise<void>, options: {
  visibility?: Visibility; onError?(error: unknown): void;
} = {}) {
  const visibility = options.visibility ?? (typeof document === 'undefined' ? undefined : document);
  let disposed = false, dirty = false;
  let controller: AbortController | null = null, running: Promise<void> | null = null;
  const visible = () => visibility?.visibilityState !== 'hidden';
  const begin = (): Promise<void> => {
    if (running) return running;
    if (disposed || !visible() || !dirty) return Promise.resolve();
    // Assign ownership before invoking work, including synchronous callbacks.
    running = Promise.resolve().then(async () => {
      while (!disposed && visible() && dirty) {
        dirty = false;
        const current = new AbortController(); controller = current;
        try { await work(current.signal); }
        catch (error) { if (!current.signal.aborted && !disposed) options.onError?.(error); }
        finally { if (controller === current) controller = null; }
      }
    }).finally(() => {
      running = null;
      if (!disposed && visible() && dirty) void begin();
    });
    return running;
  };
  const refresh = () => {
    if (disposed) return Promise.resolve();
    dirty = true;
    return begin();
  };
  const visibilityChanged = () => {
    if (disposed) return;
    // Hidden tabs release their HTTP slot; one fresh read replaces any number
    // of missed broadcasts and interval ticks when the page becomes visible.
    if (!visible()) { dirty = true; controller?.abort(); }
    else void refresh();
  };
  visibility?.addEventListener('visibilitychange', visibilityChanged);
  return { refresh, dispose: () => {
    if (disposed) return;
    disposed = true; dirty = false;
    controller?.abort(); controller = null;
    visibility?.removeEventListener('visibilitychange', visibilityChanged);
  } };
}
