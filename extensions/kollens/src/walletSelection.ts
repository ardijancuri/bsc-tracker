import {browserApi} from './platform';
import {listLocalWallets, updateLocalWallet, type LocalWallet} from './walletVault';

export const walletSelectionKey = 'wallets:selected-addresses';

type SelectionChange = {address:string; selected:boolean};

async function reconcileSelection(change?:SelectionChange) {
  const wallets = await listLocalWallets();
  const stored:unknown = (await browserApi.storage.local.get(walletSelectionKey))[walletSelectionKey];
  const activeAddresses = new Set(wallets.filter(wallet=>!wallet.archived).map(wallet=>wallet.address.toLowerCase()));
  const previous = Array.isArray(stored) ? stored : [];
  const selectedAddresses = new Set<string>();
  for (const value of previous) {
    if (typeof value !== 'string') continue;
    const address = value.toLowerCase();
    if (activeAddresses.has(address)) selectedAddresses.add(address);
  }
  if (change) {
    const address = change.address.toLowerCase();
    if (change.selected && activeAddresses.has(address)) selectedAddresses.add(address);
    else selectedAddresses.delete(address);
  }
  const next = [...selectedAddresses];
  if ((stored !== undefined && !Array.isArray(stored)) || next.length !== previous.length || next.some((address,index)=>address!==previous[index])) {
    await browserApi.storage.local.set({[walletSelectionKey]:next});
  }
  return {wallets,selectedAddresses};
}

export function readWalletSelection() {
  return navigator.locks.request(walletSelectionKey,()=>reconcileSelection());
}

export async function listSelectedWallets():Promise<LocalWallet[]> {
  const {wallets,selectedAddresses} = await readWalletSelection();
  return wallets.filter(wallet=>!wallet.archived && selectedAddresses.has(wallet.address.toLowerCase()));
}

export function setWalletSelected(address:string,selected:boolean) {
  return navigator.locks.request(walletSelectionKey,()=>reconcileSelection({address,selected}));
}

export function setWalletArchived(address:string,archived:boolean) {
  return navigator.locks.request(walletSelectionKey,async()=>{
    const wallet = await updateLocalWallet(address,{archived});
    await reconcileSelection({address,selected:false});
    return wallet;
  });
}
