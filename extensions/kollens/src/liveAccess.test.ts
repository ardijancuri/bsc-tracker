import {describe,it,expect,vi} from 'vitest';
import {LiveGmgnAccess,gmgnOrigins} from './liveAccess';
function setup({allowed=true,stored=false,local=true}={}){
  const memory=new Map<string,unknown>([['gmgnLiveEnabled',stored]]);let registered:any[]=[];
  const api:any={storage:{local:{get:vi.fn(async(key:string)=>({[key]:memory.get(key)})),set:vi.fn(async(value:any)=>{for(const [k,v]of Object.entries(value))memory.set(k,v);})}},
    permissions:{contains:vi.fn(async()=>allowed)},scripting:{getRegisteredContentScripts:vi.fn(async()=>registered),registerContentScripts:vi.fn(async(scripts:any[])=>{registered=scripts;}),unregisterContentScripts:vi.fn(async()=>{registered=[];}),executeScript:vi.fn(async()=>[])},
    tabs:{query:vi.fn(async()=>[{id:1,url:'https://gmgn.ai/?chain=bsc'},{id:2,url:'https://gmgn.ai/?chain=sol'},{id:3,url:'https://elsewhere.example/'}]),sendMessage:vi.fn(async()=>({ok:true}))}};
  return{api,memory,access:new LiveGmgnAccess(api,local)};
}
describe('local GMGN live access',()=>{
  it('starts disabled and never requests permission itself',async()=>{const {access,api}=setup();await access.restore();expect(access.enabled).toBe(false);expect(api.scripting.registerContentScripts).not.toHaveBeenCalled();});
  it('requires the explicit browser grant',async()=>{const {access,api}=setup({allowed:false});await expect(access.setEnabled(true)).rejects.toThrow('Allow GMGN');expect(api.scripting.executeScript).not.toHaveBeenCalled();});
  it('rejects live activation from the nonlocal build',async()=>{const {access,api}=setup({local:false});await expect(access.setEnabled(true)).rejects.toThrow();expect(api.scripting.registerContentScripts).not.toHaveBeenCalled();});
  it('registers narrowly and injects existing BSC trenches only',async()=>{const {access,api,memory}=setup();await access.setEnabled(true);expect(access.enabled).toBe(true);expect(memory.get('gmgnLiveEnabled')).toBe(true);expect(api.scripting.registerContentScripts).toHaveBeenCalledWith([expect.objectContaining({matches:gmgnOrigins,world:'ISOLATED',persistAcrossSessions:true})]);expect(api.scripting.executeScript).toHaveBeenCalledTimes(1);expect(api.scripting.executeScript.mock.calls[0][0].target.tabId).toBe(1);});
  it('restores after worker suspension without replacing a responsive content script',async()=>{const {access,api}=setup({stored:true});await access.restore();expect(access.enabled).toBe(true);expect(api.scripting.registerContentScripts).toHaveBeenCalledOnce();expect(api.tabs.sendMessage).toHaveBeenCalledExactlyOnceWith(1,{kind:'request-page'});expect(api.scripting.executeScript).not.toHaveBeenCalled();});
  it('restores highlighting in an existing tab after the old extension context is gone',async()=>{const {access,api}=setup({stored:true});api.tabs.sendMessage.mockRejectedValueOnce(new Error('No receiving end'));await access.restore();expect(access.enabled).toBe(true);expect(api.scripting.executeScript).toHaveBeenCalledExactlyOnceWith({target:{tabId:1,frameIds:[0]},world:'ISOLATED',files:['content.js']});});
  it('does not restore when site access was revoked',async()=>{const {access}=setup({stored:true,allowed:false});await access.restore();expect(access.enabled).toBe(false);});
  it('serializes pause behind enable and removes the registration',async()=>{const {access,api,memory}=setup();await Promise.all([access.setEnabled(true),access.setEnabled(false)]);expect(access.enabled).toBe(false);expect(memory.get('gmgnLiveEnabled')).toBe(false);expect(api.scripting.unregisterContentScripts).toHaveBeenCalledOnce();expect(api.tabs.sendMessage).toHaveBeenCalledWith(1,{kind:'stop-gmgn'});});
  it('fails closed after registration errors',async()=>{const {access,api,memory}=setup();api.scripting.registerContentScripts.mockRejectedValueOnce(new Error('test registration failure'));await expect(access.setEnabled(true)).rejects.toThrow();expect(access.enabled).toBe(false);expect(memory.get('gmgnLiveEnabled')).toBe(false);});
});
