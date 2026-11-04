import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const origin='http://127.0.0.1:3360',artifacts=resolve(root,'../../.cache/extension/qa');await mkdir(artifacts,{recursive:true});
const browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1510,height:1040}});
const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
const panel=()=>page.frameLocator('#panel');
let checks=0;
async function snapshot(){return page.evaluate(()=>window.__fixturePage);}
async function wait(){await page.waitForFunction(()=>window.__fixturePage?.cards.length>0);await panel().getByRole('button',{name:/Same X post/}).first().waitFor();}
async function connect(target,account='A'){
 const frame=target.frameLocator('#panel');await frame.getByRole('button',{name:/^Saved/}).click();
 const popupPromise=target.waitForEvent('popup');await frame.getByRole('button',{name:'Connect Kollens',exact:true}).click();const popup=await popupPromise;await popup.waitForLoadState();
 await popup.getByRole('button',{name:`Use test account ${account}`,exact:true}).click();await popup.getByRole('button',{name:'Connect this extension',exact:true}).click();
 await popup.getByText('Connected. Return to the extension.').waitFor();await popup.close();await frame.getByRole('button',{name:'Profile',exact:true}).click();await frame.getByRole('button',{name:'Disconnect',exact:true}).waitFor();await frame.getByRole('button',{name:'Tokens',exact:true}).click();
}
try{
 await page.goto(origin+'/fixture');await wait();
 assert.equal((await snapshot()).cards.length,9);assert.equal((await snapshot()).groups.length,4);assert.equal((await snapshot()).alerts.length,0);checks++;
 await page.getByRole('button',{name:'Add matching token',exact:true}).click();await page.waitForFunction(()=>window.__fixturePage.cards.length===10);assert.equal((await snapshot()).groups.find(g=>g.type==='x_post').addresses.length,4);assert.equal((await snapshot()).alerts.length,2);checks++;
 const before=(await snapshot()).alerts.length;await page.getByRole('button',{name:'Reverse card order'}).click();await page.waitForTimeout(180);assert.equal((await snapshot()).alerts.length,before);checks++;
 await page.getByRole('button',{name:'Test trade button',exact:true}).first().click();assert.equal(await page.locator('[data-trade-clicks]').textContent(),'1');checks++;
 await page.getByRole('button',{name:'Switch chain'}).click();await page.waitForTimeout(180);assert.equal(await page.locator('.kollens-match').count(),0);checks++;
 await page.getByRole('button',{name:'Switch chain'}).click();await page.waitForFunction(()=>window.__fixturePage.status==='ready');assert.equal((await snapshot()).alerts.length,0);checks++;
 const count=(await snapshot()).cards.length;
 await page.locator('[data-token-card]').first().evaluate(element=>element.hidden=true);await page.waitForFunction(n=>window.__fixturePage.cards.length===n-1,count);checks++;
 await page.locator('[data-token-card]').first().evaluate(element=>element.hidden=false);await page.waitForFunction(n=>window.__fixturePage.cards.length===n,count);checks++;
 const groupCount=(await snapshot()).groups.find(g=>g.type==='x_post').addresses.length;
 await page.locator('[data-token-card]').first().evaluate(element=>{const clone=element.cloneNode(true);clone.setAttribute('data-clone','');element.parentElement.append(clone);});await page.waitForFunction(n=>window.__fixturePage.cards.length===n+1,count);
 assert.equal((await snapshot()).groups.find(g=>g.type==='x_post').addresses.length,groupCount);await page.locator('[data-clone]').evaluate(element=>element.remove());checks++;
 await panel().getByRole('button',{name:'Settings',exact:true}).click();await panel().getByLabel('Highlight matching cards').uncheck();await page.waitForTimeout(2500);assert.equal(await page.locator('.kollens-match').count(),0);checks++;
 await panel().getByLabel('Highlight matching cards').check();await page.waitForTimeout(2500);assert.ok(await page.locator('.kollens-match').count()>0);await panel().getByRole('button',{name:'Tokens',exact:true}).click();checks++;
 const old=await page.locator('[data-token-card]').first().getAttribute('data-token-address');await page.getByRole('button',{name:'Recycle a card'}).click();await page.waitForTimeout(200);assert.ok(!(await snapshot()).cards.some(c=>c.address===old));checks++;
 await connect(page);await panel().getByRole('button',{name:/^Matches/}).click();await panel().getByRole('button',{name:/Save /}).first().click();await panel().getByRole('button',{name:/^Saved/}).click();await panel().getByRole('button',{name:'Edit note',exact:true}).first().click();
 const originalNote=await panel().getByRole('textbox').inputValue(),note='PRIVATE NOTE · local browser QA '+Date.now();await panel().getByRole('textbox').fill(note);await panel().getByRole('button',{name:'Save note',exact:true}).click();await panel().getByText(note,{exact:true}).waitFor();assert.ok(!(await page.locator('[data-kollens-trenches]').textContent()).includes(note));checks++;
 const secondContext=await browser.newContext({viewport:{width:1510,height:1040}}),second=await secondContext.newPage();await second.goto(origin+'/fixture');await second.waitForFunction(()=>window.__fixturePage?.cards.length===9);await connect(second);
 const secondPanel=second.frameLocator('#panel');await secondPanel.getByText(note,{exact:true}).waitFor();checks++;
 await secondPanel.getByRole('button',{name:'Edit note',exact:true}).first().click();await secondPanel.getByRole('textbox').fill('Conflicting local draft');
 await panel().getByRole('button',{name:'Edit note',exact:true}).first().click();await panel().getByRole('textbox').fill('Server edit from first browser');await panel().getByRole('button',{name:'Save note',exact:true}).click();await panel().getByText('Server edit from first browser',{exact:true}).waitFor();
 await secondPanel.getByRole('button',{name:'Save note',exact:true}).click();await secondPanel.getByText('Note needs review',{exact:true}).waitFor();await secondPanel.getByText('Conflicting local draft',{exact:true}).waitFor();checks++;
 await secondPanel.getByRole('button',{name:'Keep my draft',exact:true}).click();await second.waitForTimeout(2400);assert.equal(await secondPanel.getByText('Note needs review',{exact:true}).count(),0);await secondPanel.getByRole('button',{name:'Edit note',exact:true}).first().click();await secondPanel.getByRole('textbox').fill(originalNote);await secondPanel.getByRole('button',{name:'Save note',exact:true}).click();await secondPanel.getByText('Conflicting local draft',{exact:true}).waitFor({state:'detached'});checks++;
 await secondContext.close();
 await panel().getByRole('button',{name:/^Matches/}).click();await page.getByRole('button',{name:'Add 200 cards'}).click();await page.waitForFunction(()=>window.__fixturePage.cards.length>=200);
 for(let i=0;i<20;i++){await page.getByRole('button',{name:'Add matching token',exact:true}).click();await page.waitForTimeout(70);}
 const result=await snapshot(),durations=result.durations.slice(-20).sort((a,b)=>a-b),p95=durations[Math.ceil(durations.length*.95)-1];assert.ok(p95+40<250,`Highlight p95 ${p95+40}ms`);checks++;
 await page.screenshot({path:resolve(artifacts,'fixture-desktop.png'),fullPage:false});
 assert.deepEqual(errors,[]);checks++;
 const report={ok:true,checks,renderedCards:result.cards.length,processingP95Ms:p95,debounceMs:40,highlightP95UpperBoundMs:p95+40,errors,screenshot:resolve(artifacts,'fixture-desktop.png'),gmgnVerified:false};
 await writeFile(resolve(artifacts,'browser-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
