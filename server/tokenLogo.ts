export function normalizeLogoUrl(value: string): string | null {
  const image = value.replaceAll('\\/', '/').replaceAll('\\u0026', '&').replaceAll('&amp;', '&');
  const gateway = image.match(/^https:\/\/(?:flap\.mypinata\.cloud|ipfs\.io)\/ipfs\/(.+)$/i);
  const cid = (gateway?.[1] || image.replace(/^ipfs:\/\//i, '').replace(/^ipfs\//i, ''));
  if (/^b[a-z2-7]{20,}$/.test(cid) || /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) {
    const host = /^https:\/\/flap\.mypinata\.cloud\/ipfs\//i.test(image) ? 'flap.mypinata.cloud' : 'gateway.pinata.cloud';
    return `https://${host}/ipfs/${cid}`;
  }
  return /^https:\/\//i.test(image) ? image : null;
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
  const coinMarker = '\\"coin\\":{';
  let start = 0;
  while ((start = html.indexOf(coinMarker, start)) !== -1) {
    const coin = html.slice(start, start + 500);
    const coinAddress = coin.match(/\\"address\\":\\"(0x[a-f0-9]{40})\\"/i)?.[1];
    if (coinAddress?.toLowerCase() !== address.toLowerCase()) {
      start += coinMarker.length;
      continue;
    }

    const metadataStart = html.indexOf('\\"metadata\\":{', start);
    if (metadataStart === -1 || metadataStart - start > 30_000) return null;
    const rawImage = html.slice(metadataStart, metadataStart + 1500).match(/\\"image\\":\\"([^\"]+)\\"/i)?.[1];
    if (!rawImage) return null;
    return normalizeLogoUrl(rawImage)?.replace(/^https:\/\/gateway\.pinata\.cloud\/ipfs\//i, 'https://flap.mypinata.cloud/ipfs/') || null;
  }
  return null;
}
