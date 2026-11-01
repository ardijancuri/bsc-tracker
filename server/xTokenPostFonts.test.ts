import{describe,it,expect}from'vitest';
import sharp from'sharp';
import{readFileSync}from'node:fs';
import{createRequire}from'node:module';
import{create}from'fontkit';
import{renderManropeText,manropeTextWidth}from'./xTokenPostFonts.js';
const require=createRequire(import.meta.url);

describe('bundled app font in automated X cards',()=>{
 it('renders the glyph outlines from the browser-preferred WOFF2 asset',()=>{
  const browser=create(readFileSync(require.resolve('@fontsource/manrope/files/manrope-latin-800-normal.woff2')));
  if(!('layout'in browser))throw Error('Expected static app font');
  const svg=renderManropeText('Chief Troll $34.2K',20,88,62,'#fff',800);
  for(const glyph of browser.layout('Chief Troll $34.2K').glyphs){
   const outline=glyph.path.toSVG();if(outline)expect(svg).toContain(`d="${outline}"`);
  }
 });
 it('measures the exact bold Manrope file used by the app, including kerning',()=>{
  const font=create(readFileSync(require.resolve('@fontsource/manrope/files/manrope-latin-800-normal.woff2')));
  if(!('layout'in font))throw Error('Expected static app font');
  const expected=font.layout('Chief Troll $34.2K').positions.reduce((n,p)=>n+p.xAdvance,0)*62/font.unitsPerEm;
  expect(manropeTextWidth('Chief Troll $34.2K',62,800)).toBe(expected);
 });
 it('renders identical glyph pixels regardless of host SVG font-family availability',async()=>{
  const content=renderManropeText('Chief Troll $34.2K',20,88,62,'#fff',800);
  expect(content).toContain('<path');expect(content).not.toContain('<text');
  const image=(family:string)=>sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="120"><g font-family="${family}">${content}</g></svg>`)).png().toBuffer();
  expect(await image('Arial')).toEqual(await image('DeliberatelyMissingFont'));
 });
 it('preserves non-Manrope scripts through system fallback and escapes metadata',()=>{
  const svg=renderManropeText('代币 Token <bad>',20,100,30,'#fff',600);
  expect(svg).toContain('代币');expect(svg).toContain('<path');expect(svg).not.toContain('<bad>');expect(svg).toContain('&lt;bad&gt;');
 });
});
