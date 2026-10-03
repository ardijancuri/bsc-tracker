export function normalizeLogoUrl(value: string): string | null {
  const image = value.replaceAll('\\/', '/').replaceAll('\\u0026', '&').replaceAll('&amp;', '&');
  const gateway = image.match(/^https:\/\/(?:flap\.mypinata\.cloud|ipfs\.io)\/ipfs\/(.+)$/i);
  const cid = (gateway?.[1] || image.replace(/^ipfs:\/\//i, '').replace(/^ipfs\//i, ''));
  const root = cid.split('/')[0];
  if (/^b[a-z2-7]{20,}$/.test(root) || /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(root)) {
    const host = /^https:\/\/flap\.mypinata\.cloud\/ipfs\//i.test(image) ? 'flap.mypinata.cloud' : 'gateway.pinata.cloud';
    return `https://${host}/ipfs/${cid}`;
  }
  return /^https:\/\//i.test(image) ? image : null;
}

export function imageCandidateUrls(value: string): string[] {
  const normalized = normalizeLogoUrl(value);
  if (!normalized) return [];
  const parsed = new URL(normalized);
  const ipfs = parsed.pathname.match(/^\/ipfs\/((?:b[a-z2-7]{20,}|Qm[1-9A-HJ-NP-Za-km-z]{44})(?:\/.*)?)$/);
  if (!ipfs) return [normalized];
  return [...new Set([normalized, ...['flap.mypinata.cloud', 'ipfs.filebase.io', 'gateway.pinata.cloud'].map(host => `https://${host}/ipfs/${ipfs[1]}`)])];
}

export function flapMetadataUri(raw: string): string | null {
  if (!/^0x(?:[a-f0-9]{64}){2,}$/i.test(raw)) return null;
  const bytes = Buffer.from(raw.slice(2), 'hex');
  if (BigInt(`0x${raw.slice(2, 66)}`) !== 32n) return null;
  const length = BigInt(`0x${raw.slice(66, 130)}`);
  if (length <= 0n || length > 2048n || 64n + length > BigInt(bytes.length)) return null;
  const uri = normalizeLogoUrl(bytes.subarray(64, 64 + Number(length)).toString('utf8'));
  if (!uri || !/^\/ipfs\/(?:b[a-z2-7]{20,}|Qm[1-9A-HJ-NP-Za-km-z]{44})(?:\/|$)/.test(new URL(uri).pathname)) return null;
  return `https://flap.mypinata.cloud${new URL(uri).pathname}`;
}

export function geniusLogoFromHtml(html: string, address: string): string | null {
  if (!html.toLowerCase().includes(address.toLowerCase())) return null;
  const path = html.match(/<link\s+rel="preload"\s+as="image"\s+href="(\/api\/image\?src=[^"]+)"/i)?.[1]
    || html.match(/<meta\s+property="og:image"\s+content="(https:\/\/genius\.fun\/api\/image\?src=[^"]+)"/i)?.[1];
  if (!path) return null;
  const url = new URL(path.replaceAll('&amp;', '&'), 'https://genius.fun');
  if (url.origin !== 'https://genius.fun' || url.pathname !== '/api/image') return null;
  const source = url.searchParams.get('src');
  if (!source || !normalizeLogoUrl(source)) return null;
  return url.href;
}

export function flapLogoFromHtml(html: string, address: string): string | null {
  const payloads: string[] = [];
  for (const script of html.matchAll(/<script[^>]*>self\.__next_f\.push\(([\s\S]*?)\)<\/script>/g)) {
    try { const chunk = JSON.parse(script[1]); if (typeof chunk[1] === 'string') payloads.push(chunk[1]); }
    catch { /* A malformed page fragment cannot supply trusted token metadata. */ }
  }
  // Also support plain/escaped JSON fragments returned by older Flap pages.
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
              const image = coin.metadata?.image || coin.image;
              if (typeof image !== 'string') return null;
              return normalizeLogoUrl(image)?.replace(/^https:\/\/gateway\.pinata\.cloud\/ipfs\//i, 'https://flap.mypinata.cloud/ipfs/') || null;
            }
          } catch { /* Continue to the next complete coin record. */ }
          break;
        }
      }
    }
  }
  return null;
}
