import { useLayoutEffect, useRef, type MouseEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

const pixelsPerSecond = 32;

export function WatchlistMarquee({ children, label, enabled }: { children: ReactNode; label: string; enabled: boolean }) {
  const viewport = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const original = useRef<HTMLDivElement>(null);
  const copy = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useLayoutEffect(() => {
    const container = viewport.current!, strip = track.current!, source = original.current!, duplicate = copy.current!;
    let animation: Animation | null = null;
    let distance = 0;

    const measure = () => {
      const width = source.getBoundingClientRect().width;
      const overflow = enabled && container.clientWidth > 0 && width > container.clientWidth;
      container.dataset.overflow = String(overflow);
      if (!overflow) {
        animation?.cancel(); animation = null; distance = 0;
        return;
      }
      if (animation && Math.abs(width - distance) < .01) return;
      // Preserve the pixel offset when quotes, fonts or the viewport change.
      // Moving exactly one identical copy makes the iteration boundary invisible.
      const time = typeof animation?.currentTime === 'number' ? animation.currentTime : 0;
      const offset = distance ? time * pixelsPerSecond / 1000 % distance : 0;
      const frames = [{ transform: 'translateX(0)' }, { transform: `translateX(-${width}px)` }];
      const duration = width / pixelsPerSecond * 1000;
      if (animation) {
        const effect = animation.effect as KeyframeEffect;
        effect.setKeyframes(frames);
        effect.updateTiming({ duration });
        animation.currentTime = (offset % width) / pixelsPerSecond * 1000;
      } else {
        animation = strip.animate(frames, { duration, iterations: Infinity, easing: 'linear' });
      }
      distance = width;
    };
    const syncCopy = () => {
      // Mirror rendered charts rather than mounting another set of polling hooks.
      const nodes = [...source.childNodes].map(node => node.cloneNode(true));
      duplicate.replaceChildren(...nodes);
      duplicate.querySelectorAll<HTMLElement>('a,button,input,select,textarea,[tabindex]').forEach(element => { element.tabIndex = -1; });
      duplicate.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
    };
    syncCopy(); measure();
    const mutations = new MutationObserver(syncCopy);
    mutations.observe(source, { childList: true, subtree: true, characterData: true, attributes: true });
    const resize = new ResizeObserver(measure);
    resize.observe(container); resize.observe(source);
    return () => { mutations.disconnect(); resize.disconnect(); animation?.cancel(); };
  }, [enabled]);

  const openCopiedToken = (event: MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
    if (!link || link.target && link.target !== '_self' || link.hasAttribute('download')) return;
    const url = new URL(link.href);
    if (url.origin !== window.location.origin) return;
    event.preventDefault();
    navigate(url.pathname + url.search + url.hash);
  };

  return <div className="watchlist-banner-tokens" ref={viewport} aria-label={label}>
    <div className="watchlist-banner-track" ref={track}>
      <div className="watchlist-banner-group" ref={original}>{children}</div>
      <div className="watchlist-banner-group watchlist-banner-copy" ref={copy} aria-hidden="true" onClick={openCopiedToken} />
    </div>
  </div>;
}
