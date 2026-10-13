type UpdateListener = () => void;
type LifecycleTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
type StreamConnection = LifecycleTarget & Pick<EventSource, 'close'>;
type StreamOptions = {
  createEventSource?: ((url: string) => StreamConnection) | null;
  lifecycle?: LifecycleTarget;
  visibility?: LifecycleTarget & Pick<Document, 'visibilityState'>;
  isOnline?: () => boolean;
  now?: () => number;
};

/** One optional live connection per app; callers keep their normal polling fallback. */
export function createUpdateStream(options: StreamOptions = {}) {
  const createEventSource = options.createEventSource === undefined
    ? typeof EventSource === 'undefined' ? null : (url: string) => new EventSource(url)
    : options.createEventSource;
  const lifecycle = options.lifecycle ?? (typeof window === 'undefined' ? undefined : window);
  const visibility = options.visibility ?? (typeof document === 'undefined' ? undefined : document);
  const isOnline = options.isOnline ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const now = options.now ?? Date.now;
  const listeners = new Map<UpdateListener, number>();
  let source: StreamConnection | null = null;
  let releaseSource: (() => void) | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  const eligible = () => listeners.size > 0 && isOnline() && visibility?.visibilityState !== 'hidden';
  const cancelRetry = () => { if (retryTimer !== null) clearTimeout(retryTimer); retryTimer = null; };
  const disconnect = () => {
    source = null;
    releaseSource?.();
    releaseSource = null;
  };
  const retry = () => {
    if (retryTimer !== null || !eligible() || !createEventSource) return;
    const delay = Math.min(60_000, 2_000 * 2 ** Math.min(failures++, 5));
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
  };
  const connect = () => {
    if (source || !eligible() || !createEventSource) return;
    let connection: StreamConnection;
    try { connection = createEventSource('/api/stream'); }
    catch { retry(); return; }
    source = connection;
    let openedAt: number | null = null;
    const open = () => { if (source === connection) openedAt = now(); };
    const update = () => {
      if (source !== connection) return;
      failures = 0;
      for (const listener of listeners.keys()) listener();
    };
    const error = () => {
      if (source !== connection) return;
      if (openedAt !== null && now() - openedAt >= 30_000) failures = 0;
      // Closing disables the browser's unbounded automatic EventSource retries.
      disconnect();
      retry();
    };
    connection.addEventListener('open', open);
    connection.addEventListener('update', update);
    connection.addEventListener('error', error);
    releaseSource = () => {
      connection.removeEventListener('open', open);
      connection.removeEventListener('update', update);
      connection.removeEventListener('error', error);
      connection.close();
    };
  };
  const resume = () => {
    if (!eligible()) { cancelRetry(); disconnect(); return; }
    if (retryTimer === null) connect();
  };
  const subscribe = (listener: UpdateListener) => {
    listeners.set(listener, (listeners.get(listener) ?? 0) + 1);
    if (listeners.size === 1 && listeners.get(listener) === 1) {
      lifecycle?.addEventListener('online', resume);
      lifecycle?.addEventListener('offline', resume);
      visibility?.addEventListener('visibilitychange', resume);
    }
    resume();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const count = listeners.get(listener)!;
      if (count > 1) listeners.set(listener, count - 1);
      else listeners.delete(listener);
      if (listeners.size) return;
      cancelRetry(); disconnect(); failures = 0;
      lifecycle?.removeEventListener('online', resume);
      lifecycle?.removeEventListener('offline', resume);
      visibility?.removeEventListener('visibilitychange', resume);
    };
  };
  return { subscribe };
}

const updates = createUpdateStream();
export const subscribeToUpdates = updates.subscribe;
