import type { SocialMatchGroup, MatchAlert, ExtensionPreferences } from '../../../shared/extension';

/** Bounded page-session state; removed cards never remain in the matching pool. */
export class PageAlerts {
  private previous: Map<string, Set<string>> | null = null;
  private recent = new Map<string, number>();
  private lastSound = -Infinity;
  readonly activity: MatchAlert[] = [];
  reset() { this.previous = null; this.recent.clear(); this.lastSound = -Infinity; this.activity.length = 0; }
  sample(groups: SocialMatchGroup[], options: { active: boolean; preferences: ExtensionPreferences; saved: Set<string>; now: number }) {
    const current = new Map(groups.map(group => [group.id, new Set(group.addresses)]));
    if (!options.active || !this.previous) { this.previous = current; return { alerts: [], sound: false }; }
    const alerts: MatchAlert[] = [];
    for (const group of groups) {
      const old = this.previous.get(group.id), added = group.addresses.filter(address => !old?.has(address));
      const type = old ? 'new_member' : 'new_group';
      if (!added.length || (type === 'new_group' ? !options.preferences.newGroups : !options.preferences.newMembers)) continue;
      if (options.preferences.watchedOnly && !group.addresses.some(address => options.saved.has(address))) continue;
      const signature = `${group.id}:${added.join(',')}`;
      if (options.now - (this.recent.get(signature) ?? -Infinity) < 30_000) continue;
      this.recent.set(signature, options.now);
      alerts.push({ id: `${signature}:${options.now}`, groupId: group.id, type, matchType: group.type,
        addresses: [...group.addresses], addedAddresses: added, occurredAt: options.now });
    }
    this.previous = current;
    for (const [key, at] of this.recent) if (options.now - at >= 30_000) this.recent.delete(key);
    while (this.recent.size > 500) this.recent.delete(this.recent.keys().next().value!);
    this.activity.unshift(...alerts); this.activity.splice(50);
    const sound = alerts.length > 0 && options.preferences.sound && options.now - this.lastSound >= 30_000;
    if (sound) this.lastSound = options.now;
    return { alerts, sound };
  }
}
