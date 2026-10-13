import {readFile,writeFile} from 'node:fs/promises';
import sharp from 'sharp';

const folder = new URL('./',import.meta.url);
const svg = await readFile(new URL('kollens-x-header-centered.svg',folder));
const png = await sharp(svg).removeAlpha().png().toBuffer();
const metadata = await sharp(png).metadata();
if(metadata.width!==1500 || metadata.height!==500 || metadata.hasAlpha) throw new Error('Invalid header export.');
await writeFile(new URL('kollens-x-header-centered-1500x500.png',folder),png);
await writeFile(new URL('manifest-centered.json',folder),JSON.stringify({
  name:'Final Kollens X header with horizontally centered logo and URL',
  dimensions:[1500,500],
  source:'kollens-x-header-centered.svg',
  logo:{centerX:750,y:232,width:503.009930075,height:105},
  url:{text:'kollens.com',centerX:750,baseline:386},
  background:'Embedded grayscale market grid, decorative price line and candlesticks.',
  foreground:'Exact approved vector logo and Manrope URL outlines.',
  pngBytes:png.length,
},null,2)+'\n');
console.log(JSON.stringify({width:metadata.width,height:metadata.height,pngBytes:png.length}));
