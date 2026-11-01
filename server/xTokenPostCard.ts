import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { TokenPostEvidence, TokenPostNarrative } from '../shared/xTokenPosts.js';
import {renderManropeText,manropeTextWidth} from './xTokenPostFonts.js';

export type XTokenPostCardInput = {
  evidence: TokenPostEvidence;
  narrative: TokenPostNarrative;
  /** Optional already-cached bytes only. Rendering never fetches remote images. */
  tokenAvatar?: Buffer | null;
};

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const clean = (value: string) => value.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/https?:\/\/\S+|www\.\S+|@[\p{L}\p{N}_]+/gu, '').replace(/\s+/g, ' ').trim();
const short = (value: string, max: number) => {
  const chars = Array.from(clean(value));
  let units = 0;
  for (let index = 0; index < chars.length; index++) {
    units += (chars[index].codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1;
    if (units > max) return chars.slice(0, Math.max(0, index - 1)).join('') + '…';
  }
  return chars.join('');
};
const text = (value: string, x: number, y: number, size: number, color = '#f4f6f5', weight = 500,anchor:'start'|'middle'='start') => renderManropeText(value,x,y,size,color,weight,anchor);
const visualLength = (value: string) => Array.from(value).reduce((length, char) => length + ((char.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1), 0);

function usd(value: string | null, maximumFractionDigits = 2) {
  if (value === null) return '—';
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error('Invalid token card metric');
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', minimumFractionDigits: 0, maximumFractionDigits }).format(number);
}

async function imageData(bytes: Buffer | null | undefined, size: number) {
  if (!bytes || bytes.length > 512_000) return null;
  try {
    const instance = sharp(bytes, { animated: false, limitInputPixels: 4_000_000, failOn: 'error' });
    const metadata = await instance.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1) return null;
    const normalized = await instance.rotate().resize(size, size, { fit: 'cover' }).png().toBuffer();
    return `data:image/png;base64,${normalized.toString('base64')}`;
  } catch { return null; }
}

let logo: Promise<string | null> | undefined;
async function logoData() {
  logo ??= (async () => {
    // dist is present in production containers; public is the source-tree fallback.
    for (const relative of ['../dist/kollens-logo-yellow.svg', '../public/kollens-logo-yellow.svg']) {
      try { return `data:image/svg+xml;base64,${(await readFile(fileURLToPath(new URL(relative, import.meta.url)))).toString('base64')}`; } catch { /* Try the packaged location. */ }
    }
    return null;
  })();
  return logo;
}

/** Deterministic brand composition. No user-controlled SVG or image URLs enter the document. */
export async function renderXTokenPostCardSvg(input: XTokenPostCardInput): Promise<string> {
  const { evidence } = input;
  if (!/^0x[0-9a-fA-F]{40}$/.test(evidence.token.address)
    || !Number.isFinite(Date.parse(evidence.evaluatedAt))) throw new Error('Invalid token card evidence');
  const [brand, avatar] = await Promise.all([logoData(), imageData(input.tokenAvatar, 404)]);
  const tokenName = short(evidence.token.name || evidence.token.symbol || 'BNB token', 38);
  const tokenSymbol = short(evidence.token.symbol, 22);
  const titleLines = [tokenName];
  if (visualLength(tokenName) > 12) {
    const chars = Array.from(tokenName);
    let split = 0, length = 0;
    while (split < chars.length && length < visualLength(tokenName) / 2) length += visualLength(chars[split++]);
    const spaces = chars.map((char, index) => char === ' ' ? index : -1).filter(index => index > 0 && index < chars.length - 1);
    if (spaces.length) split = spaces.reduce((best, index) => Math.abs(index - split) < Math.abs(best - split) ? index : best, spaces[0]);
    titleLines.splice(0, 1, chars.slice(0, split).join('').trim(), chars.slice(split).join('').trim());
  }
  const titleSize = Math.min(titleLines.length>1?62:76, 528 / Math.max(1, ...titleLines.map(line => visualLength(line) * 0.64)));
  const tickerLabel = tokenSymbol ? '$' + tokenSymbol : 'BNB MEME TOKEN';
  const tickerSize = Math.min(48, 528 / Math.max(1, visualLength(tickerLabel) * 0.64));
  const centered = (value: string, x: number, y: number, size: number, color = '#f4f6f5', weight = 600) => text(value,x,y,size,color,weight,'middle');
  const metric = (value: string, x: number, y: number, size: number, width: number) => text(value, x, y,
    Math.min(size, width / Math.max(1, manropeTextWidth(value,1,800))), '#f8f6ee', 800);
  const avatarMarkup = avatar ? `<image href="${avatar}" x="97" y="90" width="404" height="404" clip-path="url(#token)"/>`
    : `<circle cx="299" cy="292" r="202" fill="#302a15"/>${centered(Array.from(tokenSymbol || tokenName).slice(0, 2).join('').toUpperCase(), 299, 324.5, 96, '#f0b90b', 800)}`;
  const contentTop = 80;
  const rightLeft = 594;
  const metricCard = (label: string, value: string | null, x: number, width: number, size: number, fractionDigits = 2) =>
    `<g><rect x="${x}" y="310" width="${width}" height="194" rx="24" fill="#171b1c"/>
      ${text(label, x+36, 358, size>100?28:20, '#a9a69a', 550)}
      ${metric(usd(value, fractionDigits), x+36, 468, size, width-72)}</g>`;
  const metrics = evidence.marketVolumeUsd === null
    ? metricCard('Market cap',evidence.marketCapUsd,570,552,108,0)
    : metricCard('Observed volume · 1h',evidence.marketVolumeUsd,570,264,64)
      +metricCard('Market cap',evidence.marketCapUsd,858,264,64,0);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="675" viewBox="0 0 1200 675">
  <title>${escape(tokenName)} — Kollens</title>
  <defs><clipPath id="token"><circle cx="299" cy="292" r="202"/></clipPath>
    <filter id="footer-ink" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="0 0 0 0 0.047 0 0 0 0 0.055 0 0 0 0 0.067 0 0 0 1 0"/></filter>
  </defs>
  <rect width="1200" height="675" fill="#f0b90b"/>
  <rect x="12" y="12" width="1176" height="558" rx="48" fill="#0c0e11"/>
  <g font-family="Manrope, Arial, sans-serif">
  ${avatarMarkup}
  <circle cx="299" cy="292" r="202" fill="none" stroke="#ffffff" stroke-opacity="0.2" stroke-width="2"/>
  <g text-anchor="start">
  ${titleLines.map((line, index) => text(line, rightLeft, contentTop+(titleLines.length > 1 ? 68 : 104) + index * 66, titleSize, '#f8f6ee', 750)).join('')}
  ${text(tickerLabel, rightLeft, contentTop+(titleLines.length>1?194:180), tickerSize, '#f0b90b', 700)}
  ${metrics}
  </g>
  ${brand ? `<image href="${brand}" x="46" y="604" width="246" height="52" filter="url(#footer-ink)"/>` : text('Kollens', 46, 646, 55, '#0c0e11', 800)}
  ${text('kollens.com', 989, 640, 26, '#0c0e11', 650)}
  </g></svg>`;
}

export async function renderXTokenPostCard(input: XTokenPostCardInput): Promise<Buffer> {
  return sharp(Buffer.from(await renderXTokenPostCardSvg(input)), { density: 72, limitInputPixels: 2_000_000 }).png({ compressionLevel: 9 }).toBuffer();
}
