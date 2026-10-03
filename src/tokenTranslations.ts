import type { TokenTranslation } from '../shared/tokenTranslation';

type Entry = {
  address: string; source: string; value: TokenTranslation; listeners: Set<() => void>;
  pending: boolean; retryAt: number;
};
type Lookup = (address: string) => Promise<TokenTranslation>;

// One cache for every token identity, including repeated trades and page navigation.
export class TokenTranslationStore {
  private entries = new Map<string, Entry>();
  private queue: Entry[] = [];
  private running = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private lookup: Lookup) {}

  watch(address: string, source: string) {
    address = address.toLowerCase();
    const key = JSON.stringify([address, source]);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { address, source, value: { tokenAddress: address, sourceText: source, englishName: null }, listeners: new Set(), pending: false, retryAt: 0 };
      this.entries.set(key, entry);
    }
    const current = entry;
    return {
      getSnapshot: () => current.value,
      subscribe: (listener: () => void) => {
        current.listeners.add(listener);
        this.schedule(current);
        return () => { current.listeners.delete(listener); this.armRetry(); };
      },
    };
  }

  private schedule(entry: Entry) {
    if (entry.value.englishName || entry.pending || !entry.listeners.size) return;
    if (entry.retryAt > Date.now()) { this.armRetry(); return; }
    entry.pending = true;
    this.queue.push(entry);
    void Promise.resolve().then(() => this.drain());
  }
  private drain() {
    while (this.running < 2 && this.queue.length) {
      const entry = this.queue.shift()!;
      if (!entry.listeners.size) { entry.pending = false; continue; }
      this.running++;
      void this.lookup(entry.address).then(value => {
        // A changed token name must never reuse a translation for old metadata.
        if (value.tokenAddress?.toLowerCase() === entry.address && value.sourceText === entry.source && value.englishName) {
          entry.value = value;
          for (const listener of entry.listeners) listener();
        }
      }).catch(() => { /* Keep the original name while the service is unavailable. */ }).finally(() => {
        entry.pending = false;
        entry.retryAt = Date.now() + 60000;
        this.running--;
        this.drain();
        this.armRetry();
      });
    }
  }
  private armRetry() {
    clearTimeout(this.timer);
    const due = [...this.entries.values()].filter(entry => entry.listeners.size && !entry.pending && !entry.value.englishName && entry.retryAt > 0);
    if (!due.length) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const entry of due) this.schedule(entry);
    }, Math.max(0, Math.min(...due.map(entry => entry.retryAt)) - Date.now()));
  }
}
