// Export production sizes from the selected originals; keep the artwork unchanged.
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import sharp from 'sharp';

const logo = new URL('../branding/bscan-option-4-wallet-fingerprint.png', import.meta.url);
const icon = new URL('../branding/x/wallet-fingerprint-x-profile.png', import.meta.url);
const publicFile = name => new URL(`../public/${name}`, import.meta.url);

const wordmark = await sharp(await readFile(logo))
  .extract({ left: 312, top: 262, width: 1156, height: 345 })
  .resize({ width: 694 }).webp({ quality: 95 }).toBuffer();
// Keep the original artwork, with an 8px optical gap at the 30px header size.
// Clip in the empty space between the symbol and lettering, then move the text.
await writeFile(publicFile('bscan-fingerprint-logo.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" width="1183" height="345" viewBox="0 0 1183 345"><defs><image id="art" width="1156" height="345" href="data:image/webp;base64,${wordmark.toString('base64')}"/><clipPath id="symbol"><rect width="355" height="345"/></clipPath><clipPath id="wordmark"><rect x="355" width="801" height="345"/></clipPath></defs><use href="#art" clip-path="url(#symbol)"/><g transform="translate(27 0)"><use href="#art" clip-path="url(#wordmark)"/></g></svg>\n`);

const iconSource = await readFile(icon);
const square = sharp(iconSource).extract({ left: 195, top: 185, width: 850, height: 850 });
const faviconArtwork = await sharp(iconSource)
  .extract({ left: 270, top: 240, width: 710, height: 750 })
  .resize(114, 120).png().toBuffer();
// The original gold has R > B; its cool charcoal background has R <= B.
// Use that difference as an alpha mask, preserving the exact three ridge shapes.
// A solid gold fill avoids a dark matte along the edges on light browser tabs.
const transparentIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><defs><filter id="gold-cutout" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 1.35 0 -1.35 0 0" result="mask"/><feFlood flood-color="#f9c932"/><feComposite in2="mask" operator="in"/></filter></defs><image x="7" y="4" width="114" height="120" filter="url(#gold-cutout)" href="data:image/png;base64,${faviconArtwork.toString('base64')}"/></svg>\n`;
await writeFile(publicFile('bscan-fingerprint-icon.svg'), transparentIcon);
await writeFile(publicFile('bscan-icon.png'), await sharp(Buffer.from(transparentIcon)).png().toBuffer());
await writeFile(publicFile('bscan-mark.png'), await square.clone().resize(256, 256).png().toBuffer());
await writeFile(publicFile('bscan-mark-small.webp'), await square.clone().resize(80, 80).webp({ quality: 95 }).toBuffer());
await copyFile(new URL('../branding/x/wallet-fingerprint-x-profile-black.png', import.meta.url), publicFile('social/bscan-x-profile.png'));
await copyFile(new URL('../branding/x/wallet-fingerprint-x-header-black.png', import.meta.url), publicFile('social/bscan-x-header.png'));
console.log('Exported the selected fingerprint logo, transparent favicon, and social assets.');
