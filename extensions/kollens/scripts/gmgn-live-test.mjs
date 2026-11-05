import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),out=resolve(root,'dist-gmgn-qa'),artifacts=resolve(root,'../../.cache/extension/qa');
await mkdir(artifacts,{recursive:true});
const html=await readFile(resolve(root,'fixtures-gmgn-bsc.html'),'utf8');
const context=await chromium.launchPersistentContext(resolve(root,'../../.cache/extension/chrome-live-qa-'+Date.now()),{channel:'chromium',headless:true,viewport:{width:1500,height:1000},args:[`--disable-extensions-except=${out}`,`--load-extension=${out}`]});
let checks=0;const errors=[];
try{
  // Replay public captured card markup locally; no GMGN request or account session.
  await context.route('https://*.gmgn.ai/**',route=>route.abort());
  await context.route('https://gmgn.ai/**',route=>route.fulfill({contentType:'text/html',body:html,headers:{'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'"}}));
  let worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');const id=new URL(worker.url()).hostname;
  const gmgn=await context.newPage();gmgn.on('pageerror',error=>errors.push(error.message));await gmgn.goto('https://gmgn.ai/?chain=bsc');
  await gmgn.evaluate(()=>{const style=document.createElement('style');style.textContent='body{background:#0c1011;color:#eee;font:14px system-ui}main{display:flex;gap:16px}section{width:32%;height:900px;overflow:auto}[data-testid="trench-token-card"]{background:#1a2224;min-height:100px;padding:14px;margin:8px;box-sizing:border-box}.g-social a{color:#93baae;margin-right:8px}';document.head.append(style);const cards=document.querySelectorAll('[data-testid="trench-token-card"]');for(const card of [cards[0],cards[1]]){card.querySelector('.g-social').innerHTML='<a href="https://x.com/i/status/2117053489755140401">X post</a>';const button=document.createElement('button');button.textContent='Trade control';button.onclick=()=>document.body.dataset.tradeClicks=String(Number(document.body.dataset.tradeClicks??0)+1);card.append(button);}});
  assert.equal(await gmgn.locator('.kollens-match').count(),0);checks++;
  const sizeBefore=await gmgn.locator('[data-testid="trench-token-card"]').first().boundingBox();
  const panel=await context.newPage();await panel.goto(`chrome-extension://${id}/panel.html`);
  const command=message=>panel.evaluate(message=>chrome.runtime.sendMessage(message),message);
  await panel.getByRole('button',{name:'Tokens',exact:true}).click();
  await gmgn.bringToFront();
  await panel.getByRole('button',{name:'Enable on GMGN',exact:true}).click();await gmgn.bringToFront();
  await gmgn.locator('.kollens-match').first().waitFor();
  async function snapshot(){await gmgn.bringToFront();return command({kind:'state'});}
  async function until(predicate){for(let i=0;i<60;i++){const state=await snapshot();if(predicate(state))return state;await gmgn.waitForTimeout(50);}throw Error('GMGN live state did not settle');}
  let state=await until(s=>s.page?.cards.length===23);
  assert.equal(state.liveEnabled,true);assert.equal(state.page.alerts.length,0);assert.ok(state.page.groups.some(g=>g.key==='2117053489755140401'&&g.addresses.length===2));assert.equal(await gmgn.locator('[href="https://x.com/i/status/2117053489755140401"][data-kollens-social-match]').count(),2);checks++;
  const sizeAfter=await gmgn.locator('[data-testid="trench-token-card"]').first().boundingBox();assert.equal(sizeAfter.width,sizeBefore.width);assert.equal(sizeAfter.height,sizeBefore.height);
  await gmgn.getByRole('button',{name:'Trade control',exact:true}).first().click();assert.equal(await gmgn.locator('body').getAttribute('data-trade-clicks'),'1');checks++;
  await gmgn.evaluate(()=>{const card=document.querySelector('[data-testid="trench-token-card"]').cloneNode(true);card.setAttribute('data-trenches-token-address','0x'+'a'.repeat(40));card.setAttribute('href','/bsc/token/0x'+'a'.repeat(40));document.querySelector('[data-testid^="trenches"]').append(card);});
  state=await until(s=>s.page?.groups.some(g=>g.key==='2117053489755140401'&&g.addresses.length===3));assert.ok(state.page.alerts.some(a=>a.type==='new_member'));checks++;
  const added=gmgn.locator('[data-trenches-token-address="0x'+'a'.repeat(40)+'"]');await added.locator('a').evaluate(el=>el.setAttribute('href','https://x.com/i/status/2117053489755140402'));
  await until(s=>s.page?.groups.some(g=>g.key==='2117053489755140401'&&g.addresses.length===2));assert.ok(!(await added.getAttribute('class')).includes('kollens-match'));checks++;
  await added.evaluate(el=>el.hidden=true);await until(s=>s.page?.cards.length===23);await added.evaluate(el=>el.remove());checks++;
  await gmgn.evaluate(()=>{const board=document.querySelector('[data-testid^="trenches"]');board.append(board.firstElementChild);});state=await until(s=>s.page?.cards.length===23);assert.equal(state.page.groups.find(g=>g.key==='2117053489755140401').addresses.length,2);checks++;
  await gmgn.evaluate(()=>{history.pushState({},'','/?chain=sol');});await gmgn.waitForFunction(()=>!document.querySelector('.kollens-match'));checks++;
  await gmgn.evaluate(()=>{history.pushState({},'','/?chain=bsc');});state=await until(s=>s.page?.status==='ready'&&s.page.cards.length===23);assert.equal(state.page.alerts.length,0);checks++;
  await command({kind:'preferences',preferences:{...state.preferences,highlights:false}});await gmgn.waitForFunction(()=>!document.querySelector('.kollens-match')&&!document.querySelector('[data-kollens-social-match]'));checks++;
  await command({kind:'preferences',preferences:{...state.preferences,highlights:true}});await gmgn.locator('.kollens-match').first().waitFor();checks++;
  await command({kind:'preferences',preferences:{...state.preferences,highlights:true,matchTypes:[]}});await gmgn.waitForFunction(()=>!document.querySelector('.kollens-match'));await until(s=>s.page?.groups.length===0);await command({kind:'preferences',preferences:{...state.preferences,highlights:true}});await gmgn.locator('.kollens-match').first().waitFor();checks++;
  // Duplicate injection replaces the old instance instead of adding observers.
  const tabId=await worker.evaluate(async()=>{const tabs=await chrome.tabs.query({url:'https://gmgn.ai/*'});return tabs.find(t=>t.url?.includes('chain=bsc')).id;});
  await worker.evaluate(tabId=>chrome.scripting.executeScript({target:{tabId},files:['content.js']}),tabId);state=await until(s=>s.page?.cards.length===23);assert.equal(await gmgn.locator('style[data-kollens-decoration]').count(),1);checks++;
  await gmgn.reload();await gmgn.locator('.kollens-match').first().waitFor();state=await until(s=>s.page?.cards.length===23);assert.equal(state.liveEnabled,true);checks++;
  const second=await context.newPage();await second.goto('https://gmgn.ai/?chain=sol');await second.waitForTimeout(250);assert.equal(await second.locator('.kollens-match').count(),0);await second.evaluate(()=>history.pushState({},'','/?chain=bsc'));await second.locator('.kollens-match').first().waitFor();checks++;const secondId=await worker.evaluate(async()=>{const tabs=await chrome.tabs.query({active:true,currentWindow:true});return tabs[0].id;});
  await second.bringToFront();let secondState;for(let i=0;i<60;i++){secondState=await command({kind:'state'});if(secondState.page?.cards.length===23)break;await second.waitForTimeout(50);}assert.equal(secondState.page?.cards.length,23);assert.notEqual(secondId,tabId);assert.notEqual(secondState.page.pageId,state.page.pageId);checks++;
  await second.evaluate(()=>{const board=document.querySelector('[data-testid^="trenches"]'),card=board.querySelector('[data-testid="trench-token-card"]').cloneNode(true);card.setAttribute('data-trenches-token-address','0x'+'b'.repeat(40));card.setAttribute('href','/bsc/token/0x'+'b'.repeat(40));board.append(card);});await second.waitForTimeout(120);await gmgn.bringToFront();assert.equal((await snapshot()).page.cards.length,23);checks++;
  await second.close();await gmgn.bringToFront();
  await gmgn.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));assert.equal(await gmgn.locator('.kollens-match').count(),0);await gmgn.evaluate(()=>dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));await gmgn.locator('.kollens-match').first().waitFor();state=await until(s=>s.page?.cards.length===23);assert.equal(state.page.alerts.length,0);checks++;
  // Recreate the service worker to prove its saved opt-in rehydrates.
  const cdp=await context.newCDPSession(gmgn);await cdp.send('ServiceWorker.enable');let versions=[];cdp.on('ServiceWorker.workerVersionUpdated',event=>{versions=event.versions;});await cdp.send('ServiceWorker.enable');
  await gmgn.waitForTimeout(150);const version=versions.find(v=>v.scriptURL?.includes(id));
  assert.ok(version,'Expected an actual extension worker restart');await cdp.send('ServiceWorker.stopWorker',{versionId:version.versionId});await command({kind:'state'});worker=context.serviceWorkers().find(w=>!w.isClosed?.())??worker;
  state=await until(s=>s.liveEnabled&&s.page?.cards.length===23);checks++;
  await gmgn.evaluate(()=>{const board=document.querySelector('[data-testid^="trenches"]'),source=board.querySelector('[data-testid="trench-token-card"]');for(let i=0;i<207;i++)board.append(source.cloneNode(true));});state=await until(s=>s.page?.cards.length===230);
  for(let i=0;i<20;i++){await gmgn.locator('[data-testid="trench-token-card"]').first().evaluate((el,i)=>{let a=el.querySelector('a');if(!a){a=document.createElement('a');a.textContent='X';el.querySelector('.g-social').append(a);}a.setAttribute('href',`https://x.com/i/status/21170534897551404${i%2?'01':'02'}`);},i);await gmgn.waitForTimeout(75);}
  state=await snapshot();const durations=state.page.durations.slice(-20).sort((a,b)=>a-b),p95=durations[Math.ceil(durations.length*.95)-1]+40;assert.ok(p95<250);checks++;
  await gmgn.screenshot({path:resolve(artifacts,'gmgn-local-live.png')});
  assert.equal(await panel.locator('.page-context').count(),0);
  assert.equal(await panel.getByRole('button',{name:'Pause',exact:true}).count(),0);
  assert.equal((await snapshot()).liveEnabled,true);checks++;
  assert.deepEqual(errors,[]);checks++;
  const report={ok:true,checks,capturedCards:23,scaleCards:230,p95HighlightMs:p95,automaticNewCards:true,reloadAndNewTabs:true,matchingSettings:true,noPopupStatusRow:true,tradingControls:true,serviceWorkerRestart:!!version,gmgnNetworkRequests:0,realAccountsUsed:0,source:'captured GMGN DOM replayed in isolated Chrome extension QA',sizeBefore,errors};
  await writeFile(resolve(artifacts,'gmgn-live-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await context.close();}
