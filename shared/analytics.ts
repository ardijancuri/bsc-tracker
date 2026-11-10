export const analyticsTimeZone = 'Europe/Skopje';

const dayFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: analyticsTimeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const publicPages = new Set([
  '/tokens',
  '/leaderboard',
  '/extension',
  '/privacy-policy',
  '/terms-of-use',
]);

export function analyticsDay(now = new Date()) {
  return dayFormatter.format(now);
}

export function analyticsPublicPath(path: string): string | null {
  if (path === '/') return path;
  const canonical = path.replace(/\/$/, '');
  if (publicPages.has(canonical)) return canonical;
  return /^\/(?:kol|token)\/0x[0-9a-f]{40}$/i.test(canonical) ? canonical.toLowerCase() : null;
}
