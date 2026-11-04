import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import {beforeAll, expect, it, vi} from 'vitest';

let content: string;
beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./content.ts', import.meta.url))],
    bundle: true, platform: 'browser', format: 'iife', write: false,
    define: {__API_ORIGIN__: '""', __GMGN_AUTHORIZED__: 'false', __LOCAL_GMGN_LIVE__: 'true'},
  });
  content = result.outputFiles[0].text;
});

it.each(['synchronous throw', 'promise rejection', 'missing runtime'])(
  'retires the page script on a stale extension context: %s', async (failure) => {
    let stale = false;
    const invalidated = () => new Error('Extension context invalidated.');
    const message = vi.fn(() => {
      if (!stale) return Promise.resolve();
      if (failure === 'promise rejection') return Promise.reject(invalidated());
      throw invalidated();
    });
    const runtime = {id: 'kollens', sendMessage: message, onMessage: {
      addListener: vi.fn(), removeListener: vi.fn(() => { throw invalidated(); }),
    }};
    const style = {setAttribute: vi.fn(), remove: vi.fn()};
    const disconnect = vi.fn(), observe = vi.fn();
    const listeners = new Map<string, () => void>();
    const clearInterval = vi.fn();
    const location = {hostname: '127.0.0.1', pathname: '/fixture', href: 'http://127.0.0.1:3360/fixture'};
    const globals = {
      chrome: {get runtime() { return stale && failure === 'missing runtime' ? undefined : runtime; }},
      document: {createElement: () => style, head: {append: vi.fn()}, body: {}, querySelector: () => null},
      window: {
        addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
        removeEventListener: (type: string) => listeners.delete(type),
      },
      MutationObserver: class {observe = observe; disconnect = disconnect;},
      crypto: {randomUUID: () => 'fixture-page'}, location, queueMicrotask,
      setInterval: () => 123, clearInterval,
    };
    runInNewContext(content, globals);
    expect(message).toHaveBeenCalledTimes(1);
    // A navigation callback already registered in the open tab publishes again.
    stale = true;
    location.href += '?sort=volume';
    expect(() => listeners.get('popstate')!()).not.toThrow();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(clearInterval).toHaveBeenCalledWith(123);
    expect(style.remove).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
    expect(globals).not.toHaveProperty('__kollensContent');
  },
);
