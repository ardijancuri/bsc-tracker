import { defaultTrendingWindow, trendingWindows, type MarketMomentumToken, type TrendingToken, type TrendingWindow } from '../../../shared/trendingTokens';
import { extensionAddress, type SocialLink } from '../../../shared/extension';
import { cardMetricColor } from './cardMetrics';
import { normalizeSocialLink } from './matching';
import { browserApi as chrome } from './platform';
import { isDisplayableXTrendingToken, isXPage, selectXMarketMomentum, type XTrendingResponse } from './xTrendingAccess';
import { xTrendingStyles } from './xTrendingStyles';

declare const __LOCAL_FIXTURE__: boolean;
declare const __KOLLENS_ICON__: string;
declare const __BNB_ICON__: string;
const mountId = 'kollens-x-trending';
const svgNamespace = 'http://www.w3.org/2000/svg';
const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const lifecycle = globalThis as typeof globalThis & { kollensXTrendingCleanup?: () => void };
lifecycle.kollensXTrendingCleanup?.();

const dollarOptions = { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 } as const;
const lowerBoundOptions = { ...dollarOptions, roundingMode: 'floor' } as const;
const compactDollars = new Intl.NumberFormat('en', dollarOptions);
const lowerBoundDollars = new Intl.NumberFormat('en', lowerBoundOptions);
const percentChange = new Intl.NumberFormat('en', { style: 'percent', signDisplay: 'always', maximumFractionDigits: 1 });
const taxPercent = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 2 });
const formatTax = (bps: number | undefined) =>
  typeof bps === 'number' && Number.isInteger(bps) && bps >= 0 && bps <= 10_000
    ? taxPercent.format(bps / 10_000) : '—';
const isPage = () => isXPage(location.href) || __LOCAL_FIXTURE__ &&
  location.origin === 'http://127.0.0.1:3360' && location.pathname === '/x-fixture';
const canUseBuy = () => isPage() && document.visibilityState === 'visible' && document.hasFocus();

type BuyResponse = { ok: true } | { ok: false; error: string };
const buyStatusIcons = {
  pending: 'M8 4.5V8l2 1.5',
  error: 'm6 6 4 4m0-4-4 4',
};
type BuyStatus = keyof typeof buyStatusIcons;

function findNewsCard(sidebar: HTMLElement) {
  const heading = Array.from(sidebar.querySelectorAll('h1,h2,h3,[role="heading"]')).find(element =>
    /^today['’]s news(?:\s*close)?$/i.test((element.textContent ?? '').replace(/\s+/g, ' ').trim()));
  if (!heading?.getClientRects().length) return null;
  let content: HTMLElement | null = null;
  for (let card = heading.parentElement; card && card !== sidebar; card = card.parentElement) {
    if (!content) {
      // The heading wrapper has the close control. The content also has news links.
      if (!card.querySelector('a[href], [role="link"]')) continue;
      content = card;
    }
    // X can wrap the news content in a separate element that paints the card frame.
    const style = getComputedStyle(card);
    if (parseFloat(style.borderTopLeftRadius) > 0 && parseFloat(style.borderBottomRightRadius) > 0 &&
      parseFloat(style.borderTopWidth) > 0 && parseFloat(style.borderBottomWidth) > 0) {
      return { card, heading, borderColor: style.borderTopColor };
    }
  }
  return content ? { card: content, heading, borderColor: '' } : null;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function external(url: string, className: string, label?: string) {
  const link = element('a', className, label);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function dollarMetric(label: string, usd: string | null | undefined, description: string, incomplete = false) {
  const metric = element('span', 'metric', `${label} `);
  const amount = Number(usd);
  const formatter = incomplete ? lowerBoundDollars : compactDollars;
  const formatted = Number.isFinite(amount) && amount > 0 ? formatter.format(amount) : null;
  const value = element('strong', '', formatted ? `${incomplete ? '≥' : ''}${formatted}` : '—');
  const color = formatted && cardMetricColor({ value: formatted });
  if (color) value.style.color = color;
  metric.title = formatted && incomplete ? `${description} (known amounts only)` : description;
  metric.append(value);
  return metric;
}

function tokenMarketDetails(item: Pick<TrendingToken, 'address' | 'symbol' | 'quoteSymbol' | 'buyTaxBps' | 'sellTaxBps'>) {
  const details = element('span', 'market-details');
  const symbol = typeof item.symbol === 'string' && item.symbol.trim() || shortAddress(item.address);
  const quote = typeof item.quoteSymbol === 'string' ? item.quoteSymbol.trim() : '';
  const pairLabel = element('span', 'token-pair');
  pairLabel.append(document.createTextNode('Pair '), element('strong', '', quote || '—'));
  pairLabel.title = quote ? `Trading pair: ${symbol}/${quote}` : 'Trading pair unavailable';

  const buy = formatTax(item.buyTaxBps);
  const sell = formatTax(item.sellTaxBps);
  const known = buy !== '—' || sell !== '—';
  const tax = element('span', 'token-tax');
  tax.dataset.known = String(known);
  tax.title = `Buy tax: ${buy === '—' ? 'unavailable' : buy} · Sell tax: ${sell === '—' ? 'unavailable' : sell}`;
  const icon = document.createElementNS(svgNamespace, 'svg');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svgNamespace, 'path');
  path.setAttribute('d', 'M4 2.5h8v11l-2-1.25L8 13.5l-2-1.25L4 13.5v-11Zm2.25 3.25h3.5m-3.5 2.5h3.5');
  icon.append(path);
  const rates = element('span', '', known ? `Tax ${buy}/${sell}` : 'Tax —');
  rates.setAttribute('aria-hidden', 'true');
  tax.append(icon, rates, element('span', 'loading-label', tax.title));
  details.append(pairLabel, tax);
  return details;
}

function tradeCounts(buys: number, sells: number) {
  const counts = element('span', 'counts');
  const dot = element('span', 'counts-dot');
  dot.setAttribute('aria-hidden', 'true');
  counts.append(
    element('span', 'buy', `${buys} ${buys === 1 ? 'buy' : 'buys'}`),
    dot,
    element('span', 'sell', `${sells} ${sells === 1 ? 'sell' : 'sells'}`),
  );
  return counts;
}

function fallbackAvatar(symbol: string) {
  const avatar = element('span', 'avatar', Array.from(symbol)[0]?.toUpperCase() ?? '?');
  avatar.setAttribute('aria-hidden', 'true');
  return avatar;
}

type KolProfile = { identity: string; name: string; social: SocialLink | null };

function tokenProfiles(item: TrendingToken) {
  if (!Array.isArray(item.kols) || item.kols.length !== item.kolCount) return null;
  const profiles = new Map<string, KolProfile>();
  for (const kol of item.kols) {
    if (!extensionAddress(kol?.walletAddress) || typeof kol.name !== 'string' || !kol.name.trim()) return null;
    const link = typeof kol.twitter === 'string' ? normalizeSocialLink(`https://x.com/${kol.twitter}`) : null;
    const social = link?.type === 'x_profile' ? link : null;
    const identity = social ? `x:${social.key}` : `wallet:${kol.walletAddress}`;
    if (!profiles.has(identity)) profiles.set(identity, { identity, name: kol.name, social });
  }
  return [...profiles.values()];
}

function kolPill(name: string, social: SocialLink | null = null) {
  const entry = element('li', '');
  const label = element('span', 'kol-name', name);
  if (!social) {
    const pill = element('span', 'kol-pill');
    pill.title = name;
    pill.append(label);
    entry.append(pill);
    return entry;
  }

  const profile = external(social.url, 'kol-pill');
  profile.title = `${name} · @${social.key}`;
  profile.setAttribute('aria-label', `${name} on X (@${social.key})`);
  const icon = document.createElementNS(svgNamespace, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'currentColor');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svgNamespace, 'path');
  path.setAttribute('d', 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.64 7.584H.47l8.6-9.829L0 1.154h7.594l5.243 6.932 6.064-6.933Zm-1.29 19.491h2.039L6.486 3.24H4.299l13.312 17.404Z');
  icon.append(path);
  profile.append(label, icon);
  entry.append(profile);
  return entry;
}

function kolDropdown(profiles: KolProfile[] | null, recent: string[]) {
  if (!profiles?.length && !recent.length) return null;

  const dropdown = element('div', 'kol-dropdown');
  const names = element('ul', 'kol-names');
  names.setAttribute('aria-label', profiles ? 'KOLs in this time window' : 'Recent KOLs');
  if (profiles) {
    for (const profile of profiles) {
      const entry = kolPill(profile.name, profile.social);
      entry.dataset.kol = profile.identity;
      names.append(entry);
    }
  } else {
    dropdown.append(element('p', 'kol-dropdown-label', 'Recent KOLs'));
    for (const name of recent) names.append(kolPill(name));
  }
  dropdown.append(names);
  return dropdown;
}

function kolToggle(name: string, dropdownId: string) {
  const button = element('button', 'kol-toggle', 'KOLs');
  button.type = 'button';
  button.setAttribute('aria-label', `KOLs for ${name}`);
  button.setAttribute('aria-controls', dropdownId);
  const chevron = document.createElementNS(svgNamespace, 'svg');
  chevron.setAttribute('viewBox', '0 0 10 10');
  chevron.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svgNamespace, 'path');
  path.setAttribute('d', 'M2 3.5 5 6.5 8 3.5');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.25');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  chevron.append(path);
  button.append(chevron);
  return button;
}

function createPanel() {
  const host = element('div', '');
  host.id = mountId;
  const shadow = host.attachShadow({ mode: __LOCAL_FIXTURE__ ? 'open' : 'closed' });
  const styles = new CSSStyleSheet();
  styles.replaceSync(xTrendingStyles);
  shadow.adoptedStyleSheets = [styles];
  const panel = element('section', 'panel');
  panel.setAttribute('aria-label', 'Kollens trending tokens');
  const header = element('div', 'header');
  const brand = external('https://x.com/kollens', 'brand', '@kollens');
  const brandIcon = element('img', 'brand-icon');
  brandIcon.src = __KOLLENS_ICON__;
  brandIcon.alt = '';
  brand.append(brandIcon);
  header.append(element('h2', '', 'Trending Tokens'), brand);

  let selected: TrendingWindow = defaultTrendingWindow;
  const expandedTokens = new Set<string>();
  let pendingBuy: {
    address: string;
    window: TrendingWindow;
    url: string | null;
    parent: HTMLElement | null;
    button: HTMLButtonElement;
  } | null = null;
  let timer: number | undefined;
  let request = 0;
  const windows = Object.keys(trendingWindows) as TrendingWindow[];
  const tools = element('div', 'tools');
  const filters = element('div', 'filters');
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', 'Trade window');
  const buttons = windows.map(window => {
    const button = element('button', '', window);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(window === selected));
    button.addEventListener('click', () => {
      if (window === selected || pendingBuy) return;
      hideBuyStatus();
      selected = window;
      expandedTokens.clear();
      for (const [index, item] of buttons.entries()) item.setAttribute('aria-pressed', String(windows[index] === selected));
      void refresh(true);
    });
    filters.append(button);
    return button;
  });
  const chain = element('img', 'chain');
  chain.src = __BNB_ICON__;
  chain.alt = 'BNB Chain';
  chain.title = 'BNB Chain';
  tools.append(filters, chain);
  const loadingLabel = element('span', 'loading-label');
  loadingLabel.setAttribute('role', 'status');
  const copyStatus = element('span', 'loading-label');
  copyStatus.setAttribute('role', 'status');
  const buyAnnouncement = element('span', 'loading-label');
  buyAnnouncement.setAttribute('role', 'status');
  const buyStatusAnchor = element('div', 'buy-status-anchor');
  buyStatusAnchor.setAttribute('aria-hidden', 'true');
  const buyStatus = element('div', 'buy-status');
  buyStatus.hidden = true;
  const buyStatusIcon = document.createElementNS(svgNamespace, 'svg');
  buyStatusIcon.setAttribute('viewBox', '0 0 16 16');
  const buyStatusCircle = document.createElementNS(svgNamespace, 'circle');
  buyStatusCircle.setAttribute('cx', '8');
  buyStatusCircle.setAttribute('cy', '8');
  buyStatusCircle.setAttribute('r', '6.5');
  const buyStatusMark = document.createElementNS(svgNamespace, 'path');
  const buyStatusText = element('span', '');
  buyStatusIcon.append(buyStatusCircle, buyStatusMark);
  buyStatus.append(buyStatusIcon, buyStatusText);
  buyStatusAnchor.append(buyStatus);
  let buyStatusTimer: number | undefined;
  const content = element('div', 'results');
  const artwork = element('div', 'artwork-preview');
  artwork.setAttribute('popover', 'manual');
  artwork.setAttribute('aria-hidden', 'true');
  const preview = element('img', '');
  preview.alt = '';
  preview.referrerPolicy = 'no-referrer';
  artwork.append(preview);
  panel.append(header, tools, loadingLabel, copyStatus, buyAnnouncement, buyStatusAnchor, content, artwork);
  shadow.append(panel);

  function hideBuyStatus() {
    clearTimeout(buyStatusTimer);
    buyStatus.hidden = true;
    buyAnnouncement.textContent = '';
  }

  function showBuyStatus(state: BuyStatus, message: string) {
    if (!host.isConnected) return;
    clearTimeout(buyStatusTimer);
    buyStatus.dataset.state = state;
    buyStatusMark.setAttribute('d', buyStatusIcons[state]);
    buyStatusText.textContent = message;
    buyStatus.hidden = false;
    buyAnnouncement.textContent = message;
    if (state !== 'pending') buyStatusTimer = window.setTimeout(hideBuyStatus, 5_000);
  }

  function addressButton(address: string, name: string) {
    const label = shortAddress(address);
    const button = element('button', 'token-address');
    const text = element('span', '', label);
    const icon = document.createElementNS(svgNamespace, 'svg');
    icon.setAttribute('viewBox', '0 0 12 12');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-linecap', 'round');
    const back = document.createElementNS(svgNamespace, 'path');
    back.setAttribute('d', 'M2.5 7.5a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1');
    const front = document.createElementNS(svgNamespace, 'rect');
    front.setAttribute('x', '4.5');
    front.setAttribute('y', '4.5');
    front.setAttribute('width', '6');
    front.setAttribute('height', '6');
    front.setAttribute('rx', '1');
    icon.append(back, front);
    button.append(text, icon);
    button.type = 'button';
    button.title = address;
    button.setAttribute('aria-label', `Copy token address for ${name}`);
    let feedback: number | undefined;
    button.addEventListener('click', async () => {
      copyStatus.textContent = '';
      try {
        await navigator.clipboard.writeText(address);
        text.textContent = 'Copied';
        copyStatus.textContent = 'Token address copied';
      } catch {
        text.textContent = 'Copy failed';
        copyStatus.textContent = 'Could not copy the token address';
      }
      clearTimeout(feedback);
      feedback = window.setTimeout(() => { text.textContent = label; }, 1400);
    });
    return button;
  }

  function buyButton(item: TrendingToken, name: string, tradeWindow: TrendingWindow) {
    const button = element('button', 'token-buy');
    button.type = 'button';
    button.title = 'Review this buy in Kollens Companion';
    const addressLabel = shortAddress(item.address);
    const buyName = name === addressLabel ? name : `${name} (${addressLabel})`;
    button.setAttribute('aria-label', `Buy ${buyName}`);

    const metrics = element('span', 'metrics');
    const marketCap = dollarMetric('MC', item.marketCapUsd, 'Market cap');
    const volume = dollarMetric('V', item.volumeUsd, 'Tracked KOL volume for this time window', item.volumeIncomplete);
    metrics.append(marketCap, volume);
    button.setAttribute('aria-description', `${marketCap.title}, ${volume.title}`);
    const label = element('span', 'buy-label');
    const icon = document.createElementNS(svgNamespace, 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svgNamespace, 'path');
    path.setAttribute('d', 'M13 2 3 14h8l-1 8 11-12h-8l1-8z');
    icon.append(path);
    const buyLabel = document.createTextNode('Buy');
    label.append(icon, buyLabel);
    button.append(metrics, label);

    const hitButton = (x: number, y: number) => document.elementFromPoint(x, y) === host &&
      button.contains(shadow.elementFromPoint(x, y));
    const stillPositioned = (bounds: DOMRect) => {
      const now = button.getBoundingClientRect();
      return Math.abs(now.left - bounds.left) < 1 && Math.abs(now.top - bounds.top) < 1 &&
        Math.abs(now.width - bounds.width) < 1 && Math.abs(now.height - bounds.height) < 1;
    };
    let press: { id: number; bounds: DOMRect; parent: HTMLElement | null; released: boolean } | undefined;
    button.addEventListener('pointerdown', event => {
      press = event.isTrusted && event.isPrimary && event.button === 0 && !pendingBuy &&
        canUseBuy() && hitButton(event.clientX, event.clientY)
        ? { id: event.pointerId, bounds: button.getBoundingClientRect(), parent: host.parentElement, released: false }
        : undefined;
    });
    button.addEventListener('pointerup', event => {
      if (press && event.isTrusted && event.isPrimary && event.button === 0 && event.pointerId === press.id &&
          hitButton(event.clientX, event.clientY) && stillPositioned(press.bounds)) press.released = true;
      else press = undefined;
    });
    button.addEventListener('pointercancel', () => { press = undefined; });
    button.addEventListener('keydown', event => {
      if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
    });
    button.addEventListener('click', async event => {
      const pointer = press;
      press = undefined;
      if (!event.isTrusted || event.button !== 0 || event.detail > 1 || pendingBuy || !canUseBuy() || tradeWindow !== selected ||
          !content.contains(button) || !button.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return;
      if (event.detail === 0) {
        // Keyboard and assistive activation must come from the actual focused control.
        const bounds = button.getBoundingClientRect();
        if (shadow.activeElement !== button || !hitButton(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)) return;
      } else if (!pointer?.released || pointer.parent !== host.parentElement || !stillPositioned(pointer.bounds) ||
          !hitButton(event.clientX, event.clientY)) return;

      pendingBuy = { address: item.address, window: tradeWindow, url: location.href, parent: host.parentElement, button };
      ++request;
      clearTimeout(timer);
      button.setAttribute('aria-busy', 'true');
      buyLabel.textContent = 'Opening…';
      showBuyStatus('pending', `Opening buy review for ${buyName}…`);
      const disabled = [...buttons, ...content.querySelectorAll<HTMLButtonElement>('button.token-buy')];
      for (const control of disabled) control.setAttribute('aria-disabled', 'true');
      try {
        const response = await chrome.runtime.sendMessage({
          kind: 'x-trending/buy', address: item.address, window: tradeWindow,
        }) as BuyResponse | undefined;
        if (response?.ok === true) hideBuyStatus();
        else showBuyStatus('error', response?.error || 'Could not open the Kollens buy review. Try again.');
      } catch {
        showBuyStatus('error', 'Could not open the Kollens buy review. Try again.');
      } finally {
        pendingBuy = null;
        button.removeAttribute('aria-busy');
        buyLabel.textContent = 'Buy';
        for (const control of disabled) control.removeAttribute('aria-disabled');
        if (host.isConnected) timer = window.setTimeout(() => void refresh(), 45_000);
      }
    });
    return button;
  }

  function hideArtwork() {
    if (!artwork.matches(':popover-open')) return;
    artwork.hidePopover();
    window.removeEventListener('scroll', hideArtwork, true);
    window.removeEventListener('resize', hideArtwork);
    window.removeEventListener('keydown', dismissArtwork);
  }

  function dismissArtwork(event: KeyboardEvent) {
    if (event.key === 'Escape') hideArtwork();
  }

  function showArtwork(avatar: HTMLElement, image: HTMLImageElement) {
    if (!image.naturalWidth || !avatar.isConnected) return;
    const bounds = avatar.getBoundingClientRect();
    const gap = 6, inset = 8;
    const viewportWidth = document.documentElement.clientWidth;
    const roomBelow = window.innerHeight - bounds.bottom - gap - inset;
    const roomAbove = bounds.top - gap - inset;
    const below = roomBelow >= 160 || roomBelow >= roomAbove;
    const size = Math.min(196, viewportWidth - inset * 2, below ? roomBelow : roomAbove);
    if (size <= bounds.width) return;
    artwork.style.width = artwork.style.height = `${size}px`;
    artwork.style.left = `${Math.max(inset, Math.min(bounds.left, viewportWidth - size - inset))}px`;
    artwork.style.top = `${below ? bounds.bottom + gap : bounds.top - gap - size}px`;
    preview.src = image.src;
    if (!artwork.matches(':popover-open')) artwork.showPopover();
    window.addEventListener('scroll', hideArtwork, { capture: true, passive: true });
    window.addEventListener('resize', hideArtwork);
    window.addEventListener('keydown', dismissArtwork);
  }

  content.addEventListener('scroll', hideArtwork, { capture: true, passive: true });
  function replaceResults(next: HTMLElement) {
    hideArtwork();
    content.replaceChildren(next);
  }

  function showSkeleton() {
    const visibleRows = Math.min(content.querySelectorAll('.list > li').length || 4, 5);
    const list = element('ol', 'list skeleton-list');
    list.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < visibleRows; index++) {
      const row = element('li', '');
      const placeholder = element('div', 'token skeleton-row tracked-row');
      const identity = element('span', 'identity');
      const activity = element('span', 'activity');
      const details = element('span', 'market-details');
      const buy = element('span', 'token-buy');
      identity.append(element('span', 'skeleton-bar'), element('span', 'skeleton-bar'));
      activity.append(element('span', 'skeleton-bar'), element('span', 'skeleton-bar'));
      details.append(element('span', 'skeleton-bar'), element('span', 'skeleton-bar'));
      buy.append(element('span', 'skeleton-bar'), element('span', 'skeleton-bar'), element('span', 'skeleton-bar'));
      placeholder.append(element('span', 'avatar'), identity, activity, details, buy);
      row.append(placeholder);
      list.append(row);
    }
    loadingLabel.textContent = 'Loading trending tokens…';
    content.setAttribute('aria-busy', 'true');
    replaceResults(list);
  }

  function status(message: string, retry = false) {
    const label = element('p', 'status', message);
    label.setAttribute('role', 'status');
    if (retry) {
      const button = element('button', 'retry', 'Try again');
      button.type = 'button';
      button.addEventListener('click', () => void refresh(true));
      label.append(document.createTextNode(' '), button);
    }
    replaceResults(label);
  }

  function marketSection(items: MarketMomentumToken[], window: TrendingWindow) {
    const section = element('section', 'market-section');
    const header = element('div', 'market-header');
    const title = element('h3', '', 'Market momentum');
    title.id = 'kollens-x-market-momentum-title';
    section.setAttribute('aria-labelledby', title.id);
    const source = element('span', 'market-source', 'PancakeSwap V3');
    source.title = 'Confirmed PancakeSwap V3 swaps on BNB Chain';
    header.append(title, source);
    const list = element('ol', 'list');
    for (const item of items) {
      const row = element('li', '');
      const summary = element('div', 'token-row market-row');
      const link = external(`https://gmgn.ai/bsc/token/${item.address}`, 'token');
      link.title = `${item.name} · ${item.symbol} on GMGN`;
      const identity = element('span', 'identity');
      identity.append(element('strong', '', item.name));
      link.append(fallbackAvatar(item.symbol), identity);

      const activity = element('span', 'activity');
      const change = element('span', 'market-change', percentChange.format(item.priceChangePct / 100));
      change.title = `Pool trading price change over ${window}`;
      const counts = tradeCounts(item.buyCount, item.sellCount);
      counts.title = `DEX pool swaps over ${window}`;
      activity.append(change, counts);

      const metrics = element('span', 'metrics');
      metrics.append(
        dollarMetric('MC', item.marketCapUsd, 'Market cap'),
        dollarMetric('V', item.volumeUsd, `DEX pool volume over ${window}`),
      );
      link.append(activity, tokenMarketDetails(item), metrics);
      summary.append(link, addressButton(item.address, item.name));
      row.append(summary);
      list.append(row);
    }
    section.append(header, list);
    return section;
  }

  function render(data: XTrendingResponse) {
    const items = data.items.filter(isDisplayableXTrendingToken);
    const marketItems = selectXMarketMomentum(data);
    for (const address of expandedTokens) {
      if (!items.some(item => item.address === address)) expandedTokens.delete(address);
    }
    if (!items.length && !marketItems.length) {
      status('No tokens traded by multiple KOLs in this window.');
      return;
    }
    const feed = element('div', 'feed');
    if (marketItems.length) feed.append(marketSection(marketItems, data.window));
    const list = element('ol', 'list');
    for (const item of items) {
      const name = item.name || item.symbol || shortAddress(item.address);
      const link = external(`https://kollens.com/token/${item.address}`, 'token');
      link.title = item.symbol && item.symbol !== name ? `${name} · ${item.symbol}` : name;
      const avatar = fallbackAvatar(item.symbol || name);
      if (item.thumbnail && /^data:image\/(?:png|jpeg|webp|avif);base64,/.test(item.thumbnail)) {
        const image = element('img', '');
        image.alt = '';
        image.referrerPolicy = 'no-referrer';
        image.addEventListener('load', () => {
          avatar.replaceChildren(image);
          if (avatar.matches(':hover') && matchMedia('(any-hover: hover)').matches) showArtwork(avatar, image);
        }, { once: true });
        avatar.addEventListener('pointerenter', event => {
          if (event.pointerType !== 'touch') showArtwork(avatar, image);
        });
        avatar.addEventListener('pointerleave', hideArtwork);
        image.src = item.thumbnail;
      }
      const identity = element('span', 'identity');
      identity.append(element('strong', '', name));
      const profiles = tokenProfiles(item);
      const kolCount = profiles?.length ?? item.kolCount;
      const recent = !profiles && Array.isArray(item.recentKols)
        ? [...new Set(item.recentKols.filter(value => typeof value === 'string').slice(0, 3))]
        : [];
      const activity = element('span', 'activity');
      const counts = tradeCounts(item.buyCount, item.sellCount);
      const kolTotal = element('strong', '', `${kolCount} ${kolCount === 1 ? 'KOL' : 'KOLs'}`);
      if (kolCount !== item.kolCount) kolTotal.title = `${item.kolCount} tracked wallets`;
      activity.append(kolTotal, counts);
      link.append(avatar, identity);
      const row = element('li', '');
      const summary = element('div', 'token-row tracked-row');
      summary.append(link, addressButton(item.address, name), tokenMarketDetails(item), activity, buyButton(item, name, data.window));
      row.append(summary);
      const dropdown = kolDropdown(profiles, recent);
      if (dropdown) {
        dropdown.id = `kollens-kols-${item.address}`;
        const toggle = kolToggle(name, dropdown.id);
        const setExpanded = (expanded: boolean) => {
          toggle.setAttribute('aria-expanded', String(expanded));
          dropdown.hidden = !expanded;
        };
        setExpanded(expandedTokens.has(item.address));
        toggle.addEventListener('click', () => {
          const expanded = dropdown.hidden;
          if (expanded) expandedTokens.add(item.address);
          else expandedTokens.delete(item.address);
          setExpanded(expanded);
          if (expanded) {
            const bounds = feed.getBoundingClientRect();
            const reveal = Math.min(dropdown.getBoundingClientRect().bottom - bounds.bottom, summary.getBoundingClientRect().top - bounds.top);
            if (reveal > 0) feed.scrollTop += reveal;
          }
        });
        summary.append(toggle);
        row.append(dropdown);
      }
      list.append(row);
    }
    if (items.length) {
      if (marketItems.length) feed.append(element('h3', 'tracked-heading', 'Tracked KOL activity'));
      feed.append(list);
    }
    const activeElement = shadow.activeElement;
    const activeToken = activeElement?.closest('.list > li')?.querySelector<HTMLAnchorElement>('a.token');
    const focusedKol = activeElement?.closest<HTMLElement>('.kol-names > li')?.dataset.kol;
    const scrollTop = content.querySelector('.feed')?.scrollTop ?? 0;
    replaceResults(feed);
    const tokenLink = Array.from(feed.querySelectorAll<HTMLAnchorElement>('a.token')).find(link => link.href === activeToken?.href);
    const row = tokenLink?.closest('.list > li');
    const toggle = row?.querySelector<HTMLButtonElement>('.kol-toggle');
    const address = activeElement?.matches('.token-address') && row?.querySelector<HTMLButtonElement>('.token-address');
    const profileLink = focusedKol && row
      ? Array.from(row.querySelectorAll<HTMLElement>('.kol-dropdown:not([hidden]) .kol-names > li'))
        .find(entry => entry.dataset.kol === focusedKol)?.querySelector('a')
      : null;
    const buy = activeElement?.matches('.token-buy') && row?.querySelector<HTMLButtonElement>('.token-buy');
    const focus = profileLink || address || buy || ((focusedKol || activeElement?.matches('.kol-toggle')) && toggle) || tokenLink;
    focus?.focus({ preventScroll: true });
    feed.scrollTop = scrollTop;
  }

  async function refresh(showLoading = false) {
    if (pendingBuy) return;
    clearTimeout(timer);
    const current = ++request;
    if (!host.isConnected || !isPage() || document.hidden) return;
    if (!chrome.runtime?.id) {
      lifecycle.kollensXTrendingCleanup?.();
      return;
    }
    if (showLoading || !content.childElementCount) showSkeleton();
    try {
      const response = await chrome.runtime.sendMessage({ kind: 'x-trending/tokens', window: selected }) as XTrendingResponse & { error?: string };
      if (current !== request || !host.isConnected) return;
      if (response?.error || response?.window !== selected || !Array.isArray(response.items)) throw Error('Trending tokens unavailable');
      render(response);
    } catch {
      if (current !== request || !host.isConnected) return;
      status('Could not load trending tokens.', true);
    }
    if (current === request && host.isConnected) {
      loadingLabel.textContent = '';
      content.removeAttribute('aria-busy');
      timer = window.setTimeout(() => void refresh(), 45_000);
    }
  }

  return {
    host,
    refresh,
    isBuySource(address: unknown, window: unknown) {
      const buy = pendingBuy;
      return buy && buy.address === address && buy.window === window && buy.url === location.href &&
        canUseBuy() && host.isConnected && buy.parent === host.parentElement && content.contains(buy.button) &&
        buy.button.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    },
    invalidateBuySource() { if (pendingBuy) pendingBuy.url = null; },
    stop: () => { ++request; clearTimeout(timer); hideBuyStatus(); hideArtwork(); host.remove(); },
  };
}

let sidebar: HTMLElement | null = null;
let widget: ReturnType<typeof createPanel> | null = null;
let scheduled: number | undefined;
function reconcile() {
  scheduled = undefined;
  const currentSidebar = isPage() ? document.querySelector<HTMLElement>('[data-testid="sidebarColumn"]') : null;
  const news = currentSidebar && findNewsCard(currentSidebar);
  sidebar = currentSidebar;
  if (!news) {
    widget?.stop();
    widget = null;
    return;
  }
  if (!widget) {
    document.getElementById(mountId)?.remove();
    widget = createPanel();
  }
  const { color, fontSize } = getComputedStyle(news.heading.querySelector('span') ?? news.heading);
  if (widget.host.style.getPropertyValue('--x-text') !== color) widget.host.style.setProperty('--x-text', color);
  if (widget.host.style.getPropertyValue('--x-title-size') !== fontSize) widget.host.style.setProperty('--x-title-size', fontSize);
  if (widget.host.style.getPropertyValue('--x-border') !== news.borderColor) widget.host.style.setProperty('--x-border', news.borderColor);
  if (widget.host.nextElementSibling !== news.card || widget.host.parentElement !== news.card.parentElement) {
    news.card.before(widget.host);
    void widget.refresh();
  }
}

function schedule() {
  if (scheduled === undefined) scheduled = window.setTimeout(reconcile, 80);
}
const observer = new MutationObserver(records => {
  if (isPage() ? !sidebar?.isConnected || records.some(record => sidebar?.contains(record.target)) : widget !== null) schedule();
});
const onVisibility = () => {
  if (!document.hidden) {
    schedule();
    void widget?.refresh();
  }
};
const onRoute = () => {
  widget?.invalidateBuySource();
  schedule();
};
const onMessage = (message: { kind?: string; address?: unknown; window?: unknown }, sender: chrome.runtime.MessageSender,
  respond: (response: unknown) => void) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return false;
  if (message?.kind === 'x-trending/buy-source') {
    if (widget?.isBuySource(message.address, message.window)) respond({ ok: true });
    return false;
  }
  if (message?.kind === 'x-trending/navigation') onRoute();
  if (message?.kind === 'x-trending/stop') lifecycle.kollensXTrendingCleanup?.();
};
lifecycle.kollensXTrendingCleanup = () => {
  observer.disconnect();
  clearTimeout(scheduled);
  widget?.stop();
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('popstate', onRoute);
  window.removeEventListener('resize', schedule);
  try { chrome.runtime.onMessage.removeListener(onMessage); } catch {}
  delete lifecycle.kollensXTrendingCleanup;
};
observer.observe(document.body, { childList: true, subtree: true });
document.addEventListener('visibilitychange', onVisibility);
window.addEventListener('popstate', onRoute);
window.addEventListener('resize', schedule);
chrome.runtime.onMessage.addListener(onMessage);
schedule();
