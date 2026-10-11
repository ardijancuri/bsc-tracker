export interface ReplaySessionOptions {
  prepare(signal: AbortSignal): Promise<unknown>;
  record(signal: AbortSignal, onProgress: (progress: number) => void): Promise<File>;
  onReady?(): void;
  onProgress?(progress: number): void;
  onFile?(file: File): void;
  onError?(problem: unknown): void;
  onFinish?(): void;
}

export interface ReplaySession {
  signal: AbortSignal;
  dispose(): void;
  completed: Promise<void>;
}

/** One modal setup owns one renderer and export. Disposed sessions never update its replacement. */
export function startReplaySession(options: ReplaySessionOptions): ReplaySession {
  const controller = new AbortController();
  let disposed = false;
  let settled = false;
  const active = () => !disposed && !settled && !controller.signal.aborted;
  const completed = (async () => {
    try {
      await options.prepare(controller.signal);
      if (!active()) return;
      options.onReady?.();
      // A ready callback can close the modal before recording starts.
      if (!active()) return;
      const file = await options.record(controller.signal, progress => {
        if (active()) options.onProgress?.(progress);
      });
      if (active()) options.onFile?.(file);
    } catch (problem) {
      if (active() && !(problem instanceof DOMException && problem.name === 'AbortError')) options.onError?.(problem);
    } finally {
      const notify = active();
      settled = true;
      if (notify) options.onFinish?.();
    }
  })();
  return {
    signal: controller.signal,
    completed,
    dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
    },
  };
}
