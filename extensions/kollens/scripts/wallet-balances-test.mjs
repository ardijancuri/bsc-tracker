import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const rpcUrl = 'https://bsc-dataseed.bnbchain.org';
const extensionRoot = fileURLToPath(new URL('../', import.meta.url));
const cache = fileURLToPath(new URL('../../../.cache/extension/', import.meta.url));
await mkdir(cache, { recursive: true });
const root = await mkdtemp(join(cache, 'wallet-balances-'));
const extension = join(root, 'extension');
const first = '0x' + '1'.repeat(40);
const second = '0x' + '2'.repeat(40);
let browser;
try {
  await mkdir(extension);
  await writeFile(join(extension, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Kollens wallet balances test',
    version: '1.0',
    optional_host_permissions: [`${rpcUrl}/*`],
    content_security_policy: {extension_pages: `script-src 'self'; object-src 'none'; connect-src 'self' ${rpcUrl};`},
    background: {service_worker: 'worker.js'},
    action: {default_popup: 'popup.html'},
  }));
  await writeFile(join(extension, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  await writeFile(join(extension, 'popup.html'), '<!doctype html><div id="root"></div><script src="test.js"></script>');
  await build({
    bundle: true,
    outfile: join(extension, 'test.js'),
    define: {__API_ORIGIN__: '"https://example.test"', __GMGN_LIVE_AVAILABLE__: 'false'},
    stdin: {loader: 'jsx', resolveDir: extensionRoot, contents: `
      import React, {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {formatWalletBalance, useWalletBalances} from './src/useWalletBalances';
      globalThis.permissionRequests = 0;
      chrome.permissions.request = async () => {
        globalThis.permissionRequests++;
        throw new Error('Balance reads should not request host permission');
      };
      function App() {
        const [wallets,setWallets] = useState([{address: '${first}', createdAt: 1}]);
        const {balances,totalBalance,balanceStatus,refreshBalance} = useWalletBalances(wallets);
        return <>
          <output id="status">{balanceStatus}</output>
          <output id="total">{totalBalance === null ? 'unknown' : formatWalletBalance(totalBalance)}</output>
          <output id="balances">{JSON.stringify(wallets.map(wallet => balances.get(wallet.address)?.toString() ?? null))}</output>
          <button onClick={refreshBalance}>Refresh</button>
          <button onClick={() => setWallets([...wallets,{address: '${second}', createdAt: 2}])}>Add</button>
        </>;
      }
      createRoot(document.getElementById('root')).render(<App/>);
    `},
  });
  browser = await chromium.launchPersistentContext(join(root, 'chrome'), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  let failSecond = false;
  const payloads = [];
  await browser.route(/^https?:/, async route => {
    if (route.request().url() !== `${rpcUrl}/`) return route.abort();
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    };
    if (route.request().method() === 'OPTIONS') return route.fulfill({status: 204, headers});
    const body = route.request().postDataJSON();
    payloads.push(body);
    const address = body.params[0];
    const response = address === second && failSecond
      ? {error: {code: -32000, message: 'Test read failure'}}
      : {result: address === first ? '0x0' : '0x' + (1_250_000_000_000_000_000n).toString(16)};
    await route.fulfill({headers, json: {jsonrpc: '2.0', id: 1, ...response}});
  });
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).hostname}/popup.html`);
  const waitStatus = (status) => page.waitForFunction(value => document.querySelector('#status')?.textContent === value, status);
  const read = (selector) => page.locator(selector).textContent();
  await waitStatus('ready');
  assert.equal(await page.evaluate(origin => chrome.permissions.contains({origins: [origin]}), `${rpcUrl}/*`), false);
  assert.equal(payloads.length, 1);
  assert.equal(await read('#total'), '0.00');
  await page.getByRole('button', {name: 'Add'}).click();
  await waitStatus('ready');
  assert.equal(await read('#total'), '1.25');
  assert.equal(await read('#balances'), '["0","1250000000000000000"]');
  failSecond = true;
  await page.getByRole('button', {name: 'Refresh'}).click();
  await waitStatus('partial');
  assert.equal(await read('#total'), 'unknown');
  assert.equal(await read('#balances'), '["0",null]');
  assert.equal(await page.evaluate(() => globalThis.permissionRequests), 0);
  assert.deepEqual(new Set(payloads.map(body => body.params[0])), new Set([first, second]));
  for (const body of payloads) {
    assert.deepEqual(body, {jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [body.params[0], 'latest']});
  }
  console.log('Wallet balances verified in isolated Chromium: automatic read without host permission, confirmed zero, per-wallet values, and partial failure.');
} finally {
  await browser?.close();
  const verifiedCache = await realpath(cache);
  const verifiedRoot = await realpath(root);
  assert.match(relative(verifiedCache, verifiedRoot), /^wallet-balances-[A-Za-z\d]+$/);
  await rm(verifiedRoot, {recursive: true});
}
