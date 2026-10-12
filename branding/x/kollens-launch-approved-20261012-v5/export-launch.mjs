import sharp from 'sharp';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const fontkit = require('../../../.cache/launch-font-tools/node_modules/fontkit');
const file = name => new URL(name, import.meta.url);
const width = 1600, height = 900;
const fonts = new Map([400, 600, 700, 800].map(weight => [
  weight, fontkit.openSync(fileURLToPath(file(`sources/manrope-latin-${weight}-normal.woff`))),
]));
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
function textPath(content, x, y, size, weight, fill, spacing = 0, anchor = 'start') {
  const font = fonts.get(weight);
  const run = font.layout(content);
  const scale = size / font.unitsPerEm;
  const textWidth = run.positions.reduce((sum, position) => sum + position.xAdvance * scale, 0)
    + Math.max(0, run.glyphs.length - 1) * spacing;
  let cursor = anchor === 'end' ? x - textWidth : x;
  const paths = run.glyphs.map((glyph, index) => {
    const position = run.positions[index];
    const px = cursor + position.xOffset * scale;
    const py = y - position.yOffset * scale;
    cursor += position.xAdvance * scale + spacing;
    return `<path d="${glyph.path.toSVG()}" transform="translate(${px} ${py}) scale(${scale} ${-scale})"/>`;
  }).join('');
  return { svg: `<g fill="${fill}" aria-label="${escape(content)}"><title>${escape(content)}</title>${paths}</g>`, width: textWidth };
}
const text = (...args) => textPath(...args).svg;
const star = (x, y, size, filled = true) => `<g transform="translate(${x} ${y}) scale(${size / 24})"><path d="m12 2 3.1 6.3 7 .9-5.1 4.9 1.2 6.9L12 17.7l-6.2 3.3 1.2-6.9-5.1-4.9 7-.9z" fill="${filled ? '#F9C932' : 'none'}" stroke="#F9C932" stroke-width="1.3" stroke-linejoin="round"/></g>`;
const data = JSON.parse(await readFile(file('market-data.json'), 'utf8'));
const tokens = data.tokens.map((token, index) => {
  const market = token.market.value.data.token;
  const chart = token.chart.value.data;
  const raw = chart.candles?.length ? chart.candles.map(candle => [Number(candle.time), Number(candle.close)])
    : chart.points.map(point => [Date.parse(point.timestamp) / 1000, Number(point.priceUsd)]);
  const points = [...new Map(raw.filter(([time, price]) => Number.isFinite(time) && price > 0).map(point => [point[0], point])).values()]
    .sort((a, b) => a[0] - b[0]);
  if (points.length < 2) throw new Error(`Missing chart data for ${token.name}`);
  const cap = Number(market.marketCapUsd);
  if (!(cap > 0)) throw new Error(`Missing market cap for ${token.name}`);
  const capLabel = cap >= 1e6 ? `$${(cap / 1e6).toFixed(2)}M` : `$${(cap / 1e3).toFixed(1)}K`;
  return { name: token.name, address: token.address, image: ['wangchai', 'safu', 'gm'][index],
    y: [317, 431, 545][index], cap, capLabel, points, chartSource: chart.source,
    chartUpdatedAt: chart.updatedAt, chartRetrievedAt: token.chartRetrievedAt || data.retrievedAt };
});
function sparkline(token, x, y, w, h) {
  const points = token.points;
  const minTime = points[0][0], maxTime = points.at(-1)[0];
  const min = Math.min(...points.map(point => point[1])), max = Math.max(...points.map(point => point[1]));
  const coordinates = points.map(([time, price]) => [
    x + (time - minTime) / (maxTime - minTime || 1) * w,
    y + h - (price - min) / (max - min || 1) * h,
  ]);
  const color = points.at(-1)[1] >= points[0][1] ? '#39CB8F' : '#F1767A';
  return `<polyline points="${coordinates.map(point => point.map(n => n.toFixed(2)).join(',')).join(' ')}" fill="none" stroke="${color}" stroke-width="2.1" stroke-linejoin="round" stroke-linecap="round"/>`;
}
const logo = await readFile(file('sources/kollens-logo.svg'), 'utf8');
const logoBody = logo.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const source = process.argv[2];
if (!source) throw new Error('Pass the ImageGen background file.');
if (resolve(source) !== fileURLToPath(file('key-visual-source.png'))) await copyFile(source, file('key-visual-source.png'));
const background = await sharp(source).resize(width, height, { fit: 'cover' }).png().toBuffer();
let rows = '', clips = '';
for (const token of tokens) {
  const bytes = await readFile(file(`sources/${token.image}.png`));
  clips += `<clipPath id="${token.image}-portrait"><rect x="942" y="${token.y - 24}" width="48" height="48" rx="12"/></clipPath>`;
  rows += `${star(909, token.y - 10, 20)}
    <image x="942" y="${token.y - 24}" width="48" height="48" preserveAspectRatio="xMidYMid slice" clip-path="url(#${token.image}-portrait)" xlink:href="data:image/png;base64,${bytes.toString('base64')}"/>
    ${text(token.name, 1004, token.y + 1, 22, 800, '#F4F5F6')}
    ${text('BNB Chain', 1004, token.y + 23, 13, 400, '#949DA2')}
    ${sparkline(token, 1124, token.y - 19, 104, 38)}
    ${text('MCAP', 1363, token.y - 12, 11, 600, '#949DA2', .4, 'end')}
    ${text(token.capLabel, 1363, token.y + 15, 22, 700, '#F9C932', -.3, 'end')}`;
}
let featureX = 84, features = '';
for (const [index, label] of ['Live trades', 'Watchlists', 'P&L', 'Replays'].entries()) {
  const part = textPath(label, featureX, 657, 23, 400, '#C8CED1');
  features += part.svg;
  featureX += part.width;
  if (index < 3) {
    features += `<circle cx="${featureX + 16}" cy="649" r="2.8" fill="#F9C932"/>`;
    featureX += 32;
  }
}
const overlay = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>${clips}</defs>
  <g transform="translate(80 72) scale(${320 / 201.20397203})">${logoBody}</g>
  ${text('Now live.', 80, 369, 108, 800, '#FFFFFF', -4)}
  ${text('KOL tracking on BNB Chain.', 84, 447, 37, 600, '#F1F3F4', -.9)}
  ${text('Wallets. Trades. Tokens.', 84, 507, 30, 400, '#A8AFB3', -.4)}
  ${features}
  ${text('kollens.com', 84, 786, 31, 700, '#F9C932', -.6)}
  ${text('Watchlist', 912, 234, 20, 700, '#D2D7D9')}
  ${text('7D CHARTS', 1363, 234, 12, 600, '#949DA2', .8, 'end')}
  ${rows}
</svg>`;
await writeFile(file('content-overlay.svg'), overlay);
const output = fileURLToPath(file('kollens-launch-post.png'));
await sharp(background).composite([{ input: Buffer.from(overlay) }]).png().toFile(output);
const manifest = {
  image: 'kollens-launch-post.png', caption: 'launch-post.txt', width, height,
  generationRoute: 'Built-in ImageGen edited background; exact native SVG logo, Manrope glyph outlines, preserved token artwork, data-driven sparklines and market-cap values composited with Sharp.',
  approvedLogo: 'sources/kollens-logo.svg', approvedLogoSha256: createHash('sha256').update(logo).digest('hex'), logoWidth: 320,
  background: 'key-visual-source.png', prompt: 'generation-prompt.md',
  revision: 'Repair the broken right-side lens seam and its diagonal continuation; reduce the exact native logo from 360px to 320px.',
  font: { family: 'Manrope', source: 'Bundled app @fontsource/manrope Latin WOFF weights 400/600/700/800', rendering: 'Fontkit glyph outlines in SVG, no system fallback' },
  marketData: 'market-data.json', marketCapSnapshotAt: data.retrievedAt, period: '7d',
  tokens: tokens.map(token => ({ name: token.name, address: token.address, source: `sources/${token.image}.png`,
    marketCapUsd: token.cap, displayedMarketCap: token.capLabel, chartSource: token.chartSource,
    chartPoints: token.points.length, chartUpdatedAt: token.chartUpdatedAt, chartRetrievedAt: token.chartRetrievedAt,
    chartFirst: token.points[0], chartLast: token.points.at(-1) })),
  dataNote: 'Market caps are a point-in-time snapshot from Kollens token market endpoints. Sparklines use actual available candle closes over the 7d period, normalized to each token’s chart range. Direction controls green/red. No invented price movements.',
};
await writeFile(file('manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ output, width, height, tokens: manifest.tokens.map(t => ({ name: t.name, cap: t.displayedMarketCap, points: t.chartPoints })) }));
