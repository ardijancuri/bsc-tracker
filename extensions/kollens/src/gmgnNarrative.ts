import type { Layout } from './adapter';

export type GmgnNarrative = {
  status: 'ready';
  text: string;
} | {
  status: 'unavailable' | 'page_unavailable' | 'busy' | 'access_required' | 'group_changed';
};

export const gmgnNarrativeOrigin = 'https://gmgn.ai/*';

export function gmgnNarrativeAddress(url: string) {
  try {
    const page = new URL(url);
    if (page.origin !== 'https://gmgn.ai' && page.origin !== 'https://www.gmgn.ai') return undefined;
    return /^\/bsc\/token\/(0x[a-f0-9]{40})\/?$/.exec(page.pathname.toLowerCase())?.[1];
  } catch {
    return undefined;
  }
}

/** Injected by value into the current page's top frame. Keep this function self-contained. */
export async function readRenderedGmgnNarrative(
  address: string,
  expectedUrl: string,
  deadline: number,
  layout: Pick<Layout, 'root' | 'card' | 'cardContainer' | 'addressAttribute' | 'chainAttribute'> | null,
  allowDetailFrame: boolean,
): Promise<GmgnNarrative> {
  const gmgnOrigins = ['https://gmgn.ai', 'https://www.gmgn.ai'];
  const tokenPath = `/bsc/token/${address}`;
  if (!gmgnOrigins.includes(location.origin) || !/^0x[a-f0-9]{40}$/.test(address)) return { status: 'page_unavailable' };
  const pageIsCurrent = () => location.href === expectedUrl;
  const matchesTokenUrl = (url: URL) => gmgnOrigins.includes(url.origin) && !url.username && !url.password
    && url.pathname.toLowerCase().replace(/\/$/, '') === tokenPath;
  if (!layout && !matchesTokenUrl(new URL(location.href))) return { status: 'page_unavailable' };

  const detailIcon = 'svg[data-icon="IconNarrative16pxRegular"]';
  const compactIcon = 'span.gmgn-icon-content--glyph[data-icon="\uE069"]';
  const footer = /\s*Disclaimer\s*:\s*AI-generated content\.\s*DYOR before investing\.\s*$/i;
  const visible = (element: Element) => element.getClientRects().length > 0
    && !element.closest('[hidden]')
    && element.ownerDocument.defaultView?.getComputedStyle(element).visibility === 'visible';
  const matchesCard = (card: Element) => {
    if (!layout || !card.isConnected || !card.closest(layout.root) || !card.matches(layout.card)
      || !card.closest(layout.cardContainer ?? layout.root)
      || card.getAttribute(layout.chainAttribute ?? '') !== 'bsc'
      || card.getAttribute(layout.addressAttribute)?.toLowerCase() !== address) return false;
    try {
      return matchesTokenUrl(new URL(card.getAttribute('href') ?? '', expectedUrl));
    } catch {
      return false;
    }
  };
  const readLinkedTooltip = (page: Document, reference: Element | null) => {
    const linked = reference?.getAttribute('aria-describedby')?.split(/\s+/) ?? [];
    for (const id of linked) {
      const element = page.getElementById(id);
      if (!element || !visible(element)) continue;
      const value = element.innerText?.trim() ?? '';
      if (!footer.test(value)) continue;
      const text = value.replace(footer, '').trim();
      if (/^(?:no (?:ai )?narrative[.!]?$|generating narrative\b)/i.test(text)) continue;
      if (text.length > 0 && text.length <= 4000) return text;
    }
    return '';
  };

  const wait = () => new Promise<void>(resolve => setTimeout(resolve, 160));
  const challenged = (page: Document) => page.querySelector('#cf-challenge-running, #challenge-form')
    || /\| Cloudflare$/i.test(page.title);
  const readTooltip = async (trigger: Element, ownerIsCurrent: () => boolean, card?: Element): Promise<GmgnNarrative> => {
    const wrapper = trigger.parentElement;
    if (!wrapper) return { status: 'unavailable' };
    const isCurrent = () => ownerIsCurrent() && wrapper.isConnected && trigger.parentElement === wrapper;
    const openRef = '.pi-tooltip-open[aria-describedby]';
    // Compact cards put the reference on the glyph. Detail pages put it beside the SVG.
    const tooltipRef = () => trigger.matches(compactIcon)
      ? (trigger.hasAttribute('aria-describedby') ? trigger : trigger.querySelector(`:scope > ${openRef}`))
      : wrapper.querySelector(`:scope > ${openRef}`);
    const alreadyOpen = tooltipRef() !== null;
    const iconRect = trigger.getBoundingClientRect();
    const rect = iconRect.width && iconRect.height ? iconRect : (card ?? wrapper).getBoundingClientRect();
    const point = { bubbles: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 };
    try {
      if (!alreadyOpen) {
        trigger.dispatchEvent(new PointerEvent('pointerover', { ...point, pointerType: 'mouse' }));
        trigger.dispatchEvent(new MouseEvent('mouseover', point));
        trigger.dispatchEvent(new PointerEvent('pointermove', { ...point, pointerType: 'mouse' }));
        trigger.dispatchEvent(new MouseEvent('mousemove', point));
      }
      while (Date.now() < deadline && isCurrent()) {
        const text = readLinkedTooltip(trigger.ownerDocument, tooltipRef());
        if (text) return { status: 'ready', text };
        await wait();
      }
      return { status: isCurrent() ? 'unavailable' : 'group_changed' };
    } finally {
      if (!alreadyOpen && isCurrent()) {
        trigger.dispatchEvent(new PointerEvent('pointerout', { ...point, pointerType: 'mouse' }));
        trigger.dispatchEvent(new MouseEvent('mouseout', point));
      }
    }
  };

  const readDetailInFrame = async (): Promise<GmgnNarrative> => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-same-origin allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.referrerPolicy = 'no-referrer';
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1280px;height:800px;border:0;opacity:0;pointer-events:none';
    frame.src = new URL(tokenPath, expectedUrl).href;
    // The validated card can be recycled while the exact detail URL is loading.
    const isCurrent = () => pageIsCurrent() && frame.isConnected;
    document.body.append(frame);
    try {
      while (Date.now() < deadline && isCurrent()) {
        const page = frame.contentDocument;
        if (page && page.URL !== 'about:blank') {
          if (!matchesTokenUrl(new URL(page.URL)) || challenged(page)) return { status: 'page_unavailable' };
          const trigger = page.readyState === 'complete' ? [...page.querySelectorAll(detailIcon)].find(visible) : undefined;
          if (trigger) {
            const result = await readTooltip(trigger, () => isCurrent() && frame.contentDocument === page
              && matchesTokenUrl(new URL(page.URL)));
            if (result.status !== 'group_changed') return result;
          }
        }
        await wait();
      }
      return { status: isCurrent() ? 'unavailable' : 'group_changed' };
    } finally {
      frame.remove();
    }
  };

  let trigger: Element | undefined;
  let card: Element | undefined;
  while (Date.now() < deadline && pageIsCurrent()) {
    if (challenged(document)) return { status: 'page_unavailable' };
    if (layout) {
      const candidates = document.querySelector(layout.root)
        ?.querySelectorAll(`${layout.card}[${layout.addressAttribute}="${address}" i]`) ?? [];
      let matchingCardRendered = false;
      for (const candidate of candidates) {
        if (!matchesCard(candidate) || !visible(candidate) || candidate.closest('[aria-hidden="true"]')) continue;
        matchingCardRendered = true;
        // Site CSS can hide the icon while leaving its tooltip trigger mounted.
        const icon = candidate.querySelector(`${compactIcon}, ${detailIcon}`);
        if (!icon || icon.closest(layout.card) !== candidate) continue;
        card = candidate;
        trigger = icon;
        break;
      }
      if (!trigger && allowDetailFrame && matchingCardRendered) return readDetailInFrame();
    } else {
      trigger = [...document.querySelectorAll(detailIcon)].find(visible);
    }
    if (trigger) break;
    await wait();
  }
  if (!pageIsCurrent()) return { status: 'group_changed' };
  if (!trigger) return { status: 'unavailable' };
  const exactTrigger = trigger;
  return readTooltip(exactTrigger, () => pageIsCurrent()
    && (!layout || (card !== undefined && matchesCard(card) && exactTrigger.closest(layout.card) === card)), card);
}
