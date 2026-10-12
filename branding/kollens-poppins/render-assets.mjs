import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const folder = path.dirname(fileURLToPath(import.meta.url));
const background = '#101113';
const stems = ['kollens-logo-white','kollens-logo-yellow','kollens-icon-white','kollens-icon-yellow'];
const exports = [];
for (const stem of stems) {
  const svg = await readFile(path.join(folder,stem+'.svg'));
  const pngPath = path.join(folder,stem+'.png');
  let image = sharp(svg,{density:576});
  image = stem.includes('-logo-') ? image.resize({height:336}) : image.resize(1024,1024);
  await image.png().toFile(pngPath);
  const raw = await sharp(pngPath).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let clear = 0;
  let opaque = 0;
  const allowed = new Set(stem.endsWith('yellow') ? ['249,201,50','255,255,255'] : ['255,255,255']);
  for (let index=0; index<raw.data.length; index+=4) {
    const alpha = raw.data[index+3];
    if (alpha===0) clear++;
    if (alpha===255) {
      opaque++;
      if (!allowed.has(Array.from(raw.data.subarray(index,index+3)).join(','))) throw new Error(`Unexpected opaque color in ${stem}`);
    }
  }
  if (!clear || !opaque) throw new Error(`Missing transparent or solid pixels in ${stem}`);
  exports.push({svg:stem+'.svg',png:stem+'.png',width:raw.info.width,height:raw.info.height,transparentPixels:clear,opaquePixels:opaque,exactOpaqueColors:true});
}

for (const color of ['white','yellow']) {
  const svg = await readFile(path.join(folder,`kollens-logo-${color}.svg`));
  const small = await sharp(svg,{density:576}).resize({height:24}).flatten({background}).png().toBuffer();
  await sharp(small).resize({height:192,kernel:'nearest'}).png().toFile(path.join(folder,`kollens-logo-${color}-24px-proof.png`));
  for (const size of [24,64]) {
    const icon = await readFile(path.join(folder,`kollens-icon-${color}.svg`));
    await sharp(icon,{density:576}).resize(size,size).flatten({background}).png().toFile(path.join(folder,`kollens-icon-${color}-${size}px-proof.png`));
  }
}

const overlays = [];
for (const [index,color] of ['white','yellow'].entries()) {
  const logoSvg = await readFile(path.join(folder,`kollens-logo-${color}.svg`));
  const iconSvg = await readFile(path.join(folder,`kollens-icon-${color}.svg`));
  overlays.push({input:await sharp(logoSvg,{density:576}).resize({width:720}).png().toBuffer(),left:64,top:122+index*260});
  overlays.push({input:await sharp(iconSvg,{density:576}).resize(88,88).png().toBuffer(),left:848,top:154+index*260});
}
const labels = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="640"><text x="64" y="48" fill="#FFFFFF" font-family="Arial,sans-serif" font-size="24">Poppins ExtraBold</text><text x="64" y="99" fill="#A5A9B0" font-family="Arial,sans-serif" font-size="18">White</text><text x="64" y="359" fill="#A5A9B0" font-family="Arial,sans-serif" font-size="18">Yellow K · white text</text></svg>`;
overlays.push({input:Buffer.from(labels),left:0,top:0});
await sharp({create:{width:1000,height:640,channels:4,background}}).composite(overlays).png().toFile(path.join(folder,'comparison.png'));
const manifestPath = path.join(folder,'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath,'utf8'));
manifest.exports = exports;
manifest.preview = 'comparison.png';
manifest.proofs = ['kollens-logo-white-24px-proof.png','kollens-logo-yellow-24px-proof.png'];
await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({exported:exports,comparison:'comparison.png'}));
