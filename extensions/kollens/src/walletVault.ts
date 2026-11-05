import { computeAddress, getAddress, getBytes, HDNodeWallet, hexlify, Wallet } from 'ethers';

export interface LocalWallet {
  address: string;
  createdAt: number;
  protection: 'device' | 'password';
  alias: string;
  archived: boolean;
}

interface WalletRecord {
  address: string;
  createdAt: number;
  alias?: string;
  archived?: boolean;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
}

type WalletProtection =
  | {version: 1; salt: Uint8Array<ArrayBuffer>}
  | {version: 2; deviceKey: CryptoKey};
type EncryptedWallet = WalletRecord & WalletProtection;

export const minimumWalletPasswordLength = 8;
export const maximumWalletAliasLength = 32;
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

function validatePassword(password: string | undefined): asserts password is string {
  if (password === undefined || password.length < minimumWalletPasswordLength || password.length > maximumWalletPasswordLength) {
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

function publicWallet({address, createdAt, version, alias = '', archived = false}: EncryptedWallet): LocalWallet {
  return {address, createdAt, protection: version === 2 ? 'device' : 'password', alias, archived};
}

export async function listLocalWallets(): Promise<LocalWallet[]> {
  const records = await readVault<EncryptedWallet[]>(store => store.getAll());
  return records.map(publicWallet).sort((a, b) => b.createdAt - a.createdAt);
}

export async function updateLocalWallet(address: string, patch: {alias?: string; archived?: boolean}): Promise<LocalWallet> {
  const key = getAddress(address);
  const alias = patch.alias?.trim();
  if (alias !== undefined && alias.length > maximumWalletAliasLength) {
    throw new Error(`Use at most ${maximumWalletAliasLength} characters for the wallet alias.`);
  }
  const database = await openVault();
  try {
    return await new Promise<LocalWallet>((resolve, reject) => {
      const transaction = database.transaction(walletStore, 'readwrite', {durability: 'strict'});
      const store = transaction.objectStore(walletStore);
      const request = store.get(key);
      let updated: EncryptedWallet | undefined;
      request.onsuccess = () => {
        const record: EncryptedWallet | undefined = request.result;
        if (!record) return;
        updated = {...record, alias: alias ?? record.alias, archived: patch.archived ?? record.archived};
        store.put(updated);
      };
      transaction.oncomplete = () => updated
        ? resolve(publicWallet(updated))
        : reject(new Error('Could not find this wallet.'));
      transaction.onabort = () => reject(new Error('Could not update the wallet.'));
    });
  } finally {
    database.close();
  }
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

async function storeWallet(privateKey: string, protection: WalletProtection, key: CryptoKey): Promise<LocalWallet> {
  const wallet = {
    ...protection,
    address: computeAddress(privateKey),
    createdAt: Date.now(),
    iv: crypto.getRandomValues(new Uint8Array(12)),
  };
  const bytes = new Uint8Array(getBytes(privateKey));
  let ciphertext: ArrayBuffer;
  try {
    ciphertext = await crypto.subtle.encrypt(cipherParams(wallet), key, bytes);
  } finally {
    bytes.fill(0);
  }

  const record: EncryptedWallet = {...wallet, ciphertext};
  const database = await openVault();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(walletStore, 'readwrite', {durability: 'strict'});
      const request = transaction.objectStore(walletStore).add(record);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(new Error(
        request.error?.name === 'ConstraintError' ? 'This wallet is already saved.' : 'Could not save the wallet.',
      ));
    });
  } finally {
    database.close();
  }
  return publicWallet(record);
}

export async function createLocalWallet(): Promise<LocalWallet> {
  requireExtensionWindow();
  // IndexedDB atomically stores this non-extractable key with the ciphertext.
  // The extension profile can still use it to unlock the wallet without a password.
  const deviceKey = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
  return storeWallet(Wallet.createRandom().privateKey, {version: 2, deviceKey}, deviceKey);
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
  const salt = crypto.getRandomValues(new Uint8Array(32));
  return storeWallet(privateKey, {version: 1, salt}, await passwordKey(password, salt));
}

export async function exportLocalWallet(address: string, password?: string): Promise<string> {
  requireExtensionWindow();
  const record = await readVault<EncryptedWallet | undefined>(store => store.get(getAddress(address)));
  if (!record || (record.version !== 1 && record.version !== 2)) throw new Error('Could not find this wallet.');
  let bytes: Uint8Array | undefined;
  let key: CryptoKey;
  if (record.version === 1) {
    validatePassword(password);
    key = await passwordKey(password, record.salt);
  } else {
    key = record.deviceKey;
  }
  try {
    bytes = new Uint8Array(await crypto.subtle.decrypt(cipherParams(record), key, record.ciphertext));
    const privateKey = hexlify(bytes);
    if (computeAddress(privateKey) !== record.address) throw new Error();
    return privateKey;
  } catch {
    throw new Error(record.version === 1
      ? 'Could not unlock this wallet. Check your wallet password.'
      : 'Could not unlock this wallet in this Chrome profile.');
  } finally {
    bytes?.fill(0);
  }
}
