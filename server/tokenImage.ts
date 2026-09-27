import { normalizeLogoUrl } from './tokenLogo.js';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import sharp from 'sharp';
import { Agent, fetch as undiciFetch } from 'undici';

export type TokenImage = { url: string; data: Buffer; mime: string };
const maxImageBytes = 2 * 1024 * 1024;
const maxDownloadBytes = 10 * 1024 * 1024;
const imageHosts = new Set([
  'gateway.pinata.cloud', 'flap.mypinata.cloud', 'static.four.meme',
  'tokens.pancakeswap.finance', 'cdn.dexscreener.com', 'dd.dexscreener.com',
  'coin-images.coingecko.com', 'assets.geckoterminal.com',
  'genius.fun', 'wiredup.fun', 'pbs.twimg.com', 'bscscan.com',
  'axiomtrading-v2.axiom-cdn.io',
]);

export function publicImageIp(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.parse(address);
  const ip = parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()
    ? (parsed as ipaddr.IPv6).toIPv4Address() : parsed;
  return ip.range() === 'unicast';
}

function publicImageAgent(): Agent {
  return new Agent({ connect: { lookup: (hostname, options, callback) => {
    lookup(hostname, { all: true }, (error, addresses) => {
      if (error) { callback(error, '', 4); return; }
      const publicAddresses = addresses.filter((candidate) => publicImageIp(candidate.address));
      if (!publicAddresses.length) { callback(new Error('Image host has no public address'), '', 4); return; }
      if (options.all) callback(null, publicAddresses);
      else callback(null, publicAddresses[0].address, publicAddresses[0].family);
    });
  } } });
}

export function imageMime(data: Uint8Array): string | null {
  if (data.length >= 8 && data[0] === 137 && data[1] === 80 && data[2] === 78 && data[3] === 71 && data[4] === 13 && data[5] === 10 && data[6] === 26 && data[7] === 10) return 'image/png';
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (data.length >= 6 && (Buffer.from(data.subarray(0, 6)).toString() === 'GIF87a' || Buffer.from(data.subarray(0, 6)).toString() === 'GIF89a')) return 'image/gif';
  if (data.length >= 12 && Buffer.from(data.subarray(0, 4)).toString() === 'RIFF' && Buffer.from(data.subarray(8, 12)).toString() === 'WEBP') return 'image/webp';
  if (data.length >= 12 && Buffer.from(data.subarray(4, 8)).toString() === 'ftyp' && ['avif', 'avis'].includes(Buffer.from(data.subarray(8, 12)).toString())) return 'image/avif';
  return null;
}

export async function compressTokenImage(image: TokenImage): Promise<TokenImage | null> {
  if (!image.data.length || image.data.length > maxDownloadBytes || imageMime(image.data) !== image.mime) return null;
  if (image.mime === 'image/gif') return image.data.length <= maxImageBytes ? image : null;
  try {
    const source = sharp(image.data, { limitInputPixels: 40_000_000, failOn: 'error' });
    const metadata = await source.metadata();
    if ((metadata.pages || 1) > 1) return image.data.length <= maxImageBytes ? image : null;
    if (image.mime === 'image/webp' && (metadata.width || 0) <= 192 && (metadata.height || 0) <= 192 && image.data.length <= maxImageBytes) return image;
    const data = await source.rotate().resize(192, 192, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 }).toBuffer();
    if (data.length <= maxImageBytes && imageMime(data) === 'image/webp' && (data.length < image.data.length || image.data.length > maxImageBytes)) {
      return { ...image, data, mime: 'image/webp' };
    }
  } catch { /* Keep an already small, verified image when Sharp cannot decode it. */ }
  return image.data.length <= maxImageBytes ? image : null;
}

export async function onchainTokenImage(source: string, dataUri: string): Promise<TokenImage | null> {
  if (!/^onchain:\/\/56\/0x[a-f0-9]{40}$/i.test(source)) return null;
  const match = dataUri.match(/^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[1].length > Math.ceil(maxDownloadBytes * 4 / 3) + 4) return null;
  const data = Buffer.from(match[1], 'base64');
  if (!data.length || data.length > maxDownloadBytes) return null;
  const mime = imageMime(data);
  return mime ? compressTokenImage({ url: source.toLowerCase(), data, mime }) : null;
}

export async function downloadTokenImage(rawUrl: string): Promise<TokenImage | null> {
  const normalized = normalizeLogoUrl(rawUrl);
  if (!normalized) return null;
  let url = new URL(normalized);
  let externalAgent: Agent | null = null;
  try {
  for (let redirects = 0; redirects <= 2; redirects++) {
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
    const knownHost = imageHosts.has(url.hostname.toLowerCase());
    if (!knownHost && (url.hostname.startsWith('[') || isIP(url.hostname))) return null;
    const request = { signal: AbortSignal.timeout(12000), redirect: 'manual' as const,
      headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif' } };
    if (!knownHost) externalAgent ||= publicImageAgent();
    const response = knownHost
      ? await fetch(url, request)
      : await undiciFetch(url, { ...request, dispatcher: externalAgent! });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) return null;
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body || Number(response.headers.get('content-length') || 0) > maxDownloadBytes) {
      await response.body?.cancel();
      return null;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxDownloadBytes) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const data = Buffer.concat(chunks);
    const mime = imageMime(data);
    return mime ? compressTokenImage({ url: normalized, data, mime }) : null;
  }
  return null;
  } finally { await externalAgent?.close(); }
}
