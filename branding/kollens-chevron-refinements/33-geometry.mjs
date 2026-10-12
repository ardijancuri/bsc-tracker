import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const folder = path.dirname(fileURLToPath(import.meta.url));
const gold = '#F9C932';
const background = '#101113';
const wedge = [[9,90],[73,38],[73,90]];
const chevron = [[95,38],[119,38],[103,64],[119,90],[95,90],[79,64]];
const points = vertices => vertices.map(vertex => vertex.join(',')).join(' ');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-label="Kollens bold wedge chevron icon"><title>Kollens Bold Wedge Chevron</title><desc>Two filled planes share a one-hundred-ten by fifty-two unit envelope. A broad sixty-four-unit wedge is separated by an exact six-unit gap from a compact forty-unit chevron. Both chevron arms have the same twenty-four-unit horizontal band and thirteen-to-eight slope.</desc><g fill="${gold}"><polygon id="chevron33-bold-wedge" points="${points(wedge)}"/><polygon id="chevron33-bold-plane" points="${points(chevron)}"/></g></svg>\n`;
await writeFile(path.join(folder, '33-wedge-chevron-bold.svg'), svg);
const perpendicularBand = 24 * 26 / Math.hypot(16,26);
const previousPerpendicularBand = 22 / Math.SQRT2;
const geometry = {
  name:'33 Bold Wedge Chevron', gold, transparent:true, viewBox:[0,0,128,128],
  bounds:[9,38,119,90], width:110, height:52, center:[64,64],
  wedge:{ vertices:wedge, width:64, height:52, area:64*52/2, slope:52/64 },
  gap:6,
  chevron:{ vertices:chevron, width:40, height:52, horizontalBand:24, armSlope:26/16,
    perpendicularBand, matchedArms:true, horizontalMirrorAxis:64, area:24*52 },
  previous:{ file:'../kollens-geometric-reference-round-2/33-wedge-chevron.svg',
    width:108, height:64, wedgeWidth:46, horizontalBand:22, armSlope:1,
    perpendicularBand:previousPerpendicularBand },
  thicknessIncreaseFraction:perpendicularBand/previousPerpendicularBand-1,
  thicknessIncreaseAtMatchedOverallWidthFraction:(perpendicularBand/110)/(previousPerpendicularBand/108)-1,
  construction:'Two exact filled straight polygons; no curves, strokes, filters, or embedded raster',
};
await writeFile(path.join(folder, '33-geometry.json'), JSON.stringify(geometry,null,2)+'\n');
await sharp(Buffer.from(svg),{ density:288 }).resize(768,768).flatten({ background }).png().toFile(path.join(folder,'33-wedge-chevron-bold-proof.png'));
const small = await sharp(Buffer.from(svg),{ density:288 }).resize(24,24).flatten({ background }).png().toBuffer();
await sharp(small).resize(240,240,{ kernel:'nearest' }).png().toFile(path.join(folder,'33-wedge-chevron-bold-small-proof.png'));

// Compare ink envelopes at the same 480px width, independently of source padding.
const previousSvg = await readFile(path.join(folder,'../kollens-geometric-reference-round-2/33-wedge-chevron.svg'),'utf8');
const inner = document => document.replace(/^[\s\S]*?<svg\b[^>]*>/,'').replace(/<\/svg>\s*$/,'');
const cropped = (document, bounds) => `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="${480*bounds[3]/bounds[2]}" viewBox="${bounds.join(' ')}">${inner(document)}</svg>`;
const oldImage = await sharp(Buffer.from(cropped(previousSvg,[10,32,108,64]))).png().toBuffer();
const newImage = await sharp(Buffer.from(cropped(svg,[9,38,110,52]))).png().toBuffer();
const oldHeight = (await sharp(oldImage).metadata()).height;
const newHeight = (await sharp(newImage).metadata()).height;
const labels = `<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="500"><text x="280" y="54" text-anchor="middle" fill="#F3F5F6" font-family="Arial,sans-serif" font-size="24">Previous 33</text><text x="840" y="54" text-anchor="middle" fill="#F3F5F6" font-family="Arial,sans-serif" font-size="24">Bold refinement</text></svg>`;
await sharp({ create:{ width:1120,height:500,channels:4,background } }).composite([
  { input:oldImage,left:40,top:Math.round(272-oldHeight/2) },
  { input:newImage,left:600,top:Math.round(272-newHeight/2) },
  { input:Buffer.from(labels),left:0,top:0 },
]).png().toFile(path.join(folder,'33-matched-width-comparison-proof.png'));
console.log(`33 finalized. Arm thickness +${(100*geometry.thicknessIncreaseAtMatchedOverallWidthFraction).toFixed(1)}% at matched overall width.`);
