import { afterEach, describe, expect, it, vi } from 'vitest';
import { isModuleLoadError, moduleEntry, recoverChangedBuild, takeResumedTradeModal } from './moduleLoadRecovery';

const oldEntry = '/assets/index-oldbuild.js';
const newEntry = '/assets/index-newbuild.js';
const importError = new TypeError('Failed to fetch dynamically imported module: https://kollens.com/assets/OldModal-12345678.js');
const html = (entry: string) => `<html><head><script type="module" crossorigin src="${entry}"></script></head></html>`;
function environment(entry: string | null = oldEntry) {
  let saved: string | null = null;
  return {
    entry,
    loadHtml: vi.fn().mockResolvedValue(html(newEntry)),
    readGuard: vi.fn(() => saved),
    writeGuard: vi.fn((value: string) => { saved = value; }),
    beforeReload: vi.fn(() => true),
    reload: vi.fn(),
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('outdated popup module recovery', () => {
  it('finds only the module entry regardless of HTML attribute order', () => {
    expect(moduleEntry(html(oldEntry))).toBe(oldEntry);
    expect(moduleEntry(`<script src='/analytics.js'></script><script src='${newEntry}' type='module'></script>`)).toBe(newEntry);
    expect(moduleEntry('<html>unavailable</html>')).toBeNull();
  });
  it.each([
    'Failed to fetch dynamically imported module: /assets/modal.js',
    'Importing a module script failed.',
    'error loading dynamically imported module',
    'Unable to preload CSS for /assets/modal.css',
  ])('recognizes browser module-fetch failures: %s', message => {
    expect(isModuleLoadError(new TypeError(message))).toBe(true);
  });
  it('preserves popup intent and reloads exactly once when the build has changed', async () => {
    const env = environment();
    expect(await recoverChangedBuild(importError, env)).toBe(true);
    expect(env.beforeReload).toHaveBeenCalledOnce();
    expect(env.writeGuard).toHaveBeenCalledWith(oldEntry);
    expect(env.reload).toHaveBeenCalledOnce();
    expect(await recoverChangedBuild(importError, env)).toBe(false);
    expect(env.loadHtml).toHaveBeenCalledOnce();
    expect(env.reload).toHaveBeenCalledOnce();
  });
  it('does not reload the current build on a transient QUIC or network failure', async () => {
    const env = environment();
    env.loadHtml.mockResolvedValue(html(oldEntry));
    expect(await recoverChangedBuild(importError, env)).toBe(false);
    expect(env.reload).not.toHaveBeenCalled();
    expect(env.beforeReload).not.toHaveBeenCalled();
  });
  it('does not reload if the user closed the popup while checking the latest build', async () => {
    const env = environment();
    env.beforeReload.mockReturnValue(false);
    expect(await recoverChangedBuild(importError, env)).toBe(false);
    expect(env.writeGuard).not.toHaveBeenCalled();
    expect(env.reload).not.toHaveBeenCalled();
  });
  it('falls back to a visible reload control when storage is restricted or the HTML request fails', async () => {
    const restricted = environment();
    restricted.writeGuard.mockImplementation(() => { throw new Error('Storage blocked'); });
    expect(await recoverChangedBuild(importError, restricted)).toBe(false);
    expect(restricted.reload).not.toHaveBeenCalled();
    const offline = environment();
    offline.loadHtml.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await recoverChangedBuild(importError, offline)).toBe(false);
    expect(offline.reload).not.toHaveBeenCalled();
  });
  it.each([null, '/src/main.tsx'])('leaves development and missing entries alone: %s', async entry => {
    const env = environment(entry);
    expect(await recoverChangedBuild(importError, env)).toBe(false);
    expect(env.loadHtml).not.toHaveBeenCalled();
  });
  it('does not hide application exceptions or reload invalid HTML responses', async () => {
    const env = environment();
    expect(await recoverChangedBuild(new Error('Chart renderer failed'), env)).toBe(false);
    expect(env.loadHtml).not.toHaveBeenCalled();
    env.loadHtml.mockResolvedValue('<html>Gateway unavailable</html>');
    expect(await recoverChangedBuild(importError, env)).toBe(false);
    expect(env.reload).not.toHaveBeenCalled();
  });
});

describe('popup restoration after a release refresh', () => {
  const kol = '0x' + 'a'.repeat(40), token = '0x' + 'b'.repeat(40);
  function storage(value: unknown) {
    const sessionStorage = { getItem: vi.fn(() => typeof value === 'string' ? value : JSON.stringify(value)), removeItem: vi.fn() };
    vi.stubGlobal('window', { sessionStorage });
    return sessionStorage;
  }
  it('consumes a recent valid intent for the same KOL', () => {
    const store = storage({ kol, token, at: Date.now() });
    expect(takeResumedTradeModal(kol.toUpperCase())).toBe(token);
    expect(store.removeItem).toHaveBeenCalledWith('kollens-trade-modal-resume');
  });
  it.each([
    ['expired', (): unknown => ({ kol, token, at: Date.now() - 60_001 })],
    ['future', (): unknown => ({ kol, token, at: Date.now() + 1_000 })],
    ['another KOL', (): unknown => ({ kol: token, token, at: Date.now() })],
    ['invalid address', (): unknown => ({ kol, token: '/assets/missing.js', at: Date.now() })],
    ['invalid JSON', (): unknown => '{broken'],
  ] as const)('ignores %s resume data', (_name, value) => {
    storage(value());
    expect(takeResumedTradeModal(kol)).toBeNull();
  });
});
