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
    const image = rawImage.replaceAll('\\/', '/').replaceAll('\\u0026', '&').replaceAll('&amp;', '&');
    if (/^https:\/\//i.test(image)) return image;
    const cid = image.replace(/^ipfs:\/\//i, '').replace(/^ipfs\//i, '');
    if (/^b[a-z2-7]{20,}$/.test(cid) || /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) {
      return `https://gateway.pinata.cloud/ipfs/${cid}`;
    }
    return null;
  }
  return null;
}
