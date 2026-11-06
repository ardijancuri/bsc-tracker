const columnIds = ['trenchesNewCreations', 'trenchesCompleting', 'trenchesCompleted'] as const;
const cardSelector = '[data-testid="trench-token-card"]';
const maxRows = 120;
const sampleTimeoutMs = 240;

export interface GmgnColumn {
  id: typeof columnIds[number];
  element: HTMLElement;
  scroller: HTMLElement;
  spacer: HTMLElement;
  rowHeight: number;
  rowCount: number;
}

function pixels(value: string): number {
  return /^\d+(?:\.\d+)?px$/.test(value) ? Number.parseFloat(value) : NaN;
}

export function gmgnRowIndex(card: HTMLElement, column: GmgnColumn): number | null {
  const row = card.parentElement;
  if (row?.parentElement !== column.spacer || !card.matches(cardSelector) ||
      row.style.position !== 'absolute' || pixels(row.style.height) !== column.rowHeight ||
      card.getAttribute('data-trenches-token-chain') !== 'bsc' ||
      card.getAttribute('data-trenches-token-page') !== column.id.slice('trenches'.length)) return null;
  const address = card.getAttribute('data-trenches-token-address')?.toLowerCase();
  const key = row.getAttribute('data-recycler-key');
  if (!address || !/^0x[0-9a-f]{40}$/.test(address) || key?.toLowerCase() !== `${address}-bsc` ||
      card.getAttribute('data-trenches-token-key') !== key) return null;
  const offset = pixels(/^translateY\((.+)\)$/.exec(row.style.transform)?.[1] ?? '');
  const index = Math.round(offset / column.rowHeight);
  return Number.isFinite(index) && index >= 0 && index < column.rowCount &&
    Math.abs(offset - index * column.rowHeight) < 0.01 ? index : null;
}

/** Match the three recycler columns verified in the saved BSC Trenches DOM. */
export function findGmgnColumns(root: HTMLElement): GmgnColumn[] {
  const columns: GmgnColumn[] = [];
  for (const id of columnIds) {
    const elements = root.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`);
    if (elements.length !== 1) continue;
    const element = elements[0];
    const scroller = element.querySelector<HTMLElement>(':scope > .gmgn-scrollbar');
    if (scroller?.style.overflowY !== 'auto' || scroller.children.length !== 1) continue;
    const spacer = scroller.firstElementChild;
    if (!(spacer instanceof HTMLElement) || spacer.style.position !== 'relative') continue;
    const row = spacer.firstElementChild;
    if (!(row instanceof HTMLElement) || !row.hasAttribute('data-recycler-key')) continue;
    const rowHeight = pixels(row.style.height);
    const totalHeight = pixels(spacer.style.height);
    const rowCount = Math.round(totalHeight / rowHeight);
    if (rowHeight < 16 || rowHeight > 256 || !(rowCount >= 1 && rowCount <= maxRows) ||
        Math.abs(totalHeight - rowCount * rowHeight) >= 0.01 || spacer.children.length > rowCount) continue;
    const column = {id, element, scroller, spacer, rowHeight, rowCount};
    if (readMountedRows(column)) columns.push(column);
  }
  return columns;
}

function readMountedRows(column: GmgnColumn): Map<number, HTMLElement> | null {
  const cards = new Map<number, HTMLElement>();
  const keys = new Set<string>();
  if (column.spacer.children.length > column.rowCount) return null;
  for (const row of column.spacer.children) {
    const card = row.querySelector<HTMLElement>(`:scope > ${cardSelector}`);
    if (!card) return null;
    const index = gmgnRowIndex(card, column);
    const key = row.getAttribute('data-recycler-key')!;
    if (index === null || cards.has(index) || keys.has(key)) return null;
    keys.add(key);
    cards.set(index, card);
  }
  return cards;
}

function completeRows(column: GmgnColumn): HTMLElement[] | null {
  if (column.spacer.children.length !== column.rowCount) return null;
  const cards = readMountedRows(column);
  return cards && [...cards.entries()].sort(([a], [b]) => a - b).map(([, card]) => card);
}

/** Give GMGN's own ResizeObserver a larger layout viewport for one bounded read.
 * The original clipping, width and scroll position are preserved. */
export async function sampleGmgnColumn<T>(
  column: GmgnColumn,
  read: (cards: readonly HTMLElement[]) => T,
  signal: AbortSignal,
): Promise<T | null> {
  const {element, scroller, spacer, rowHeight, rowCount} = column;
  const url = location.href;
  const totalHeight = rowHeight * rowCount;
  const current = () => !signal.aborted && !document.hidden && location.href === url && element.isConnected &&
    scroller.parentElement === element && spacer.parentElement === scroller &&
    Math.abs(pixels(spacer.style.height) - totalHeight) < 0.01;
  if (!current()) return null;
  const mounted = completeRows(column);
  if (mounted) return read(mounted);
  if (scroller.scrollTop !== 0 || element.matches(':hover') || element.contains(document.activeElement)) return null;
  const width = scroller.clientWidth;
  const originalHeight = scroller.offsetHeight;
  if (width <= 0 || originalHeight <= 0 || totalHeight <= scroller.clientHeight) return null;
  const rect = scroller.getBoundingClientRect();
  const style = scroller.style;
  const computed = getComputedStyle(scroller);
  const original = scroller.getAttribute('style');
  const overrides = [
    ['min-height', `${totalHeight}px`],
    ['align-self', 'flex-start'],
    ['clip-path', `inset(0 0 calc(100% - ${originalHeight}px) 0)`],
  ];
  const borderWidth = Number.parseFloat(computed.borderLeftWidth) + Number.parseFloat(computed.borderRightWidth);
  if (scroller.offsetWidth - width - borderWidth > 1 && !computed.scrollbarGutter.includes('stable')) {
    overrides.push(['scrollbar-gutter', 'stable']);
  }
  const previous = overrides.map(([property]) => ({
    property,
    value: style.getPropertyValue(property),
    priority: style.getPropertyPriority(property),
    override: '',
  }));
  const cancellation = new AbortController();
  const abort = () => cancellation.abort();
  const stopEvents: [EventTarget, string][] = [
    [signal, 'abort'], [window, 'wheel'], [window, 'pointerdown'], [window, 'keydown'], [window, 'resize'],
    [window, 'pagehide'], [window, 'popstate'], [window, 'hashchange'], [document, 'visibilitychange'],
    [element, 'pointerenter'], [element, 'focusin'], [scroller, 'scroll'],
  ];
  for (const [target, event] of stopEvents) target.addEventListener(event, abort, {capture:true, passive:true});

  let applied: string | null = null;
  try {
    for (const [property, value] of overrides) style.setProperty(property, value, 'important');
    for (const item of previous) item.override = style.getPropertyValue(item.property);
    applied = scroller.getAttribute('style');
    const stable = () => {
      if (!current() || cancellation.signal.aborted || scroller.scrollTop !== 0 || scroller.clientWidth !== width) return false;
      const next = scroller.getBoundingClientRect();
      return Math.abs(next.top - rect.top) < 0.5 && Math.abs(next.left - rect.left) < 0.5 &&
        Math.abs(next.width - rect.width) < 0.5;
    };
    const rows = await new Promise<HTMLElement[] | null>(resolve => {
      let frame = 0;
      const timer = window.setTimeout(abandon, sampleTimeoutMs);
      function finish(cards: HTMLElement[] | null) {
        cancelAnimationFrame(frame);
        window.clearTimeout(timer);
        cancellation.signal.removeEventListener('abort', abandon);
        resolve(cards);
      }
      function abandon() { finish(null); }
      function inspect() {
        if (!stable()) return abandon();
        const cards = completeRows(column);
        if (cards) finish(cards);
        else frame = requestAnimationFrame(inspect);
      }
      cancellation.signal.addEventListener('abort', abandon);
      inspect();
    });
    return rows && stable() ? read(rows) : null;
  } finally {
    for (const [target, event] of stopEvents) target.removeEventListener(event, abort, true);
    if (scroller.getAttribute('style') === applied) {
      if (original === null) scroller.removeAttribute('style');
      else scroller.setAttribute('style', original);
    } else {
      // A site update during the sample may have changed unrelated styles.
      for (const {property, value, priority, override} of previous) {
        if (style.getPropertyPriority(property) === 'important' && style.getPropertyValue(property) === override) {
          if (value) style.setProperty(property, value, priority);
          else style.removeProperty(property);
        }
      }
    }
  }
}
