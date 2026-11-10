import { useEffect } from 'react';
import { getPageSeo, getPageSeoTags, getPageStructuredData, getSiteRoute, type PageSeoIdentity } from '../shared/pageSeo';

export function usePageSeo(pathname: string | null, identity?: PageSeoIdentity | null) {
  const name = identity?.name;
  const symbol = identity?.symbol;
  const missing = identity === null;
  const loading = identity === undefined;

  useEffect(() => {
    if (pathname === null) return;
    const { head } = document;
    const route = getSiteRoute(pathname);
    const existingCanonical = head.querySelector<HTMLLinkElement>('link[rel="canonical"][data-kollens-seo]');
    if (loading && (route.kind === 'token' || route.kind === 'kol') && existingCanonical
      && new URL(existingCanonical.href).pathname === route.path) return;

    const seo = getPageSeo(pathname, missing ? null : { name, symbol });
    document.title = seo.title;
    head.querySelectorAll('[data-kollens-seo]').forEach(element => element.remove());
    for (const { attribute, key, content } of getPageSeoTags(seo)) {
      const meta = document.createElement('meta');
      meta.setAttribute(attribute, key);
      meta.content = content;
      meta.dataset.kollensSeo = '';
      head.append(meta);
    }
    if (seo.canonical) {
      const canonical = document.createElement('link');
      canonical.rel = 'canonical';
      canonical.href = seo.canonical;
      canonical.dataset.kollensSeo = '';
      head.append(canonical);
    }

    head.querySelector('#kollens-structured-data')?.remove();
    const structuredData = getPageStructuredData(seo);
    if (structuredData) {
      const schema = document.createElement('script');
      schema.id = 'kollens-structured-data';
      schema.type = 'application/ld+json';
      schema.textContent = JSON.stringify(structuredData);
      head.append(schema);
    }
  }, [pathname, name, symbol, missing, loading]);
}
