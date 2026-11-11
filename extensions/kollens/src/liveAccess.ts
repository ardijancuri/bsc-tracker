import { isBscTrenches } from './adapter';

export const gmgnOrigins = ['https://gmgn.ai/*', 'https://www.gmgn.ai/*'];
const registrationId = 'kollens-gmgn-local-live';
type LiveTab = Pick<chrome.tabs.Tab, 'id' | 'url'>;

/** Browser opt-in is independent of accounts and GMGN's authorization response. */
export class LiveGmgnAccess {
  enabled = false;
  private operations = Promise.resolve();
  private recovering = new Map<number, { url: string; ticket: symbol; work: Promise<void> }>();

  constructor(private api: typeof chrome, private available: boolean) {}

  async restore() {
    const stored = await this.api.storage.local.get('gmgnLiveEnabled');
    this.enabled = this.available && stored.gmgnLiveEnabled === true &&
      await this.api.permissions.contains({ origins: gmgnOrigins });
    try {
      await this.registration();
    } catch (error) {
      this.enabled = false;
      throw error;
    }
  }

  async recoverOpenTabs() {
    if (!this.enabled) return;
    const tabs = await this.api.tabs.query({ url: gmgnOrigins });
    await Promise.all(tabs.map(tab => this.recoverTab(tab)));
  }

  recoverTab({ id, url }: LiveTab): Promise<void> {
    if (!this.enabled || id == null || !url || !isBscTrenches(url)) return Promise.resolve();
    const pending = this.recovering.get(id);
    if (pending?.url === url) return pending.work;

    const ticket = Symbol();
    const work = this.recoverPage(id, url, ticket).catch(() => {}).finally(() => {
      if (this.recovering.get(id)?.ticket === ticket) this.recovering.delete(id);
    });
    this.recovering.set(id, { url, ticket, work });
    return work;
  }

  private async recoverPage(tabId: number, url: string, ticket: symbol) {
    const active = await this.api.tabs.sendMessage(tabId, { kind: 'request-page' }).catch(() => null);
    if (active?.ok === true || !this.enabled || this.recovering.get(tabId)?.ticket !== ticket) return;
    const current = await this.api.tabs.get(tabId);
    if (!this.enabled || this.recovering.get(tabId)?.ticket !== ticket || current.url !== url) return;
    await this.api.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED', files: ['content.js'] });
  }

  private async registration() {
    const [existing] = await this.api.scripting.getRegisteredContentScripts({ ids: [registrationId] });
    if (!this.enabled) {
      if (existing) await this.api.scripting.unregisterContentScripts({ ids: [registrationId] });
      return;
    }
    const script: chrome.scripting.RegisteredContentScript = {
      id: registrationId, matches: gmgnOrigins, js: ['content.js'], runAt: 'document_end',
      world: 'ISOLATED', persistAcrossSessions: true,
    };
    if (!existing) await this.api.scripting.registerContentScripts([script]);
    else if (existing.runAt !== script.runAt) await this.api.scripting.updateContentScripts([script]);
  }

  setEnabled(wanted: boolean) {
    const next = this.operations.then(async () => {
      if (wanted && (!this.available || !await this.api.permissions.contains({ origins: gmgnOrigins }))) {
        throw Error('Allow GMGN site access first');
      }
      this.enabled = wanted && this.available;
      if (!this.enabled) this.recovering.clear();
      try {
        await this.registration();
        await this.api.storage.local.set({ gmgnLiveEnabled: this.enabled });
      } catch (error) {
        this.enabled = false;
        this.recovering.clear();
        await this.api.storage.local.set({ gmgnLiveEnabled: false });
        await this.registration().catch(() => {});
        throw error;
      }

      if (this.enabled) {
        await this.recoverOpenTabs();
      } else {
        // IDs suffice to stop our own isolated script without the tabs permission.
        const tabs = await this.api.tabs.query({});
        await Promise.all(tabs.map(async tab => {
          if (tab.id != null) await this.api.tabs.sendMessage(tab.id, { kind: 'stop-gmgn' }).catch(() => {});
        }));
      }
    });
    this.operations = next.catch(() => {});
    return next;
  }
}
