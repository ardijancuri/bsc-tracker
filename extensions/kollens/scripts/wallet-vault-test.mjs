import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionSource = fileURLToPath(new URL('../src/walletVault.ts', import.meta.url));
const cache = fileURLToPath(new URL('../../../.cache/extension/', import.meta.url));
await mkdir(cache, { recursive: true });
const root = await mkdtemp(join(cache, 'wallet-vault-'));
const extension = join(root, 'extension');
const launch = () => chromium.launchPersistentContext(join(root, 'chrome'), {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
await mkdir(extension);
let browser;
try {
  await writeFile(join(extension, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Kollens wallet vault test',
    version: '1.0',
    background: {service_worker: 'worker.js'},
    action: {default_popup: 'popup.html'},
  }));
  await Promise.all(['popup.html', 'blocked.html'].map(name =>
    writeFile(join(extension, name), '<!doctype html><title>Kollens wallet vault test</title>')));
  await writeFile(join(extension, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  await build({entryPoints: [extensionSource], bundle: true, format: 'esm', platform: 'browser', outfile: join(extension, 'vault.js')});
  browser = await launch();
  await browser.route(/^https?:/, route => route.abort());
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
  const origin = `chrome-extension://${new URL(worker.url()).hostname}`;
  const page = await browser.newPage();
  await page.goto(origin + '/blocked.html');
  await assert.rejects(page.evaluate(async () => (await import('./vault.js')).listLocalWallets()), /Open the Kollens extension/);
  await page.goto(origin + '/popup.html');
  const result = await page.evaluate(async () => {
    const vault = await import('./vault.js');
    const password = 'Kollens testing only 2026';
    const shortPassword = 'Vault-82';
    const privateKey = '0x' + '0'.repeat(63) + '1';
    const tooShort = await vault.importLocalWallet(privateKey, 'Vault-8').catch(error => error.message);
    const imported = await vault.importLocalWallet(privateKey, shortPassword);
    const importedPhrase = await vault.importLocalWallet(
      'test test test test test test test test test test test junk', password,
    );
    const created = await vault.createLocalWallet();
    const duplicate = await vault.importLocalWallet(privateKey, 'different password').catch(error => error.message);
    const wrongPassword = await vault.exportLocalWallet(imported.address, 'different password').catch(error => error.message);
    const missingPassword = await vault.exportLocalWallet(imported.address).catch(error => error.message);
    const exported = await vault.exportLocalWallet(imported.address, shortPassword);
    const createdExport = await vault.exportLocalWallet(created.address);
    const phraseExport = await vault.exportLocalWallet(importedPhrase.address, password);
    await Promise.all([
      vault.updateLocalWallet(created.address, {alias: '  Trading  '}),
      vault.updateLocalWallet(created.address, {archived: true}),
    ]);
    const archived = (await vault.listLocalWallets()).find(wallet => wallet.address === created.address);
    const archivedExport = await vault.exportLocalWallet(created.address);
    const deviceRecord = await new Promise(resolve => {
      const request = indexedDB.open('kollens-wallet-vault');
      request.onsuccess = () => {
        const database = request.result;
        const get = database.transaction('wallets').objectStore('wallets').get(created.address);
        get.onsuccess = () => {
          database.close();
          resolve(get.result);
        };
      };
    });
    const rawDeviceKey = Array.from(createdExport.slice(2).match(/../g), hex => parseInt(hex, 16));
    const deviceCiphertext = new Uint8Array(deviceRecord.ciphertext);
    const deviceEncryption = {
      version: deviceRecord.version,
      extractable: deviceRecord.deviceKey.extractable,
      canExportEncryptionKey: await crypto.subtle.exportKey('raw', deviceRecord.deviceKey).then(() => true, () => false),
      byteLength: deviceCiphertext.length,
      containsCleartext: deviceCiphertext.some((_, offset) =>
        rawDeviceKey.every((byte, index) => deviceCiphertext[offset + index] === byte)),
    };
    const privateKeyRecord = await new Promise(resolve => {
      const request = indexedDB.open('kollens-wallet-vault');
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('wallets', 'readwrite');
        const get = transaction.objectStore('wallets').get(imported.address);
        get.onsuccess = () => {
          const record = get.result;
          const bytes = new Uint8Array(record.ciphertext);
          const rawPrivateKey = Array(31).fill(0).concat(1);
          const original = {
            fields: Object.keys(record).sort(),
            byteLength: bytes.length,
            containsCleartext: bytes.some((_, offset) =>
              rawPrivateKey.every((byte, index) => bytes[offset + index] === byte)),
          };
          bytes[0] ^= 1;
          transaction.objectStore('wallets').put(record);
          transaction.oncomplete = () => {database.close(); resolve(original);};
        };
      };
    });
    const tampered = await vault.exportLocalWallet(imported.address, shortPassword).catch(error => error.message);
    const currentWallets = await vault.listLocalWallets();
    return {
      imported, importedPhrase, created, duplicate, wrongPassword, missingPassword, privateKeyRecord, tampered, tooShort,
      archived, deviceEncryption,
      roundTrips: exported === privateKey && [createdExport, phraseExport].every(key => /^0x[a-f\d]{64}$/.test(key))
        && new Set([exported, createdExport, phraseExport]).size === 3 && archivedExport === createdExport,
      count: currentWallets.length,
    };
  });
  assert.equal(result.imported.address, '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
  assert.equal(result.imported.protection, 'password');
  assert.equal(result.importedPhrase.address, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  assert.equal(result.count, 3);
  assert.equal(result.roundTrips, true);
  assert.match(result.tooShort, /between 8 and 1024 characters/);
  assert.match(result.missingPassword, /between 8 and 1024 characters/);
  assert.match(result.duplicate, /already saved/);
  assert.match(result.wrongPassword, /Could not unlock/);
  assert.match(result.tampered, /Could not unlock/);
  assert.deepEqual(result.privateKeyRecord, {
    fields: ['address', 'ciphertext', 'createdAt', 'iv', 'salt', 'version'],
    byteLength: 48,
    containsCleartext: false,
  });
  assert.deepEqual(result.created, {
    address: result.created.address, createdAt: result.created.createdAt, protection: 'device', alias: '', archived: false,
  });
  assert.deepEqual(result.archived, {...result.created, alias: 'Trading', archived: true});
  assert.deepEqual(result.deviceEncryption, {
    version: 2, extractable: false, canExportEncryptionKey: false, byteLength: 48, containsCleartext: false,
  });
  await browser.close();
  browser = await launch();
  await browser.route(/^https?:/, route => route.abort());
  const reopened = await browser.newPage();
  await reopened.goto(origin + '/popup.html');
  const restored = await reopened.evaluate(async (address) => {
    const vault = await import('./vault.js');
    const wallets = await vault.listLocalWallets();
    const archived = wallets.find(wallet => wallet.address === address);
    const canUnlock = /^0x[a-f\d]{64}$/.test(await vault.exportLocalWallet(address));
    const restored = await vault.updateLocalWallet(address, {archived: false});
    return {count: wallets.length, archived, restored, canUnlock};
  }, result.created.address);
  assert.equal(restored.count, 3);
  assert.deepEqual(restored.archived, result.archived);
  assert.equal(restored.canUnlock, true);
  assert.deepEqual(restored.restored, {...result.archived, archived: false});
  console.log('Wallet vault verified in isolated Chromium: password-free creation, both password-protected imports, encryption, restart persistence, archive and restore, password and tamper rejection, popup isolation.');
} finally {
  await browser?.close();
  const verifiedCache = await realpath(cache);
  const verifiedRoot = await realpath(root);
  assert.match(relative(verifiedCache, verifiedRoot), /^wallet-vault-[A-Za-z\d]+$/);
  await rm(verifiedRoot, {recursive: true});
}
