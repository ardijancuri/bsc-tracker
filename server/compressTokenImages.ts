import { pool } from './db.js';
import { compressTokenImage, imageMime } from './tokenImage.js';

const apply = process.argv.includes('--apply');
let total = 0;
let changed = 0;
let skipped = 0;
let beforeBytes = 0;
let afterBytes = 0;

try {
  const result = await pool.query('SELECT address,logo_url,logo_data,logo_mime FROM tokens WHERE logo_data IS NOT NULL ORDER BY address');
  for (const row of result.rows as { address: string; logo_url: string | null; logo_data: Buffer; logo_mime: string | null }[]) {
    total++;
    const source = row.logo_data;
    beforeBytes += source.length;
    const mime = imageMime(source);
    if (!mime || mime !== row.logo_mime) {
      skipped++;
      afterBytes += source.length;
      continue;
    }
    const image = await compressTokenImage({ url: row.logo_url || '', data: source, mime });
    if (!image) {
      skipped++;
      afterBytes += source.length;
      continue;
    }
    afterBytes += image.data.length;
    if (image.data.length >= source.length) continue;
    changed++;
    if (apply) {
      await pool.query('UPDATE tokens SET logo_data=$2,logo_mime=$3 WHERE address=$1 AND logo_data=$4',
        [row.address, image.data, image.mime, source]);
    }
  }
  console.log(JSON.stringify({ mode: apply ? 'applied' : 'dry-run', total, changed, skipped,
    beforeBytes, afterBytes, savedBytes: beforeBytes - afterBytes }));
} finally {
  await pool.end();
}
