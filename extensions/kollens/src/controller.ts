import { defaultExtensionPreferences, extensionLabels, type ExtensionPage, type ExtensionPreferences, type TokenCard } from '../../../shared/extension';
import { matchCards } from './matching';
import { PageAlerts } from './alerts';
import { readCard, verifiedGmgnLayout, type Layout } from './adapter';
import { findGmgnColumns, gmgnRowIndex, sampleGmgnColumn, type GmgnColumn } from './gmgnColumns';
import { normalizeSocialLink } from './matching';

const columnRefreshMs = 5_000;
const columnExpiryMs = 15_000;
type ColumnSnapshot = {column:GmgnColumn; rows:(TokenCard|null)[]; observedAt:number};

export class TrenchesController {
  private cards = new Map<HTMLElement, TokenCard>();
  private candidates=new Set<HTMLElement>();
  private overflowed=false;
  private ids = new WeakMap<HTMLElement, string>();
  private decorations = new Map<HTMLElement, HTMLElement>();
  private dirty = new Set<HTMLElement>();
  private observer: MutationObserver;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private serial = 0;
  private pageId = crypto.randomUUID();
  private session = new PageAlerts();
  private selected: string | null = null;
  private preferences = { ...defaultExtensionPreferences };
  private saved = new Set<string>();
  private enabled = true;
  private durations: number[] = [];
  private lastGroups: ExtensionPage['groups'] = [];
  private ownAttributes=new WeakMap<Element,{style:string|null;className:string|null}>();
  private socialMarks=new Map<HTMLElement,Set<HTMLElement>>();
  private columnSnapshots = new Map<string, ColumnSnapshot>();
  private nextColumnSample = new Map<string, number>();
  private columnTimer: ReturnType<typeof setTimeout> | undefined;
  private columnSampling: AbortController | undefined;
  private quietColumnUpdate = false;
  constructor(private root: HTMLElement, private layout: Layout, private publish: (page: ExtensionPage, sound: boolean) => void,
    private focus: (group: string) => void, private getUrl: () => string = () => location.href,
    initial?:{preferences:ExtensionPreferences;saved:string[]}) {
    if(initial){this.preferences=initial.preferences;this.saved=new Set(initial.saved);}
    this.observer = new MutationObserver(records => {
      let changed=false;
      for (const record of records) {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        if (target?.closest('[data-kollens-decoration]')) continue;
        if(record.type==='attributes'&&target){const own=this.ownAttributes.get(target);if(record.attributeName==='style'&&own?.style===target.getAttribute('style')||record.attributeName==='class'&&own?.className===target.getAttribute('class'))continue;}
        const card = target?.closest<HTMLElement>(this.layout.card)??(target instanceof HTMLElement&&this.candidates.has(target)?target:null);
        if (card){this.dirty.add(card);this.candidates.add(card);changed=true;}
        if(record.type==='attributes'&&target&&!card)for(const child of target.querySelectorAll<HTMLElement>(this.layout.card)){this.dirty.add(child);this.candidates.add(child);changed=true;}
        for (const node of record.addedNodes) if (node instanceof HTMLElement && !node.hasAttribute('data-kollens-decoration')) {
          if (node.matches(this.layout.card)){this.dirty.add(node);this.candidates.add(node);changed=true;}
          for (const child of node.querySelectorAll<HTMLElement>(this.layout.card)){this.dirty.add(child);this.candidates.add(child);changed=true;}
        }
        for(const node of record.removedNodes)if(node instanceof Element&&(node.matches(this.layout.card)||node.querySelector(this.layout.card)))changed=true;
      }
      if(changed)this.schedule();
    });
    this.observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['href','src','srcset','data-src', layout.addressAttribute, ...(layout.chainAttribute?[layout.chainAttribute]:[]),
        'data-recycler-key','data-trenches-token-key','data-trenches-token-page','data-testid','data-chain','data-icon','hidden','aria-hidden','class','style'] });
    for (const element of root.querySelectorAll<HTMLElement>(layout.card)){this.dirty.add(element);this.candidates.add(element);}
    this.flush();
    document.addEventListener('visibilitychange', this.visibility);
    root.addEventListener('load',this.imageChanged,true);
    root.addEventListener('error',this.imageChanged,true);
    if (layout === verifiedGmgnLayout) this.scheduleColumns(0);
  }
  private imageChanged=(event:Event)=>{const image=event.target;if(!(image instanceof HTMLImageElement)||!this.layout.tokenImage||!image.matches(this.layout.tokenImage))return;
    const card=image.closest<HTMLElement>(this.layout.card);if(card){this.dirty.add(card);this.schedule();}};
  private visibility = () => {
    if (document.hidden) this.columnSampling?.abort();
    this.session.sample(this.lastGroups, { active: false, preferences: this.preferences, saved: this.saved, now: Date.now() });
    this.schedule();
  };
  private schedule() { if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 40); }
  private scheduleColumns(delay = 750) {
    this.columnTimer = setTimeout(() => {
      this.columnTimer = undefined;
      void this.refreshColumn();
    }, delay);
  }
  private async refreshColumn() {
    let nextDelay = 750;
    try {
      if (document.hidden || this.overflowed) return;
      const now = Date.now();
      if ([...this.columnSnapshots.values()].some(snapshot => now - snapshot.observedAt >= columnExpiryMs)) this.schedule();
      const column = findGmgnColumns(this.root).find(candidate =>
        candidate.scroller.scrollTop === 0 && (this.nextColumnSample.get(candidate.id) ?? 0) <= now);
      if (!column) return;
      this.nextColumnSample.set(column.id, now + columnRefreshMs);
      // Try the remaining columns after the mounted-card update has settled.
      nextDelay = 50;
      const abort = new AbortController();
      this.columnSampling = abort;
      const url = this.getUrl();
      const rows = await sampleGmgnColumn(column, elements => elements.map((element, index) =>
        readCard(element, `${this.pageId}:${column.id}:${index}`, this.layout, url)), abort.signal);
      if (!abort.signal.aborted && this.getUrl() === url && rows) {
        this.columnSnapshots.set(column.id, {column, rows, observedAt:Date.now()});
        this.quietColumnUpdate = true;
      }
    } catch {
      // The normal mounted-card observer continues if a column cannot be sampled.
    } finally {
      if (this.columnSampling) {
        this.columnSampling = undefined;
        if (this.enabled) this.schedule();
      }
      if (this.enabled) this.scheduleColumns(nextDelay);
    }
  }
  private includeOffscreenCards(cards: TokenCard[], now: number) {
    if (!this.columnSnapshots.size) return;
    const columns = new Map<string, GmgnColumn>(findGmgnColumns(this.root).map(column => [column.id, column]));
    for (const [id, snapshot] of this.columnSnapshots) {
      const column = columns.get(id);
      const captured = snapshot.column;
      const mountedRows = new Set<number>();
      let valid = column && !column.element.closest('[hidden],[aria-hidden="true"]') && column.scroller.clientHeight > 0 &&
        column.element === captured.element && column.scroller === captured.scroller &&
        column.spacer === captured.spacer && column.rowHeight === captured.rowHeight && column.rowCount === captured.rowCount &&
        now - snapshot.observedAt < columnExpiryMs;
      if (valid && column) {
        for (const element of this.candidates) {
          if (!column.spacer.contains(element)) continue;
          const index = gmgnRowIndex(element, column);
          const address = element.getAttribute(this.layout.addressAttribute)?.toLowerCase();
          if (index === null || (snapshot.rows[index] && snapshot.rows[index]?.address !== address)) {
            valid = false;
            break;
          }
          mountedRows.add(index);
          const card = this.cards.get(element);
          snapshot.rows[index] = card ? {...card, cardId:`${this.pageId}:${id}:${index}`} : null;
        }
      }
      if (!valid) {
        this.columnSnapshots.delete(id);
        this.nextColumnSample.delete(id);
        this.quietColumnUpdate = true;
        continue;
      }
      for (const [index, card] of snapshot.rows.entries()) {
        if (!card || mountedRows.has(index)) continue;
        if (cards.length >= (this.layout.maxCards ?? Infinity)) return;
        cards.push(card);
      }
    }
  }
  settings(preferences: ExtensionPreferences, saved: string[]) {
    if(JSON.stringify(this.preferences)===JSON.stringify(preferences)&&JSON.stringify([...this.saved])===JSON.stringify(saved))return;
    this.preferences = preferences; this.saved = new Set(saved); this.session.sample(this.lastGroups, {active:false,preferences,saved:this.saved,now:Date.now()}); this.schedule();
  }
  select(id: string | null) { this.selected = id; this.render(); }
  private decorate(element: HTMLElement, groups: ExtensionPage['groups']) {
    const selected = groups.find(group => group.id === this.selected) ?? groups[0];
    let host = this.decorations.get(element);
    if (!this.preferences.highlights || !selected) {
      this.undecorate(element); return;
    }
    if (!element.classList.contains('kollens-match')) element.classList.add('kollens-match');
    if (element.style.getPropertyValue('--kollens-match-color') !== selected.color) {
      element.style.setProperty('--kollens-match-color', selected.color);
    }
    this.ownAttributes.set(element,{style:element.getAttribute('style'),className:element.getAttribute('class')});
    const previous=this.socialMarks.get(element)??new Set<HTMLElement>(),next=new Set<HTMLElement>();
    for(const anchor of element.querySelectorAll<HTMLElement>(this.layout.socials)){
      const link=normalizeSocialLink(anchor.getAttribute('href')??'');
      const group=link&&groups.find(group=>group.type===link.type&&group.key===link.key);
      if(!group)continue;
      anchor.setAttribute('data-kollens-social-match','');
      if(anchor.style.getPropertyValue('--kollens-social-color')!==group.color)anchor.style.setProperty('--kollens-social-color',group.color);
      this.ownAttributes.set(anchor,{style:anchor.getAttribute('style'),className:anchor.getAttribute('class')});next.add(anchor);
    }
    for(const anchor of previous)if(!next.has(anchor))this.clearSocial(anchor);
    this.socialMarks.set(element,next);
    if(!this.layout.badgeSlot)return;
    if (!host) {
      const slot = element.querySelector<HTMLElement>(this.layout.badgeSlot);
      // A safe dedicated anchor is required; never cover an unverified trade control.
      if (!slot) return;
      host = document.createElement('span'); host.setAttribute('data-kollens-decoration','');
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = 'button{font:600 10px/1.3 system-ui;color:var(--c);background:#12191a;border:1px solid color-mix(in srgb,var(--c) 35%,transparent);border-radius:5px;padding:3px 6px;cursor:pointer;white-space:nowrap}button:focus-visible{outline:2px solid #fff;outline-offset:2px}';
      shadow.append(style); slot.append(host); this.decorations.set(element, host);
    }
    const shadow = host.shadowRoot!;
    shadow.querySelector('button')?.remove();
    const badge = document.createElement('button'); badge.type = 'button'; badge.style.setProperty('--c', selected.color);
    badge.textContent = `${extensionLabels[selected.type]} · ${selected.addresses.length}${groups.length > 1 ? ` +${groups.length-1}` : ''}`;
    badge.title = groups.map(g => `${extensionLabels[g.type]} · ${g.addresses.length} tokens`).join('\n');
    badge.onclick = event => { event.preventDefault(); event.stopPropagation(); this.selected = selected.id; this.focus(selected.id); this.render(); };
    shadow.append(badge);
  }
  private clearSocial(anchor:HTMLElement){anchor.removeAttribute('data-kollens-social-match');anchor.style.removeProperty('--kollens-social-color');this.ownAttributes.set(anchor,{style:anchor.getAttribute('style'),className:anchor.getAttribute('class')});}
  private undecorate(element: HTMLElement) {
    if (element.classList.contains('kollens-match') || element.style.getPropertyValue('--kollens-match-color')) {
      element.classList.remove('kollens-match'); element.style.removeProperty('--kollens-match-color');
      this.ownAttributes.set(element,{style:element.getAttribute('style'),className:element.getAttribute('class')});
    }
    this.decorations.get(element)?.remove(); this.decorations.delete(element);
    for(const anchor of this.socialMarks.get(element)??[])this.clearSocial(anchor);
    this.socialMarks.delete(element);
  }
  private render() {
    const groupsByAddress = new Map<string, ExtensionPage['groups']>();
    for (const group of this.lastGroups) for (const address of group.addresses) {
      const matches = groupsByAddress.get(address);
      if (matches) matches.push(group);
      else groupsByAddress.set(address,[group]);
    }
    for (const [element, card] of this.cards) this.decorate(element, groupsByAddress.get(card.address) ?? []);
  }
  flush() {
    if (!this.enabled || this.columnSampling) return;
    const start = performance.now();
    for(const element of this.candidates)if(!element.isConnected||!this.root.contains(element)||!element.matches(this.layout.card))this.candidates.delete(element);
    if(this.layout.maxCards&&this.candidates.size>this.layout.maxCards){
      for(const element of this.cards.keys())this.undecorate(element);this.cards.clear();this.dirty.clear();this.lastGroups=[];this.session.reset();
      this.columnSnapshots.clear();
      this.overflowed=true;
      this.publish({pageId:this.pageId,status:'unsupported',url:this.getUrl(),cards:[],groups:[],alerts:[],active:!document.hidden,updatedAt:Date.now(),durations:[]},false);return;
    }
    if(this.overflowed){for(const element of this.candidates)this.dirty.add(element);this.overflowed=false;}
    for (const [element] of this.cards) if (!element.isConnected || !this.root.contains(element)) { this.undecorate(element); this.cards.delete(element); }
    for (const element of this.dirty) {
      if (!element.isConnected || !this.root.contains(element)) continue;
      let id = this.ids.get(element); if (!id) { id = `${this.pageId}:${++this.serial}`; this.ids.set(element, id); }
      const card = readCard(element, id, this.layout, this.getUrl());
      if (card) this.cards.set(element, card); else { this.undecorate(element); this.cards.delete(element); }
    }
    this.dirty.clear();
    const cards = [...this.cards.values()];
    const now = Date.now();
    this.includeOffscreenCards(cards, now);
    this.lastGroups = matchCards(cards, this.preferences.matchTypes);
    this.render();
    const active = document.visibilityState === 'visible';
    const sample = this.session.sample(this.lastGroups, { active: active && !this.quietColumnUpdate, preferences: this.preferences, saved: this.saved, now });
    this.quietColumnUpdate = false;
    this.durations.push(performance.now() - start); this.durations.splice(0, Math.max(0, this.durations.length - 100));
    this.publish({ pageId: this.pageId, status: 'ready', url: this.getUrl(), cards, groups: this.lastGroups,
      alerts: [...this.session.activity], active, updatedAt: Date.now(), durations: [...this.durations] }, sample.sound);
  }
  destroy() {
    this.enabled = false; this.observer.disconnect(); if (this.timer) clearTimeout(this.timer);
    clearTimeout(this.columnTimer);
    this.columnSampling?.abort();
    this.columnSnapshots.clear();
    document.removeEventListener('visibilitychange', this.visibility);
    this.root.removeEventListener('load',this.imageChanged,true);this.root.removeEventListener('error',this.imageChanged,true);
    for (const element of this.cards.keys()) this.undecorate(element);
    this.cards.clear();this.candidates.clear(); this.dirty.clear(); this.session.reset();
  }
}
