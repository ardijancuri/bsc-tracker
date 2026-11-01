import type { Pool } from 'pg';
import { createXTokenPostCredentials } from './xTokenPostAuth.js';
import { createXTokenPostTransport } from './xTokenPostTransport.js';
import { createXTokenPosts, type XTokenPostMode } from './xTokenPosts.js';
import { ensureXTokenPostSchema } from './xTokenPostSchema.js';

export function xTokenPostMode(value = process.env.X_TOKEN_POSTS_MODE ?? 'disabled'): XTokenPostMode {
  if (value !== 'disabled' && value !== 'dry_run' && value !== 'live') throw new Error('invalid_x_token_post_mode');
  return value;
}
export function createXTokenPostRuntime(db: Pool, options: { mode?: XTokenPostMode; now?: () => number; offline?: boolean } = {}) {
  const mode = options.mode ?? xTokenPostMode();
  const credentials = createXTokenPostCredentials(db);
  // Construction makes no requests. Paused reconciliation may explicitly read
  // X; enable and delivery retain their independent live-mode guards.
  const transport = options.offline || mode === 'dry_run' ? null : createXTokenPostTransport({ getAccessToken: credentials.getAccessToken, refreshAccessToken: credentials.refreshAccessToken });
  const log = (event: Record<string, unknown>) => console.log(JSON.stringify({ ...event, at: new Date().toISOString() }));
  return createXTokenPosts({ db, mode, now: options.now, transport, log,
    content: { apiKey: null, onDiagnostic: diagnostic => log({ event: 'x_token_content', ...diagnostic }) } });
}

/** The normal disabled worker performs no X DDL, credential refresh or HTTP. */
export async function runXTokenPostWorker(db: Pool, signal?: AbortSignal, options: {
  mode?: XTokenPostMode;
  ensure?: typeof ensureXTokenPostSchema;
  runtime?: typeof createXTokenPostRuntime;
} = {}) {
  const mode = options.mode ?? xTokenPostMode();
  if (mode === 'disabled' || signal?.aborted) return;
  await (options.ensure ?? ensureXTokenPostSchema)(db);
  await (options.runtime ?? createXTokenPostRuntime)(db, { mode, offline: mode === 'dry_run' }).run(signal);
}
