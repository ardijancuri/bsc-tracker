import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roster = JSON.parse(await readFile(path.join(root, 'server/roster.json'), 'utf8'));
const manifestPath = path.join(root, 'server/x-avatars.json');
const avatarDir = path.join(root, 'public/kol-avatars');
const existing = JSON.parse(await readFile(manifestPath, 'utf8'));
const overrides = JSON.parse(await readFile(path.join(root, 'scripts/avatar-overrides.json'), 'utf8'));
const refresh = process.argv.includes('--refresh');
const handles = [...new Map(roster.filter(row => row.twitter).map(row => [row.twitter.toLowerCase(), row.twitter])).values()];
const byHandle = new Map();
const failures = [];
let next = 0;
let finished = 0;

await mkdir(avatarDir, { recursive: true });

async function fetchWithRetries(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; bscan-avatar-fetch/1.0)' },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return response;
      if (response.status !== 429 && response.status < 500) throw new Error(`HTTP ${response.status}`);
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1500));
  }
  throw lastError;
}

function profileImage(html) {
  const tag = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  const url = tag?.[1]?.replaceAll('&amp;', '&');
  if (!url || !/^https:\/\/pbs\.twimg\.com\/profile_images\/[^\s"<>]+/i.test(url)) return null;
  return url;
}

function extension(contentType, bytes) {
  if (contentType?.startsWith('image/jpeg') && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg';
  if (contentType?.startsWith('image/png') && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (contentType?.startsWith('image/webp') && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  throw new Error(`Unexpected image format: ${contentType}`);
}

async function fetchOne(handle) {
  const key = handle.toLowerCase();
  const previous = Object.values(existing).find(row => row.twitter?.toLowerCase() === key);
  if (!refresh && previous?.avatar?.startsWith('/kol-avatars/')) {
    try {
      await access(path.join(root, 'public', previous.avatar));
      byHandle.set(key, previous);
      return;
    } catch { /* Missing local file: fetch it again. */ }
  }
  let imageUrl;
  try {
    const response = await fetchWithRetries(`https://x.com/${encodeURIComponent(handle)}`);
    imageUrl = profileImage(await response.text());
  } catch (error) {
    if (!overrides[key] && !previous?.sourceUrl && !previous?.avatar?.startsWith('https://pbs.twimg.com/')) throw error;
  }
  imageUrl ||= overrides[key] || previous?.sourceUrl || previous?.avatar;
  if (!imageUrl?.startsWith('https://pbs.twimg.com/profile_images/') &&
      imageUrl !== 'https://abs.twimg.com/sticky/default_profile_images/default_profile_200x200.png') throw new Error('No public X profile image');
  const response = await fetchWithRetries(imageUrl);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 2_000_000) throw new Error(`Image size outside expected range: ${bytes.length}`);
  const ext = extension(response.headers.get('content-type'), bytes);
  const filename = `${key}.${ext}`;
  await writeFile(path.join(avatarDir, filename), bytes);
  byHandle.set(key, { twitter: handle, avatar: `/kol-avatars/${filename}`, sourceUrl: imageUrl });
}

async function worker() {
  while (next < handles.length) {
    const handle = handles[next++];
    try { await fetchOne(handle); }
    catch (error) { failures.push({ handle, error: String(error) }); }
    finished++;
    if (finished % 20 === 0) console.log(`${finished}/${handles.length} X profiles checked; ${byHandle.size} images saved; ${failures.length} unavailable`);
  }
}

await Promise.all(Array.from({ length: 3 }, worker));
const manifest = {};
for (const row of roster) {
  const image = byHandle.get(row.twitter?.toLowerCase());
  if (image) manifest[row.address] = image;
}
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ wallets: roster.length, uniqueHandles: handles.length, images: byHandle.size, walletsWithImages: Object.keys(manifest).length, failures }, null, 2));
