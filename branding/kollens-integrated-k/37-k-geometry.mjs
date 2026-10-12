import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const folder = path.dirname(fileURLToPath(import.meta.url));
const d = 'M0 0H45V56L104 0H145V30L77 100H145V160H88C64 160 45 142 45 120V160H0Z';
const fill = '#F3F5F6';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="145" height="160" viewBox="0 0 145 160" role="img" aria-label="Custom K glyph for kollens"><title>kollens integrated K glyph</title><desc>A continuous forty-five-unit stem supports a sharp upper arm and a smooth lower arm with a horizontal terminal. The right-hand notch remains deep and angular.</desc><path fill="${fill}" d="${d}"/></svg>\n`;
await writeFile(path.join(folder, '37-integrated-k-symbol.svg'), svg);
await writeFile(path.join(folder, '37-k-geometry.json'), JSON.stringify({
  name:'37 Integrated K', role:'First glyph of the kollens wordmark',
  fill, transparent:true, width:145, height:160, viewBox:[0,0,145,160], inkBounds:[0,0,145,160],
  path:d, continuousFilledPath:true, stem:{ left:0,right:45,width:45,top:0,bottom:160 },
  upperArm:{ stemJunction:[45,56], shoulder:[104,0], terminalTop:[145,0], terminalClip:[145,30], topCapWidth:41, clipHeight:30 },
  notch:{ apex:[77,100], horizontalOpeningTo:[145,100], sharp:true },
  lowerArm:{ terminalTop:100,baseline:160,terminalRight:145,
    lowerCurve:{ start:[88,160],control1:[64,160],control2:[45,142],end:[45,120], horizontalTerminalTangent:true,verticalStemTangent:true } },
  reference:'C:/Users/PC/Downloads/photo_2026-10-12_16-43-07.jpg',
  construction:'Analytic straight upper-arm geometry and one smooth cubic lower curve; no raster trace, strokes, masks, filters, or separate icon',
},null,2)+'\n');
const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><rect width="640" height="640" fill="#101113"/><g transform="translate(88 64) scale(3.2)"><path fill="${fill}" d="${d}"/></g></svg>`;
await sharp(Buffer.from(preview)).png().toFile(path.join(folder,'37-integrated-k-proof.png'));
const small = await sharp(Buffer.from(svg),{density:288}).resize({height:24}).flatten({background:'#101113'}).png().toBuffer();
await sharp(small).resize({height:240,kernel:'nearest'}).png().toFile(path.join(folder,'37-integrated-k-small-proof.png'));
console.log('37 integrated K glyph finalized at exact ink bounds [0,0,145,160].');
