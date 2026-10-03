export function websiteUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    // Explorer and social links already have their own profile controls.
    if (['bscscan.com', 'x.com', 'twitter.com', 't.me'].includes(url.hostname.replace(/^www\./, ''))) return null;
    return url.href;
  } catch { return null; }
}

export function flapWebsiteFromHtml(html: string, address: string): string | null {
  const payloads: string[] = [];
  for (const script of html.matchAll(/<script[^>]*>self\.__next_f\.push\(([\s\S]*?)\)<\/script>/g)) {
    try { const chunk = JSON.parse(script[1]); if (typeof chunk[1] === 'string') payloads.push(chunk[1]); }
    catch { /* Ignore incomplete page fragments. */ }
  }
  payloads.push(html.replaceAll('\\"', '"'));
  for (const payload of payloads) {
    for (const marker of payload.matchAll(/"coin"\s*:\s*\{/g)) {
      const start = marker.index! + marker[0].length - 1;
      let depth = 0, quoted = false, escaped = false;
      for (let i = start; i < Math.min(payload.length, start + 512_000); i++) {
        const char = payload[i];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === '{') depth++;
        else if (char === '}' && --depth === 0) {
          try {
            const coin = JSON.parse(payload.slice(start, i + 1));
            if (coin.address?.toLowerCase() === address.toLowerCase()) {
              return websiteUrl(coin.metadata?.website || coin.website);
            }
          } catch { /* Continue to the next complete coin record. */ }
          break;
        }
      }
    }
  }
  return null;
}

export async function lookupTokenWebsite(address: string): Promise<string | null> {
  if (/7777$|8888$/i.test(address)) {
    try {
      const response = await fetch(`https://flap.sh/bnb/${address}`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const website = flapWebsiteFromHtml(await response.text(), address);
        if (website) return website;
      }
    } catch { /* Continue with other metadata providers. */ }
  }
  const [dex, gecko] = await Promise.all([
    (async () => {
      try {
        const response = await fetch(`https://api.dexscreener.com/tokens/v1/bsc/${address}`, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) return null;
        const pairs = await response.json() as { baseToken?: { address?: string }; info?: { websites?: { url?: string }[] } }[];
        for (const pair of Array.isArray(pairs) ? pairs : []) {
          if (pair.baseToken?.address?.toLowerCase() !== address.toLowerCase()) continue;
          for (const link of pair.info?.websites || []) {
            const website = websiteUrl(link.url);
            if (website) return website;
          }
        }
      } catch { /* Website metadata is optional. */ }
      return null;
    })(),
    (async () => {
      try {
        const response = await fetch(`https://api.geckoterminal.com/api/v2/networks/bsc/tokens/${address}/info`, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) return null;
        const result = await response.json() as { data?: { attributes?: { address?: string; websites?: string[] } } };
        const metadata = result.data?.attributes;
        if (metadata?.address?.toLowerCase() !== address.toLowerCase()) return null;
        for (const link of metadata.websites || []) {
          const website = websiteUrl(link);
          if (website) return website;
        }
      } catch { /* Website metadata is optional. */ }
      return null;
    })(),
  ]);
  return dex || gecko;
}
