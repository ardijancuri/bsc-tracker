import {readFileSync,readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {create,type Font} from 'fontkit';

const require=createRequire(import.meta.url);
const filesDirectory=path.dirname(require.resolve('@fontsource/manrope/files/manrope-latin-400-normal.woff2'));
const files=readdirSync(filesDirectory);
const faces=new Map<string,Font>();
const segmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
const escape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const fontWeight=(weight:number)=>[400,500,600,700,800].find(w=>w>=weight)??800;

function face(file:string){
 let font=faces.get(file);
 if(!font){const loaded=create(readFileSync(path.join(filesDirectory,file)));
  if(!('layout' in loaded)||!loaded.familyName.startsWith('Manrope'))throw Error('Bundled Manrope font unavailable');
  font=loaded;faces.set(file,font);
 }
 return font;
}
function supports(font:Font,text:string){return Array.from(text).every(char=>font.hasGlyphForCodePoint(char.codePointAt(0)!));}
function fontFor(text:string,weight:number){
 const latin=`manrope-latin-${weight}-normal.woff2`;
 const preferred=face(latin);if(supports(preferred,text))return preferred;
 for(const file of files){if(file===latin||!file.endsWith(`-${weight}-normal.woff2`))continue;const candidate=face(file);if(supports(candidate,text))return candidate;}
 return null;
}
type Run={text:string;font:Font|null};
function runs(value:string,weight:number){
 const result:Run[]=[];
 for(const part of segmenter.segment(value)){
  const font=fontFor(part.segment,weight),last=result.at(-1);
  if(last&&last.font===font)last.text+=part.segment;else result.push({text:part.segment,font});
 }
 return result;
}
function fallbackWidth(value:string,size:number){
 return [...segmenter.segment(value)].reduce((n,p)=>n+size*(Array.from(p.segment).some(c=>c.codePointAt(0)!>=0x2e80)?1:0.6),0);
}
function runWidth(run:Run,size:number){
 return run.font?run.font.layout(run.text).positions.reduce((n,p)=>n+p.xAdvance,0)*size/run.font.unitsPerEm:fallbackWidth(run.text,size);
}
export function manropeTextWidth(value:string,size:number,weight=500){return runs(value,fontWeight(weight)).reduce((n,run)=>n+runWidth(run,size),0);}

/** Use the exact Fontsource files imported by src/main.tsx. Native SVG engines
 * can silently fall back even when font-family says Manrope; glyph paths avoid
 * OS font installation, network requests and platform-dependent Latin fallbacks.
 * Scripts/emoji outside Manrope retain the app's ordinary system-font fallback. */
export function renderManropeText(value:string,x:number,y:number,size:number,color:string,weight:number,anchor:'start'|'middle'='start'){
 const resolvedWeight=fontWeight(weight),parts=runs(value,resolvedWeight);
 const width=parts.reduce((n,run)=>n+runWidth(run,size),0);
 let cursor=x-(anchor==='middle'?width/2:0),markup='';
 for(const run of parts){
  if(run.font){
   const scale=size/run.font.unitsPerEm,layout=run.font.layout(run.text);let advance=0;
   markup+=`<g transform="translate(${cursor} ${y}) scale(${scale} ${-scale})">`;
   for(let i=0;i<layout.glyphs.length;i++){
    const position=layout.positions[i],outline=layout.glyphs[i].path.toSVG();
    if(outline)markup+=`<path transform="translate(${advance+position.xOffset} ${position.yOffset})" d="${outline}"/>`;
    advance+=position.xAdvance;
   }
   markup+='</g>';
  }else{
   markup+=`<text x="${cursor}" y="${y}" font-family="Noto Sans CJK SC, Microsoft YaHei, Segoe UI Emoji, sans-serif" font-size="${size}" font-weight="${resolvedWeight}" text-anchor="start">${escape(run.text)}</text>`;
  }
  cursor+=runWidth(run,size);
 }
 return `<g aria-label="${escape(value)}" data-font-family="Manrope" font-size="${size}" font-weight="${resolvedWeight}" fill="${color}">${markup}</g>`;
}
