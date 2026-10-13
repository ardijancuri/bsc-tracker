import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const file = name => new URL(name, import.meta.url);
const base = 'https://kollens.com';
const roster = JSON.parse(await readFile(new URL('../../../server/roster.json', import.meta.url), 'utf8'));
const snapshot = JSON.parse(await readFile(file('shared/snapshot.json'), 'utf8'));
const selections = [
  { handle: 'Cupseyy', side: 'sell', displayName: 'Cupsey' },
  { handle: '0xAA_Science', side: 'sell', displayName: '0xAA' },
  { handle: 'aa_AFeng', side: 'buy', symbol: 'BIBI', displayName: 'Afeng' },
  { handle: 'TurtleTavernTV', side: 'buy', displayName: 'Tavern' },
];

async function get(url) {
  const response = await fetch(new URL(url, base), { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response;
}
async function artwork(url, filename) {
  if (!url) throw new Error(`Missing authentic artwork: ${filename}`);
  const response = await get(url);
  const original = Buffer.from(await response.arrayBuffer());
  const relative = `shared/${filename}.png`;
  await writeFile(file(relative), await sharp(original).png().toBuffer());
  return relative;
}

const rows = await Promise.all(selections.map(async selection => {
  const kol = roster.find(row => row.twitter === selection.handle);
  if (!kol) throw new Error(`KOL absent from tracked roster: ${selection.handle}`);
  const source = `/api/trades?limit=100&kol=${kol.address}`;
  const feed = await (await get(source)).json();
  const trade = feed.items.find(row => row.side === selection.side && row.tokenLogoUrl && row.kolAvatarUrl &&
    ['BNB', 'WBNB'].includes(row.quoteSymbol) && Number(row.quoteAmount) > 0 &&
    (!selection.symbol || row.tokenSymbol === selection.symbol));
  if (!trade) throw new Error(`No suitable real trade for ${selection.handle}`);
  return { ...trade, renderKolName: selection.displayName, sourceUrl: base + source };
}));
rows.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
if (new Set(rows.map(row => row.kolTwitter)).size !== 4) throw new Error('Four different KOLs are required');

await Promise.all(rows.map(async (row, index) => {
  [row.art, row.kolArt] = await Promise.all([
    artwork(row.tokenLogoUrl, `trade-token-${index + 1}`),
    artwork(row.kolAvatarUrl, `trade-kol-${index + 1}`),
  ]);
}));

snapshot.trades = rows;
snapshot.liveRowsRetrievedAt = new Date().toISOString();
snapshot.liveSelection = {
  retrievedAt: snapshot.liveRowsRetrievedAt,
  description: 'One real recent BNB trade per distinct tracked KOL, sorted newest first; two buys and two sells.',
  kolHandles: rows.map(row => row.kolTwitter),
  popularityReferences: [
    'https://twitterscore.io/twitter/Cupseyy/',
    'https://mobile.twstalker.com/0xAA_Science',
    'https://twitterscore.io/twitter/aa_AFeng/',
    'https://x.com/TurtleTavernTV',
  ],
};
await writeFile(file('shared/live-kols-snapshot.json'), JSON.stringify({ retrievedAt: snapshot.liveRowsRetrievedAt, rows }, null, 2));
await writeFile(file('shared/snapshot.json'), JSON.stringify(snapshot, null, 2));
console.log(JSON.stringify(rows.map(row => ({ kol: row.renderKolName, handle: row.kolTwitter, token: row.tokenSymbol, side: row.side, quoteAmount: row.quoteAmount, timestamp: row.timestamp }))));
