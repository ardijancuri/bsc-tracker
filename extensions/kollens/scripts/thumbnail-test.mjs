import{chromium}from'@playwright/test';
import assert from'node:assert/strict';
import{readFile,writeFile,mkdir}from'node:fs/promises';
import{resolve}from'node:path';import{fileURLToPath}from'node:url';
import{build}from'esbuild';
const root=fileURLToPath(new URL('../',import.meta.url)),repo=resolve(root,'../..'),artifacts=resolve(repo,'.cache/extension/qa');await mkdir(artifacts,{recursive:true});
const html=await readFile(resolve(root,'fixtures-gmgn-bsc.html'),'utf8'),picture=await readFile(resolve(repo,'public/kollens-icon.png'));
const readerBundle=await build({entryPoints:[resolve(root,'src/gmgnReader.ts')],bundle:true,format:'esm',write:false});
const{readRenderedGmgnTrenches}=await import('data:text/javascript;base64,'+Buffer.from(readerBundle.outputFiles[0].text).toString('base64'));
const out=resolve(root,'dist-gmgn-qa'),context=await chromium.launchPersistentContext(resolve(repo,'.cache/extension/chrome-thumbnail-'+Date.now()),{channel:'chromium',headless:true,viewport:{width:1400,height:1000},args:[`--disable-extensions-except=${out}`,`--load-extension=${out}`]});
let checks=0;const imageRequests=[],errors=[];
try{
 await context.route('https://gmgn.ai/**',route=>route.fulfill({contentType:'text/html',body:html,headers:{'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'"}}));
 await context.route('https://cdn.gmgn.ai/kollens-fixture/**',route=>{imageRequests.push(route.request().url());return route.fulfill(route.request().url().includes('missing')?{status:404,body:''}:{contentType:'image/png',body:picture,headers:{'Cache-Control':'public,max-age=3600'}});});
 const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker'),id=new URL(worker.url()).hostname,gmgn=await context.newPage();
 await gmgn.goto('https://gmgn.ai/?chain=bsc');
 await gmgn.evaluate(()=>{const style=document.createElement('style');style.textContent='body{background:#0c1011;color:white}section{width:30%;display:inline-block;vertical-align:top}[data-testid="trench-token-card"]{padding:8px;min-height:90px}';document.head.append(style);
  for(const[index,card]of [...document.querySelectorAll('[data-testid="trench-token-card"]')].slice(0,2).entries()){
   const img=document.createElement('img');img.alt='logo';img.width=66;img.height=66;img.src=`https://cdn.gmgn.ai/kollens-fixture/${index}.webp`;card.prepend(img);
   const platform=document.createElement('img');platform.alt='Fourmeme Icon';platform.src='https://cdn.gmgn.ai/kollens-fixture/platform.webp';card.prepend(platform);
   card.querySelector('.g-social').innerHTML='<a href="https://x.com/i/status/2117053489755140401">X post</a>';
  }});
 const raw=await gmgn.evaluate(readRenderedGmgnTrenches);assert.equal(raw.cards[0].logoUrl,'https://cdn.gmgn.ai/kollens-fixture/0.webp');assert.equal(raw.cards[1].logoUrl,'https://cdn.gmgn.ai/kollens-fixture/1.webp');checks++;
 const panel=await context.newPage();panel.on('pageerror',e=>errors.push(e.message));await panel.goto(`chrome-extension://${id}/panel.html`);
 const command=message=>panel.evaluate(message=>chrome.runtime.sendMessage(message),message);
 await gmgn.bringToFront();await panel.getByRole('button',{name:'Enable on GMGN',exact:true}).click();await gmgn.bringToFront();
 async function state(){await gmgn.bringToFront();return command({kind:'state'});}
 async function until(test){for(let i=0;i<80;i++){const s=await state();if(test(s))return s;await gmgn.waitForTimeout(50);}throw Error('Thumbnail state did not settle');}
 let current=await until(s=>s.page?.cards[0]?.logoUrl===raw.cards[0].logoUrl);assert.equal(current.page.alerts.length,0);checks++;
 await panel.reload();await panel.locator('.token-thumbnail img').first().waitFor();await panel.waitForFunction(()=>[...document.querySelectorAll('.token-thumbnail img')].every(i=>i.complete&&i.naturalWidth>0));
 assert.deepEqual((await panel.locator('.token-thumbnail img').evaluateAll(images=>images.map(i=>i.getAttribute('src')))).sort(),['https://cdn.gmgn.ai/kollens-fixture/0.webp','https://cdn.gmgn.ai/kollens-fixture/1.webp']);checks++;
 const width=await panel.locator('.token-thumbnail').first().evaluate(e=>({width:Math.round(e.getBoundingClientRect().width),height:Math.round(e.getBoundingClientRect().height),radius:getComputedStyle(e).borderRadius}));assert.deepEqual(width,{width:36,height:36,radius:'10px'});checks++;
 await panel.evaluate(()=>window.__thumbnailNode=document.querySelector('.token-thumbnail img'));const requestsBefore=imageRequests.length;
 await command({kind:'state'});await panel.waitForTimeout(2200);assert.equal(await panel.evaluate(()=>window.__thumbnailNode===document.querySelector('.token-thumbnail img')),true);assert.equal(imageRequests.length,requestsBefore);checks++;
 await gmgn.locator('img[alt="logo"]').first().evaluate(e=>e.setAttribute('src','https://cdn.gmgn.ai/kollens-fixture/changed.webp'));
 await until(s=>s.page.cards[0].logoUrl?.endsWith('/changed.webp'));await panel.locator('.token-thumbnail img[src$="/changed.webp"]').waitFor();assert.equal((await state()).page.alerts.length,0);checks++;
 // Isolated fake account transport. No real account, login or API request.
 await worker.evaluate(async()=>{const workspace={user:{id:'thumbnail-test',name:'Local thumbnail test',email:'extension-qa@example.test',telegramLinked:true,telegramUsername:'kollens_demo'},items:[],preferences:{highlights:true,matchTypes:['x_post','x_community','telegram','x_profile'],newGroups:true,newMembers:true,watchedOnly:false,sound:false},preferencesRevision:0};
  await chrome.storage.local.set({auth:{token:'fake-thumbnail-token',expiresAt:new Date(Date.now()+86400000).toISOString(),userId:'thumbnail-test'},'account:thumbnail-test':{workspace,drafts:[]}});
  globalThis.fetch=async(input,init={})=>{const url=String(input);if(!url.startsWith('http://127.0.0.1:3360/api/extension/'))throw Error('Unexpected test transport');
   if(url.includes('/tokens/')){const body=JSON.parse(init.body);workspace.items=[{...body,address:url.split('/').pop(),revision:1,updatedAt:new Date().toISOString()}];}
   return Response.json(workspace);
  };});
 await panel.reload();await panel.getByRole('button',{name:'Save NVA',exact:true}).waitFor();await panel.getByRole('button',{name:'Save NVA',exact:true}).click();await panel.getByRole('button',{name:/^Saved/}).click();await panel.locator('.saved-item .token-thumbnail img').waitFor();
 current=await command({kind:'state'});assert.equal(current.workspace.items[0].logoUrl,'https://cdn.gmgn.ai/kollens-fixture/changed.webp');checks++;
 assert.equal(await panel.locator('footer').count(),0);assert.equal(await panel.locator('header .brand-logo').evaluate(e=>Math.round(e.getBoundingClientRect().width)),76);checks++;
 await panel.getByRole('button',{name:'Profile',exact:true}).click();await panel.getByRole('heading',{name:'Account',exact:true}).waitFor();
 await panel.getByRole('heading',{name:'extension-qa@example.test',exact:true}).waitFor();await panel.getByRole('button',{name:'Log out',exact:true}).waitFor();
 await panel.getByText('@kollens_demo',{exact:true}).waitFor();await panel.getByText('Twitter/X',{exact:true}).waitFor();
 assert.equal(await panel.getByText('Public Wallets',{exact:true}).count(),0);
 await panel.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__copiedAccountId=value;}}});});
 await panel.getByRole('button',{name:'Copy account UID',exact:true}).click();await panel.getByText('Account UID copied',{exact:true}).waitFor();
 assert.equal(await panel.evaluate(()=>window.__copiedAccountId),'thumbnail-test');checks++;
 await panel.screenshot({path:resolve(artifacts,'account-popup.png'),clip:{x:0,y:0,width:360,height:600}});
 await panel.getByRole('button',{name:'Settings',exact:true}).click();await panel.getByRole('heading',{name:'Match settings',exact:true}).waitFor();assert.equal(await panel.getByRole('button',{name:'Log out',exact:true}).count(),0);await panel.getByRole('button',{name:'Tokens',exact:true}).click();checks++;
 await gmgn.locator('img[alt="logo"]').first().evaluate(e=>e.closest('[data-testid="trench-token-card"]').remove());await until(s=>!s.page.cards.some(c=>c.address===raw.cards[0].address));
 await panel.reload();await panel.locator('.saved-item .token-thumbnail img').waitFor();assert.equal(await panel.locator('.saved-item .token-thumbnail img').getAttribute('src'),'https://cdn.gmgn.ai/kollens-fixture/changed.webp');checks++;
 // A recycled token gets its own source; it cannot keep the previous logo.
 await gmgn.locator('img[alt="logo"]').first().evaluate(e=>{const card=e.closest('[data-testid="trench-token-card"]'),address='0x'+'c'.repeat(40);card.setAttribute('data-trenches-token-address',address);card.setAttribute('href','/bsc/token/'+address);e.src='https://cdn.gmgn.ai/kollens-fixture/recycled.webp';});
 await until(s=>s.page.cards.some(c=>c.address==='0x'+'c'.repeat(40)&&c.logoUrl?.endsWith('/recycled.webp')));checks++;
 // Restore a second matching member and show the actual popup with thumbnails.
 await gmgn.evaluate(()=>{const card=document.querySelector('[data-testid="trench-token-card"]').cloneNode(true);card.setAttribute('data-trenches-token-address','0x'+'d'.repeat(40));card.setAttribute('href','/bsc/token/0x'+'d'.repeat(40));card.querySelector('img[alt="logo"]').src='https://cdn.gmgn.ai/kollens-fixture/restored.webp';card.querySelector('[class~="group/token-translation"] > span').textContent='RED';document.querySelector('[data-testid^="trenches"]').prepend(card);});
 await until(s=>s.page.groups.some(g=>g.addresses.length===2&&g.key==='2117053489755140401'));await panel.getByRole('button',{name:/^Matches/}).click();await panel.waitForFunction(()=>document.querySelectorAll('.token-thumbnail img').length===2&&[...document.querySelectorAll('.token-thumbnail img')].every(i=>i.complete&&i.naturalWidth>0));await panel.screenshot({path:resolve(artifacts,'token-thumbnails.png'),clip:{x:0,y:0,width:360,height:600}});checks++;
 await gmgn.locator('img[alt="logo"]').first().evaluate(e=>e.src='https://cdn.gmgn.ai/kollens-fixture/missing.webp');await until(s=>s.page.cards.some(c=>c.logoUrl?.endsWith('/missing.webp')));
 await panel.waitForFunction(()=>document.querySelectorAll('.token-thumbnail img').length===1);const failedRequests=imageRequests.filter(u=>u.includes('/missing.webp')).length;await panel.waitForTimeout(2200);assert.equal(imageRequests.filter(u=>u.includes('/missing.webp')).length,failedRequests);assert.equal(failedRequests,1);checks++;
 await gmgn.locator('img[alt="logo"]').first().evaluate(e=>e.src='javascript:alert(1)');await until(s=>s.page.cards.some(c=>c.address==='0x'+'d'.repeat(40)&&c.logoUrl===null));checks++;
 assert.deepEqual(errors,[]);assert.ok(imageRequests.every(url=>!url.includes('fake-thumbnail-token')));checks++;
 const report={ok:true,checks,actualUnpackedChrome:true,automaticImages:true,manualReader:true,lazyImageUpdates:true,recycledIdentity:true,savedImagesWithoutRenderedCard:true,noPollReloads:true,brokenImageFallback:true,extraHostPermissions:false,gmgnApiCalls:0,realAccountsUsed:0,realMessages:0,size:width,errors};await writeFile(resolve(artifacts,'token-thumbnails-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await context.close();}
