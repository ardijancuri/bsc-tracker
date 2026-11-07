import {build} from 'esbuild';
import {randomUUID} from 'node:crypto';
import {mkdir,copyFile,writeFile,readFile,rename,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve,dirname,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),repo=resolve(root,'../..');
const local=process.argv.includes('--local'),qa=process.argv.includes('--gmgn-qa');
const localGmgn=process.argv.includes('--local-gmgn');
const download=process.argv.includes('--download');
if(local&&localGmgn)throw Error('Choose either the local fixture or the local GMGN build');
if(qa&&!local&&!localGmgn)throw Error('GMGN QA requires an isolated local build');
if(download&&(local||localGmgn||qa))throw Error('Only the standard extension build can be packaged for download.');
const out=resolve(root,qa?'dist-gmgn-qa':local?'dist-local':localGmgn?'dist-local-gmgn':'dist');
const gates=JSON.parse(await readFile(resolve(root,'release-gates.json'),'utf8'));
const developmentKey=JSON.parse(await readFile(resolve(root,'development-key.json'),'utf8')).publicKey;
if(gates.gmgnAuthorized||gates.gmgnLayoutVerified)throw Error('GMGN gates require a separately reviewed activation build; initial package stays disabled.');
const define={__API_ORIGIN__:JSON.stringify(local?'http://127.0.0.1:3360':'https://kollens.com'),__GMGN_AUTHORIZED__:'false',
  __LOCAL_FIXTURE__:JSON.stringify(local),__LOCAL_GMGN_LIVE__:JSON.stringify(local||localGmgn)};
const kollensIcon=resolve(repo,'public/kollens-icon.png');
const bnbIcon=resolve(repo,'public/bnb-chain.svg');
await mkdir(resolve(out,'assets'),{recursive:true});
if(!local)for(const file of ['fixture.js','fixture.js.map'])await rm(resolve(out,file),{force:true});
const bundled=await build({absWorkingDir:root,entryPoints:{background:'src/background.ts',content:'src/content.ts',panel:'src/panel.tsx',audio:'src/audio.ts',...(local?{fixture:'src/fixture.ts'}:{})},
  bundle:true,format:'esm',platform:'browser',target:'chrome116',outdir:out,sourcemap:local,minify:!local,
  external:['./assets/*'],loader:{'.woff2':'file'},assetNames:'assets/[name]',define,metafile:download});
// Reinjection must not redeclare top-level lexical bindings in the isolated world.
await build({absWorkingDir:root,entryPoints:['src/content.ts'],bundle:true,format:'iife',platform:'browser',target:'chrome116',outfile:resolve(out,'content.js'),sourcemap:local,minify:!local,define});
await build({absWorkingDir:root,entryPoints:['src/xTrending.ts'],bundle:true,format:'iife',platform:'browser',target:'chrome116',outfile:resolve(out,'x-trending.js'),sourcemap:local,minify:!local,
  define:{...define,__KOLLENS_ICON__:JSON.stringify(`data:image/png;base64,${await readFile(kollensIcon,'base64')}`),
    __BNB_ICON__:JSON.stringify(`data:image/svg+xml;base64,${await readFile(bnbIcon,'base64')}`)}});
const manifest={manifest_version:3,name:'Kollens Companion',version:'0.1.0',minimum_chrome_version:'127',description:'Find tokens sharing social links, with a private Kollens watch desk.',
  key:developmentKey,
  permissions:['storage','offscreen','activeTab','scripting','identity','sidePanel'],host_permissions:[local?'http://127.0.0.1:3360/*':'https://kollens.com/*',...(qa?['https://gmgn.ai/*','https://www.gmgn.ai/*']:[])],
  optional_host_permissions:['https://gmgn.ai/*','https://www.gmgn.ai/*','https://bsc-dataseed.bnbchain.org/*','https://x.com/*'],background:{service_worker:'background.js',type:'module'},
  action:{default_title:'Open Kollens Companion',default_popup:'popup.html',default_icon:'assets/icon.png'},icons:{128:'assets/icon.png'},
  side_panel:{default_path:'sidepanel.html'},
  content_security_policy:{extension_pages:`script-src 'self'; object-src 'none'; form-action 'none'; connect-src 'self' ${local?'http://127.0.0.1:3360':'https://kollens.com'} https://bsc-dataseed.bnbchain.org;`},
  ...(local?{content_scripts:[{matches:['http://127.0.0.1:3360/fixture*'],js:['content.js'],run_at:'document_idle'},
    {matches:['http://127.0.0.1:3360/x-fixture*'],js:['x-trending.js'],run_at:'document_end'}]}:{})};
await writeFile(resolve(out,'manifest.json'),JSON.stringify(manifest,null,2));
const popupHtml='<!doctype html><html lang="en" data-surface="popup"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kollens Companion</title><link rel="stylesheet" href="panel.css"></head><body><div id="root"></div><script type="module" src="panel.js"></script></body></html>';
await writeFile(resolve(out,'popup.html'),popupHtml);
if(local)await copyFile(resolve(root,'fixture-popup.css'),resolve(out,'fixture-popup.css'));
// Same application for the web fixture and standalone QA.
await writeFile(resolve(out,'panel.html'),popupHtml);
await writeFile(resolve(out,'sidepanel.html'),popupHtml.replace('data-surface="popup"','data-surface="side-panel"'));
await writeFile(resolve(out,'audio.html'),'<!doctype html><html><head><meta charset="utf-8"><title>Kollens alert audio</title></head><body><script type="module" src="audio.js"></script></body></html>');
await copyFile(resolve(repo,'public/kollens-logo-yellow.svg'),resolve(out,'assets/kollens-logo.svg'));
await copyFile(kollensIcon,resolve(out,'assets/icon.png'));
await copyFile(resolve(repo,'public/gmgn-icon-transparent.png'),resolve(out,'assets/gmgn.png'));
await copyFile(bnbIcon,resolve(out,'assets/bnb-chain.svg'));
const require=createRequire(import.meta.url);
await copyFile(require.resolve('@fontsource-variable/inter/LICENSE'),resolve(out,'assets/Inter-LICENSE.txt'));
for(const file of ['manrope-latin.woff2','manrope-600.woff2','manrope-700.woff2','Manrope-LICENSE.txt'])await rm(resolve(out,'assets',file),{force:true});

if(download){
  const {zipSync}=await import('fflate');
  // Package only this build's outputs and runtime files. A reused dist folder
  // can also contain old maps or fixture assets that are unsuitable for release.
  const files=[
    ...Object.keys(bundled.metafile.outputs).map(file=>relative(out,resolve(root,file)).split(sep).join('/')),
    'manifest.json','popup.html','panel.html','sidepanel.html','audio.html','x-trending.js',
    'assets/bnb-chain.svg','assets/gmgn.png','assets/icon.png','assets/kollens-logo.svg','assets/Inter-LICENSE.txt',
  ].sort();
  const entries=Object.fromEntries(await Promise.all(files.map(async file=>[file,await readFile(resolve(out,file))])));
  const downloads=resolve(repo,'public/downloads');
  const temporary=resolve(out,`companion-${randomUUID()}.zip`);
  await mkdir(downloads,{recursive:true});
  try{
    await writeFile(temporary,zipSync(entries,{level:6,mtime:new Date(1980,0,1)}));
    await rename(temporary,resolve(downloads,'kollens-companion.zip'));
  }finally{
    await rm(temporary,{force:true});
  }
}
console.log(JSON.stringify({output:out,gmgnAuthorized:false,gmgnLayoutVerified:false,localFixture:local,localGmgnLive:local||localGmgn}));
