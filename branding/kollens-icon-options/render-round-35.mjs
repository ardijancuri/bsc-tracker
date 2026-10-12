import sharp from 'sharp';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const file=name=>new URL(name,import.meta.url);
const gold='#F9C932';
const xy=p=>p.map(n=>+n.toFixed(4)).join(' ');
const polygon=points=>`M${points.map(xy).join(' L')} Z`;
const vertices=(r,cx=64,cy=64)=>Array.from({length:6},(_,i)=>{
  const a=(-90+i*60)*Math.PI/180;return[cx+r*Math.cos(a),cy+r*Math.sin(a)];
});
const hex=(r,cx=64,cy=64)=>polygon(vertices(r,cx,cy));
const rayHex=(r,degrees)=>{
  const dir=[Math.cos(degrees*Math.PI/180),Math.sin(degrees*Math.PI/180)];
  const v=vertices(r,0,0), cross=(a,b)=>a[0]*b[1]-a[1]*b[0];
  for(let i=0;i<6;i++){
    const a=v[i],b=v[(i+1)%6],e=[b[0]-a[0],b[1]-a[1]],den=cross(dir,e);
    if(Math.abs(den)<1e-8)continue;
    const t=cross(a,e)/den,u=cross(a,dir)/den;
    if(t>=0&&u>=-1e-6&&u<=1+1e-6)return[64+dir[0]*t,64+dir[1]*t];
  }
  throw new Error('Ray did not reach hex boundary');
};
const segment=polygon([rayHex(52,-82),vertices(52)[1],rayHex(52,22),rayHex(31,22),vertices(31)[1],rayHex(31,-82)]);
const hexFocus=`<g fill="${gold}"><path d="${segment}"/><path d="${segment}" transform="rotate(120 64 64)"/><path d="${segment}" transform="rotate(240 64 64)"/></g>`;
const chainLens=`<defs><mask id="chain-lens-holes" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128"><rect width="128" height="128" fill="white"/><path d="${hex(17,48,48)} ${hex(17,80,80)}" fill="black"/></mask></defs><g fill="${gold}" mask="url(#chain-lens-holes)"><path d="${hex(33,48,48)}"/><path d="${hex(33,80,80)}"/></g>`;
const cells=[[64,42],[38,86],[90,86]];
const signalMesh=`<defs><mask id="signal-mesh-holes" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128"><rect width="128" height="128" fill="white"/><path d="${cells.map(([x,y])=>hex(11,x,y)).join(' ')}" fill="black"/></mask></defs><g fill="${gold}" mask="url(#signal-mesh-holes)"><path d="${polygon(cells)}"/>${cells.map(([x,y])=>`<path d="${hex(24,x,y)}"/>`).join('')}</g>`;
const frame=polygon([[32,16],[96,16],[112,32],[112,96],[96,112],[32,112],[16,96],[16,32]]);
const aperture=polygon([[48,40],[80,40],[88,48],[88,80],[80,88],[48,88],[40,80],[40,48]]);
const focusGrid=`<defs><mask id="focus-grid-holes" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128"><rect width="128" height="128" fill="white"/><path d="${aperture}" fill="black"/><g fill="black"><rect x="54" y="16" width="20" height="14"/><rect x="98" y="54" width="14" height="20"/><rect x="54" y="98" width="20" height="14"/><rect x="16" y="54" width="14" height="20"/></g></mask></defs><path d="${frame}" fill="${gold}" mask="url(#focus-grid-holes)"/>`;
const entries=[
  {stem:'114-hex-focus',title:'Hex Focus',inner:hexFocus,caption:'A clear focus window within a connected chain.',meaning:'Three linked sections form a geometric lens for viewing KOL activity.'},
  {stem:'115-chain-lens',title:'Chain Lens',inner:chainLens,caption:'A wallet and its token trades stay connected.',meaning:'Two linked cells represent the connection between a KOL wallet and its token trades.'},
  {stem:'116-signal-mesh',title:'Signal Mesh',inner:signalMesh,caption:'Tracked wallet signals come together in one view.',meaning:'Three connected cells represent KOL activity brought together in one view.'},
  {stem:'117-focus-grid',title:'Focus Grid',inner:focusGrid,caption:'A focused window supported by a tracking network.',meaning:'A modular frame represents keeping one wallet in focus within the wider activity network.'},
];
const official=await readFile(file('../../public/kollens-header-logo.svg'),'utf8');
const wordmark=official.slice(official.indexOf('<svg x="53"'));
const composites=[],manifest=[];
for(let i=0;i<entries.length;i++){
  const e=entries[i];
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-label="Kollens ${e.title}"><title>${e.title}</title><desc>${e.meaning}</desc>${e.inner}</svg>\n`;
  await writeFile(file(`${e.stem}.svg`),svg);
  const {data}=await sharp(Buffer.from(svg)).resize(512,512).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let opaque=0,transparent=0;
  for(let p=0;p<data.length;p+=4){
    if(data[p+3]){data[p]=249;data[p+1]=201;data[p+2]=50;}
    if(data[p+3]===0)transparent++;
    if(data[p+3]===255)opaque++;
  }
  if(!opaque||!transparent)throw new Error(`${e.title}: missing mark or transparency`);
  for(let p=0;p<512;p++)if(data[p*4+3]||data[(511*512+p)*4+3]||data[p*512*4+3]||data[(p*512+511)*4+3])throw new Error(`${e.title}: clipped geometry`);
  await writeFile(file(`${e.stem}.png`),await sharp(data,{raw:{width:512,height:512,channels:4}}).png().toBuffer());
  const lockup=`<svg xmlns="http://www.w3.org/2000/svg" width="183.939" height="42" viewBox="0 0 183.939 42"><svg x="0" y="0" width="42" height="42" viewBox="0 0 128 128">${e.inner}</svg>${wordmark}`;
  await writeFile(file(`${e.stem}-header.svg`),lockup);
  const large=await sharp(Buffer.from(svg)).resize(280,280).png().toBuffer();
  const small=await sharp(Buffer.from(lockup)).resize({height:34}).png().toBuffer();
  const {width:smallWidth}=await sharp(small).metadata();
  const label=`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="45"><text x="300" y="30" text-anchor="middle" font-family="Arial,sans-serif" font-size="23" font-weight="600" fill="#f3f5f6">${i+1} · ${e.title}</text></svg>`;
  const caption=`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="45"><text x="300" y="25" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" fill="#adb6bd">${e.caption}</text></svg>`;
  const left=(i%2)*600,top=Math.floor(i/2)*460;
  composites.push({input:large,left:left+160,top:top+20},{input:Buffer.from(label),left,top:top+310},{input:Buffer.from(caption),left,top:top+350},{input:small,left:left+Math.round((600-smallWidth)/2),top:top+405});
  manifest.push({...e,inner:undefined,svg:`${e.stem}.svg`,png:`${e.stem}.png`,header:`${e.stem}-header.svg`,color:gold,medium:'Native SVG vector concepts',reference:'https://www.bnbchain.org/en/brand-guidelines'});
  console.log(`${e.stem}: transparent export, exact yellow and padding verified`);
}
await sharp({create:{width:1200,height:920,channels:4,background:'#0b0e11'}}).composite(composites).png().toFile(fileURLToPath(file('comparison-round-35.png')));
await writeFile(file('round-35-manifest.json'),JSON.stringify(manifest,null,2));
let notes='# Kollens geometric chain emblems — round 35\n\nFour original SVG constructions using repeated geometric units, uniform spacing and compact icon silhouettes. The general modular character of the [official BNB Chain symbol](https://www.bnbchain.org/en/brand-guidelines) informed the direction; its paths and layout are not used in these marks. Kollens color is #F9C932. Backgrounds are transparent.\n\n';
for(const e of entries)notes+=`## ${e.title}\n\n${e.meaning}\n\n- [SVG](${e.stem}.svg)\n- [Transparent PNG](${e.stem}.png)\n- [Header preview](${e.stem}-header.svg)\n\n`;
await writeFile(file('round-35-notes.md'),notes);
