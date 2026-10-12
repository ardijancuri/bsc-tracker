import sharp from 'sharp';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const file = name => new URL(name,import.meta.url);
const source = file('kollens-launch-post-20261012-v3.png');
const generated = file('kollens-launch-post-20261012-v4-generated.png');
const target = file('kollens-launch-post-20261012-v4.png');
const old = await sharp(await readFile(source)).metadata();
const current = await sharp(await readFile(generated)).metadata();
if(old.width!==current.width || old.height!==current.height) throw new Error('The poster dimensions changed.');

const copyRegion = {left:0,top:240,width:970,height:old.height-240};
const originalCopy = await sharp(await readFile(source)).extract(copyRegion).png().toBuffer();
const officialLogo = await sharp(await readFile(file('kollens-launch-post-20261012-v4-logo.svg')),{density:180})
  .resize(451,103).png().toBuffer();
await sharp(await readFile(generated)).composite([
  {input:originalCopy,left:0,top:240},
  {input:officialLogo,left:70,top:65}
]).png().toFile(fileURLToPath(target));

const originalPixels = await sharp(originalCopy).removeAlpha().raw().toBuffer();
const finalPixels = await sharp(await readFile(target)).extract(copyRegion).removeAlpha().raw().toBuffer();
if(!originalPixels.equals(finalPixels)) throw new Error('The original poster copy changed.');
console.log(`Saved ${old.width} × ${old.height} poster with the native current logo and preserved copy.`);
