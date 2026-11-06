import { describe, expect, it, vi } from 'vitest';
import { LiveGmgnAccess, gmgnOrigins } from './liveAccess';

const trenches = { id: 1, url: 'https://gmgn.ai/?chain=bsc' };
const sol = { id: 2, url: 'https://gmgn.ai/?chain=sol' };
const other = { id: 3, url: 'https://elsewhere.example/' };
const registrationId = 'kollens-gmgn-local-live';

function setup({ allowed = true, stored = false, local = true, registeredAt }: {
  allowed?: boolean; stored?: boolean; local?: boolean; registeredAt?: chrome.scripting.RegisteredContentScript['runAt'];
} = {}) {
  const memory = new Map<string, unknown>([['gmgnLiveEnabled', stored]]);
  let registered: chrome.scripting.RegisteredContentScript[] = registeredAt
    ? [{ id: registrationId, runAt: registeredAt, js: ['content.js'] }] : [];
  const api = {
    storage: { local: {
      get: vi.fn(async (key: string) => ({ [key]: memory.get(key) })),
      set: vi.fn(async (value: Record<string, unknown>) => {
        for (const [key, item] of Object.entries(value)) memory.set(key, item);
      }),
    } },
    permissions: { contains: vi.fn(async () => allowed) },
    scripting: {
      getRegisteredContentScripts: vi.fn(async () => registered),
      registerContentScripts: vi.fn(async (scripts: chrome.scripting.RegisteredContentScript[]) => { registered = scripts; }),
      unregisterContentScripts: vi.fn(async () => { registered = []; }),
      updateContentScripts: vi.fn(async (scripts: chrome.scripting.RegisteredContentScript[]) => { registered = scripts; }),
      executeScript: vi.fn(async () => []),
    },
    tabs: {
      query: vi.fn(async () => [trenches, sol, other]),
      get: vi.fn(async () => trenches),
      sendMessage: vi.fn(async (_id: number, _message: unknown): Promise<{ ok: boolean } | null> => null),
    },
  };
  return { api, memory, access: new LiveGmgnAccess(api as unknown as typeof chrome, local) };
}

describe('local GMGN live access', () => {
  it('starts disabled without a saved opt-in', async () => {
    const { access, api } = setup();
    await access.restore();
    expect(access.enabled).toBe(false);
    expect(api.scripting.registerContentScripts).not.toHaveBeenCalled();
  });

  it.each([{ allowed: false }, { local: false }])('rejects activation without the local gate and browser grant', async flags => {
    const { access, api } = setup(flags);
    await expect(access.setEnabled(true)).rejects.toThrow('Allow GMGN');
    expect(api.scripting.registerContentScripts).not.toHaveBeenCalled();
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('registers early on only GMGN and injects existing BSC trenches only', async () => {
    const { access, api, memory } = setup();
    await access.setEnabled(true);
    expect(access.enabled).toBe(true);
    expect(memory.get('gmgnLiveEnabled')).toBe(true);
    expect(api.scripting.registerContentScripts).toHaveBeenCalledWith([
      expect.objectContaining({ matches: gmgnOrigins, runAt: 'document_end', world: 'ISOLATED', persistAcrossSessions: true }),
    ]);
    expect(api.scripting.executeScript).toHaveBeenCalledExactlyOnceWith({
      target: { tabId: 1, frameIds: [0] }, world: 'ISOLATED', files: ['content.js'],
    });
  });

  it('restores the gate before tab recovery and keeps a responsive script', async () => {
    const { access, api } = setup({ stored: true });
    api.tabs.sendMessage.mockResolvedValueOnce({ ok: true });
    await access.restore();
    expect(access.enabled).toBe(true);
    expect(api.tabs.query).not.toHaveBeenCalled();
    await access.recoverOpenTabs();
    expect(api.tabs.sendMessage).toHaveBeenCalledExactlyOnceWith(1, { kind: 'request-page' });
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('updates an older registration without adding a duplicate', async () => {
    const { access, api } = setup({ stored: true, registeredAt: 'document_idle' });
    await access.restore();
    expect(api.scripting.updateContentScripts).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ id: registrationId, matches: gmgnOrigins, js: ['content.js'], runAt: 'document_end' }),
    ]);
    expect(api.scripting.registerContentScripts).not.toHaveBeenCalled();
  });

  it('coalesces simultaneous attempts to recover an invalidated tab', async () => {
    const { access, api } = setup({ stored: true });
    api.tabs.sendMessage.mockRejectedValueOnce(new Error('No receiving end'));
    await access.restore();
    await Promise.all([access.recoverTab(trenches), access.recoverTab(trenches), access.recoverOpenTabs()]);
    expect(api.tabs.sendMessage).toHaveBeenCalledOnce();
    expect(api.scripting.executeScript).toHaveBeenCalledExactlyOnceWith({
      target: { tabId: 1, frameIds: [0] }, world: 'ISOLATED', files: ['content.js'],
    });
  });

  it('discards a delayed injection after the tab leaves BSC trenches', async () => {
    const { access, api } = setup({ stored: true });
    api.tabs.get.mockResolvedValueOnce({ ...sol, id: 1 });
    await access.restore();
    await access.recoverTab(trenches);
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('does not restore when site access was revoked', async () => {
    const { access, api } = setup({ stored: true, allowed: false, registeredAt: 'document_end' });
    await access.restore();
    expect(access.enabled).toBe(false);
    expect(api.scripting.unregisterContentScripts).toHaveBeenCalledOnce();
  });

  it('serializes disable behind enable and removes the registration', async () => {
    const { access, api, memory } = setup();
    await Promise.all([access.setEnabled(true), access.setEnabled(false)]);
    expect(access.enabled).toBe(false);
    expect(memory.get('gmgnLiveEnabled')).toBe(false);
    expect(api.scripting.unregisterContentScripts).toHaveBeenCalledOnce();
    expect(api.tabs.sendMessage).toHaveBeenCalledWith(1, { kind: 'stop-gmgn' });
  });

  it('fails closed after registration errors', async () => {
    const { access, api, memory } = setup();
    api.scripting.registerContentScripts.mockRejectedValueOnce(new Error('test registration failure'));
    await expect(access.setEnabled(true)).rejects.toThrow();
    expect(access.enabled).toBe(false);
    expect(memory.get('gmgnLiveEnabled')).toBe(false);
  });
});
