const reloadKey = 'kollens-module-recovery';
const resumeKey = 'kollens-trade-modal-resume';
const addressPattern = /^0x[a-fA-F0-9]{40}$/;

export function isModuleLoadError(error: unknown) {
  return error instanceof Error && /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Loading chunk .+ failed/i.test(error.message);
}

export function moduleEntry(html: string) {
  const script = html.match(/<script\b[^>]*\btype\s*=\s*["']module["'][^>]*>/i)?.[0];
  return script?.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1] ?? null;
}

type RecoveryEnvironment = {
  entry: string | null;
  loadHtml: () => Promise<string>;
  readGuard: () => string | null;
  writeGuard: (entry: string) => void;
  beforeReload: () => boolean;
  reload: () => void;
};

/** Reload only an outdated build, once per entry, never for ordinary offline failures. */
export async function recoverChangedBuild(error: unknown, environment: RecoveryEnvironment) {
  const { entry } = environment;
  if (!isModuleLoadError(error) || !entry?.startsWith('/assets/')) return false;
  try {
    if (environment.readGuard() === entry) return false;
    const latest = moduleEntry(await environment.loadHtml());
    if (!latest?.startsWith('/assets/') || latest === entry || !environment.beforeReload()) return false;
    // Restricted session storage falls back to the visible Reload button, avoiding loops.
    environment.writeGuard(entry);
    environment.reload();
    return true;
  } catch { return false; }
}

export function reloadOutdatedModule(error: unknown, kol: string, token: string, isActive: () => boolean, resumePublicSelection = true) {
  return recoverChangedBuild(error, {
    entry: document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute('src') ?? null,
    loadHtml: async () => {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetch(window.location.href, { cache: 'no-store', headers: { Accept: 'text/html' }, signal: controller.signal });
        if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) throw new Error('App refresh unavailable');
        return await response.text();
      } finally { window.clearTimeout(timer); }
    },
    readGuard: () => window.sessionStorage.getItem(reloadKey),
    writeGuard: entry => window.sessionStorage.setItem(reloadKey, entry),
    beforeReload: () => {
      if (!isActive()) return false;
      if (resumePublicSelection) window.sessionStorage.setItem(resumeKey, JSON.stringify({ kol: kol.toLowerCase(), token: token.toLowerCase(), at: Date.now() }));
      return true;
    },
    reload: () => window.location.reload(),
  });
}

export function takeResumedTradeModal(kol: string) {
  try {
    const value = window.sessionStorage.getItem(resumeKey);
    if (!value) return null;
    window.sessionStorage.removeItem(resumeKey);
    const resume: unknown = JSON.parse(value);
    if (!resume || typeof resume !== 'object') return null;
    const { kol: savedKol, token, at } = resume as Record<string, unknown>;
    return typeof savedKol === 'string' && savedKol === kol.toLowerCase() && typeof token === 'string'
      && addressPattern.test(token) && typeof at === 'number' && at <= Date.now() && Date.now() - at < 60_000 ? token : null;
  } catch { return null; }
}
