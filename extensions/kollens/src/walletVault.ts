import { computeAddress, getAddress, getBytes, HDNodeWallet, hexlify, Wallet } from 'ethers';

export interface LocalWallet {
  address: string;
  createdAt: number;
}

interface EncryptedWallet extends LocalWallet {
  version: 1;
  salt: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
}

export const minimumWalletPasswordLength = 12;
const maximumWalletPasswordLength = 1024;
const databaseName = 'kollens-wallet-vault';
const walletStore = 'wallets';
const defaultEvmPath = "m/44'/60'/0'/0/0";

function requireExtensionWindow() {
  const {protocol, hostname, pathname} = globalThis.location ?? {};
  if (protocol !== 'chrome-extension:' || hostname !== globalThis.chrome?.runtime?.id ||
      (pathname !== '/popup.html' && pathname !== '/panel.html') || window.top !== window) {
    throw new Error('Open the Kollens extension to manage wallets.');
  }
}

function validatePassword(password: string) {
  if (password.length < minimumWalletPasswordLength || password.length > maximumWalletPasswordLength) {
    throw new Error(`Use a wallet password between ${minimumWalletPasswordLength} and ${maximumWalletPasswordLength} characters.`);
  }
}

async function openVault(): Promise<IDBDatabase> {
  requireExtensionWindow();
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(walletStore, {keyPath: 'address'});
    request.onerror = () => reject(new Error('Could not open the wallet vault.'));
    request.onsuccess = () => resolve(request.result);
  });
}

async function readVault<T>(read: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openVault();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = read(database.transaction(walletStore).objectStore(walletStore));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Could not read the wallet vault.'));
    });
  } finally {
    database.close();
  }
}

function publicWallet({address, createdAt}: LocalWallet): LocalWallet {
  return {address, createdAt};
}

export async function listLocalWallets(): Promise<LocalWallet[]> {
  const records = await readVault<EncryptedWallet[]>(store => store.getAll());
  return records.map(publicWallet).sort((a, b) => b.createdAt - a.createdAt);
}

async function passwordKey(password: string, salt: Uint8Array<ArrayBuffer>) {
  const bytes = new TextEncoder().encode(password);
  try {
    const material = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      {name: 'PBKDF2', hash: 'SHA-256', iterations: 600_000, salt},
      material,
      {name: 'AES-GCM', length: 256},
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    bytes.fill(0);
  }
}

function cipherParams(wallet: Omit<EncryptedWallet, 'ciphertext'>): AesGcmParams {
  return {
    name: 'AES-GCM',
    iv: wallet.iv,
    additionalData: new TextEncoder().encode(`kollens-wallet:${wallet.version}:${wallet.address}:${wallet.createdAt}`),
  };
}

async function storeWallet(privateKey: string, password: string): Promise<LocalWallet> {
  const wallet = {
    version: 1 as const,
    address: computeAddress(privateKey),
    createdAt: Date.now(),
    salt: crypto.getRandomValues(new Uint8Array(32)),
    iv: crypto.getRandomValues(new Uint8Array(12)),
  };
  const key = await passwordKey(password, wallet.salt);
  const bytes = new Uint8Array(getBytes(privateKey));
  let ciphertext: ArrayBuffer;
  try {
    ciphertext = await crypto.subtle.encrypt(cipherParams(wallet), key, bytes);
  } finally {
    bytes.fill(0);
  }

  const database = await openVault();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(walletStore, 'readwrite', {durability: 'strict'});
      const request = transaction.objectStore(walletStore).add({...wallet, ciphertext} satisfies EncryptedWallet);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(new Error(
        request.error?.name === 'ConstraintError' ? 'This wallet is already saved.' : 'Could not save the wallet.',
      ));
    });
  } finally {
    database.close();
  }
  return publicWallet(wallet);
}

export async function createLocalWallet(password: string): Promise<LocalWallet> {
  requireExtensionWindow();
  validatePassword(password);
  return storeWallet(Wallet.createRandom().privateKey, password);
}

export async function importLocalWallet(secret: string, password: string): Promise<LocalWallet> {
  requireExtensionWindow();
  validatePassword(password);
  if (secret.length > 512) throw new Error('Enter a valid private key or recovery phrase.');
  const input = secret.trim();
  let privateKey: string;
  try {
    if (/^(?:0x)?[\da-f]{64}$/i.test(input)) {
      privateKey = `0x${input.replace(/^0x/i, '').toLowerCase()}`;
    } else {
      privateKey = HDNodeWallet.fromPhrase(input.replace(/\s+/g, ' '), '', defaultEvmPath).privateKey;
    }
    computeAddress(privateKey);
  } catch {
    // Library validation errors may contain the supplied input.
    throw new Error('Enter a valid private key or recovery phrase.');
  }
  return storeWallet(privateKey, password);
}

export async function exportLocalWallet(address: string, password: string): Promise<string> {
  requireExtensionWindow();
  validatePassword(password);
  const record = await readVault<EncryptedWallet | undefined>(store => store.get(getAddress(address)));
  if (!record || record.version !== 1) throw new Error('Could not find this wallet.');
  const key = await passwordKey(password, record.salt);
  let bytes: Uint8Array | undefined;
  try {
    bytes = new Uint8Array(await crypto.subtle.decrypt(cipherParams(record), key, record.ciphertext));
    const privateKey = hexlify(bytes);
    if (computeAddress(privateKey) !== record.address) throw new Error();
    return privateKey;
  } catch {
    throw new Error('Could not unlock this wallet. Check your wallet password.');
  } finally {
    bytes?.fill(0);
  }
}
