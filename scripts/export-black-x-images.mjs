// Final PNG export: normalize near-black background noise in the imagegen edits.
// Logo colors, typography, layout, and the visible gray fingerprint motif remain.
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const targets = [
  ['profile', '../branding/x/wallet-fingerprint-x-profile-black.png'],
  ['header', '../branding/x/wallet-fingerprint-x-header-black.png'],
];
for (let i = 0; i < targets.length; i++) {
  const input = process.argv[i + 2];
  if (!input) throw new Error('Provide the imagegen profile and header PNG paths.');
  const { data, info } = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let offset = 0; offset < data.length; offset += info.channels) {
    if (Math.max(data[offset], data[offset + 1], data[offset + 2]) <= 9) {
      data[offset] = data[offset + 1] = data[offset + 2] = 0;
    }
  }
  const output = new URL(targets[i][1], import.meta.url);
  await writeFile(output, await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer());
  console.log(`Exported ${targets[i][0]}: ${info.width}x${info.height}, opaque RGB PNG.`);
}
