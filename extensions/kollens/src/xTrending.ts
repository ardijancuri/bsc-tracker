import { defaultTrendingWindow, trendingWindows, type TrendingWindow } from '../../../shared/trendingTokens';
import { extensionAddress } from '../../../shared/extension';
import { cardMetricColor } from './cardMetrics';
import { browserApi as chrome } from './platform';
import { isXPage, type XTrendingResponse } from './xTrendingAccess';
import { xTrendingStyles } from './xTrendingStyles';

declare const __LOCAL_FIXTURE__: boolean;
declare const __KOLLENS_ICON__: string;
declare const __BNB_ICON__: string;
const mountId = 'kollens-x-trending';
const lifecycle = globalThis as typeof globalThis & { kollensXTrendingCleanup?: () => void };
lifecycle.kollensXTrendingCleanup?.();

const dollarOptions = { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 } as const;
const lowerBoundOptions = { ...dollarOptions, roundingMode: 'floor' } as const;
const compactDollars = new Intl.NumberFormat('en', dollarOptions);
const lowerBoundDollars = new Intl.NumberFormat('en', lowerBoundOptions);
const isPage = () => isXPage(location.href) || __LOCAL_FIXTURE__ &&
  location.origin === 'http://127.0.0.1:3360' && location.pathname === '/x-fixture';

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

function createPanel() {
  const host = element('div', '');
  host.id = mountId;
  const shadow = host.attachShadow({ mode: 'open' });
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
      if (window === selected) return;
      selected = window;
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
  const content = element('div', 'results');
  panel.append(header, tools, loadingLabel, content);
  shadow.append(panel);

  function showSkeleton() {
    const visibleRows = Math.min(content.querySelectorAll('.list > li').length || 4, 5);
    const list = element('ol', 'list skeleton-list');
    list.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < visibleRows; index++) {
      const row = element('li', '');
      const placeholder = element('div', 'token skeleton-row');
      const identity = element('span', 'identity');
      const activity = element('span', 'activity');
      const metrics = element('span', 'metrics');
      identity.append(element('span', 'skeleton-bar'), element('span', 'skeleton-bar'));
      activity.append(element('span', 'skeleton-bar'), element('span', 'skeleton-bar'), element('span', 'skeleton-bar'));
      metrics.append(element('span', 'skeleton-bar'), element('span', 'skeleton-bar'));
      placeholder.append(element('span', 'avatar'), identity, activity, metrics);
      row.append(placeholder);
      list.append(row);
    }
    loadingLabel.textContent = 'Loading trending tokens…';
    content.setAttribute('aria-busy', 'true');
    content.replaceChildren(list);
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
    content.replaceChildren(label);
  }

  function render(data: XTrendingResponse) {
    const items = data.items.filter(item => item && extensionAddress(item.address) && Number.isInteger(item.kolCount) && item.kolCount >= 2);
    if (!items.length) {
      status('No tokens traded by multiple KOLs in this window.');
      return;
    }
    const list = element('ol', 'list');
    for (const item of items) {
      const name = item.name || item.symbol || `${item.address.slice(0, 6)}…${item.address.slice(-4)}`;
      const link = external(`https://kollens.com/token/${item.address}`, 'token');
      link.title = item.symbol && item.symbol !== name ? `${name} · ${item.symbol}` : name;
      const fallback = element('span', '', Array.from(item.symbol || name)[0]?.toUpperCase() ?? '?');
      const avatar = element('span', 'avatar');
      avatar.setAttribute('aria-hidden', 'true');
      avatar.append(fallback);
      if (item.thumbnail && /^data:image\/(?:png|jpeg|webp|avif);base64,/.test(item.thumbnail)) {
        const image = element('img', '');
        image.alt = '';
        image.referrerPolicy = 'no-referrer';
        image.addEventListener('load', () => avatar.replaceChildren(image), { once: true });
        image.src = item.thumbnail;
      }
      const identity = element('span', 'identity');
      const traders = Array.isArray(item.recentKols) ? item.recentKols.filter(value => typeof value === 'string').slice(0, 3) : [];
      const remaining = item.kolCount - traders.length;
      identity.append(element('strong', '', name), element('span', 'kols', traders.join(' · ') + (traders.length && remaining > 0 ? ` +${remaining}` : '')));
      const activity = element('span', 'activity');
      const counts = element('span', 'counts');
      counts.append(
        element('span', 'buy', `${item.buyCount} ${item.buyCount === 1 ? 'buy' : 'buys'}`),
        element('span', 'sell', `${item.sellCount} ${item.sellCount === 1 ? 'sell' : 'sells'}`),
      );
      activity.append(element('strong', '', `${item.kolCount} KOLs`), counts);
      const metrics = element('span', 'metrics');
      metrics.append(
        dollarMetric('MC', item.marketCapUsd, 'Market cap'),
        dollarMetric('V', item.volumeUsd, 'Tracked KOL volume for this time window', item.volumeIncomplete),
      );
      link.append(avatar, identity, activity, metrics);
      const row = element('li', '');
      row.append(link);
      list.append(row);
    }
    const focusedToken = shadow.activeElement instanceof HTMLAnchorElement ? shadow.activeElement.href : null;
    content.replaceChildren(list);
    if (focusedToken) Array.from(list.querySelectorAll('a')).find(link => link.href === focusedToken)?.focus({ preventScroll: true });
  }

  async function refresh(showLoading = false) {
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

  return { host, refresh, stop: () => { ++request; clearTimeout(timer); host.remove(); } };
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
const onMessage = (message: { kind?: string }) => {
  if (message?.kind === 'x-trending/navigation') schedule();
  if (message?.kind === 'x-trending/stop') lifecycle.kollensXTrendingCleanup?.();
};
lifecycle.kollensXTrendingCleanup = () => {
  observer.disconnect();
  clearTimeout(scheduled);
  widget?.stop();
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('popstate', schedule);
  window.removeEventListener('resize', schedule);
  try { chrome.runtime.onMessage.removeListener(onMessage); } catch {}
  delete lifecycle.kollensXTrendingCleanup;
};
observer.observe(document.body, { childList: true, subtree: true });
document.addEventListener('visibilitychange', onVisibility);
window.addEventListener('popstate', schedule);
window.addEventListener('resize', schedule);
chrome.runtime.onMessage.addListener(onMessage);
schedule();
