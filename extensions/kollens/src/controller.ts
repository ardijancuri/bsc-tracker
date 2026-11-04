import { defaultExtensionPreferences, extensionLabels, type ExtensionPage, type ExtensionPreferences, type TokenCard } from '../../../shared/extension';
import { matchCards } from './matching';
import { PageAlerts } from './alerts';
import { readCard, type Layout } from './adapter';
import { normalizeSocialLink } from './matching';

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
        if(record.type==='attributes'&&target&&!card)for(const child of target.querySelectorAll<HTMLElement>(this.layout.card)){this.dirty.add(child);changed=true;}
        for (const node of record.addedNodes) if (node instanceof HTMLElement && !node.hasAttribute('data-kollens-decoration')) {
          if (node.matches(this.layout.card)){this.dirty.add(node);this.candidates.add(node);changed=true;}
          for (const child of node.querySelectorAll<HTMLElement>(this.layout.card)){this.dirty.add(child);this.candidates.add(child);changed=true;}
        }
        for(const node of record.removedNodes)if(node instanceof Element&&(node.matches(this.layout.card)||node.querySelector(this.layout.card)))changed=true;
      }
      if(changed)this.schedule();
    });
    this.observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['href','src','srcset','data-src', layout.addressAttribute, ...(layout.chainAttribute?[layout.chainAttribute]:[]), 'data-testid','data-chain','data-icon','hidden','aria-hidden','class','style'] });
    for (const element of root.querySelectorAll<HTMLElement>(layout.card)){this.dirty.add(element);this.candidates.add(element);}
    this.flush();
    document.addEventListener('visibilitychange', this.visibility);
    root.addEventListener('load',this.imageChanged,true);
    root.addEventListener('error',this.imageChanged,true);
  }
  private imageChanged=(event:Event)=>{const image=event.target;if(!(image instanceof HTMLImageElement)||!this.layout.tokenImage||!image.matches(this.layout.tokenImage))return;
    const card=image.closest<HTMLElement>(this.layout.card);if(card){this.dirty.add(card);this.schedule();}};
  private visibility = () => { this.session.sample(this.lastGroups, { active: false, preferences: this.preferences, saved: this.saved, now: Date.now() }); this.schedule(); };
  private schedule() { if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 40); }
  settings(preferences: ExtensionPreferences, saved: string[]) {
    if(JSON.stringify(this.preferences)===JSON.stringify(preferences)&&JSON.stringify([...this.saved])===JSON.stringify(saved))return;
    this.preferences = preferences; this.saved = new Set(saved); this.session.sample(this.lastGroups, {active:false,preferences,saved:this.saved,now:Date.now()}); this.schedule();
  }
  select(id: string | null) { this.selected = id; this.render(); }
  private decorate(element: HTMLElement, card: TokenCard) {
    const groups = this.lastGroups.filter(group => group.cardIds.includes(card.cardId));
    const selected = groups.find(group => group.id === this.selected) ?? groups[0];
    let host = this.decorations.get(element);
    if (!this.preferences.highlights || !selected) {
      this.undecorate(element); return;
    }
    element.classList.add('kollens-match');
    element.style.setProperty('--kollens-match-color', selected.color);
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
    element.classList.remove('kollens-match'); element.style.removeProperty('--kollens-match-color');
    this.ownAttributes.set(element,{style:element.getAttribute('style'),className:element.getAttribute('class')});
    this.decorations.get(element)?.remove(); this.decorations.delete(element);
    for(const anchor of this.socialMarks.get(element)??[])this.clearSocial(anchor);
    this.socialMarks.delete(element);
  }
  private render() { for (const [element, card] of this.cards) this.decorate(element, card); }
  flush() {
    if (!this.enabled) return;
    const start = performance.now();
    for(const element of this.candidates)if(!element.isConnected||!this.root.contains(element)||!element.matches(this.layout.card))this.candidates.delete(element);
    if(this.layout.maxCards&&this.candidates.size>this.layout.maxCards){
      for(const element of this.cards.keys())this.undecorate(element);this.cards.clear();this.dirty.clear();this.lastGroups=[];this.session.reset();
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
    const cards = [...this.cards.values()]; this.lastGroups = matchCards(cards, this.preferences.matchTypes);
    this.render();
    const active = document.visibilityState === 'visible';
    const sample = this.session.sample(this.lastGroups, { active, preferences: this.preferences, saved: this.saved, now: Date.now() });
    this.durations.push(performance.now() - start); this.durations.splice(0, Math.max(0, this.durations.length - 100));
    this.publish({ pageId: this.pageId, status: 'ready', url: this.getUrl(), cards, groups: this.lastGroups,
      alerts: [...this.session.activity], active, updatedAt: Date.now(), durations: [...this.durations] }, sample.sound);
  }
  destroy() {
    this.enabled = false; this.observer.disconnect(); if (this.timer) clearTimeout(this.timer);
    document.removeEventListener('visibilitychange', this.visibility);
    this.root.removeEventListener('load',this.imageChanged,true);this.root.removeEventListener('error',this.imageChanged,true);
    for (const element of this.cards.keys()) this.undecorate(element);
    this.cards.clear();this.candidates.clear(); this.dirty.clear(); this.session.reset();
  }
}
