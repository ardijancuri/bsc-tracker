import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {listLocalWallets, updateLocalWallet, type LocalWallet} from './walletVault';
import {listSelectedWallets, setWalletArchived, setWalletSelected, walletSelectionKey} from './walletSelection';

const storage = vi.hoisted(()=>new Map<string,unknown>());
vi.mock('./platform',()=>({browserApi:{storage:{local:{
  get:async (key:string)=>({[key]:storage.get(key)}),
  set:async (values:Record<string,unknown>)=>{
    for (const [key,value] of Object.entries(values)) storage.set(key,value);
  },
}}}}));
vi.mock('./walletVault',()=>({listLocalWallets:vi.fn(),updateLocalWallet:vi.fn()}));

const first = '0x'+'a'.repeat(40);
const second = '0x'+'b'.repeat(40);

describe('local vault wallet selection',()=>{
  let wallets:LocalWallet[];

  beforeEach(()=>{
    storage.clear();
    wallets = [first,second].map(address=>({address,alias:'',archived:false,createdAt:1,protection:'device'}));
    vi.mocked(listLocalWallets).mockImplementation(async()=>wallets.map(wallet=>({...wallet})));
    vi.mocked(updateLocalWallet).mockImplementation(async(address,patch)=>{
      const wallet = wallets.find(item=>item.address===address)!;
      Object.assign(wallet,patch);
      return {...wallet};
    });
    let pending = Promise.resolve();
    vi.stubGlobal('navigator',{locks:{request<T>(key:string,action:()=>Promise<T>){
      expect(key).toBe(walletSelectionKey);
      const result = pending.then(action);
      pending = result.then(()=>undefined,()=>undefined);
      return result;
    }}});
  });

  afterEach(()=>vi.unstubAllGlobals());

  it('defaults to no selection and persists independent changes from two surfaces',async()=>{
    expect(await listSelectedWallets()).toEqual([]);
    expect(storage.has(walletSelectionKey)).toBe(false);
    await Promise.all([setWalletSelected(first,true),setWalletSelected(second,true)]);
    expect(storage.get(walletSelectionKey)).toEqual([first,second]);
    await setWalletSelected(first,false);
    expect((await listSelectedWallets()).map(wallet=>wallet.address)).toEqual([second]);
  });

  it('prunes missing, malformed and archived addresses against the vault',async()=>{
    wallets[1].archived = true;
    storage.set(walletSelectionKey,[first.toUpperCase(),first,second,'0x'+'c'.repeat(40),null]);
    expect((await listSelectedWallets()).map(wallet=>wallet.address)).toEqual([first]);
    expect(storage.get(walletSelectionKey)).toEqual([first]);
  });

  it('serializes archive with selection and requires selecting restored wallets again',async()=>{
    await Promise.all([setWalletSelected(first,true),setWalletArchived(first,true),setWalletSelected(first,true)]);
    expect(await listSelectedWallets()).toEqual([]);
    expect(storage.get(walletSelectionKey)).toEqual([]);
    storage.set(walletSelectionKey,[first]);
    await setWalletArchived(first,false);
    expect(await listSelectedWallets()).toEqual([]);
    expect(storage.get(walletSelectionKey)).toEqual([]);
  });

  it('retains the stored selection when the vault is temporarily unavailable',async()=>{
    storage.set(walletSelectionKey,[first]);
    vi.mocked(listLocalWallets).mockRejectedValueOnce(new Error('Vault unavailable'));
    await expect(listSelectedWallets()).rejects.toThrow('Vault unavailable');
    expect(storage.get(walletSelectionKey)).toEqual([first]);
  });
});
