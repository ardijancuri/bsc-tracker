import {isBscTrenches} from './adapter';
export const gmgnOrigins=['https://gmgn.ai/*','https://www.gmgn.ai/*'];
const registrationId='kollens-gmgn-local-live';

/** Browser opt-in is independent of accounts and GMGN's authorization response. */
export class LiveGmgnAccess {
  enabled=false;
  private operations=Promise.resolve();
  constructor(private api:typeof chrome,private localBuild:boolean){}
  async restore(){
    const stored=await this.api.storage.local.get('gmgnLiveEnabled');
    this.enabled=this.localBuild&&stored.gmgnLiveEnabled===true&&await this.api.permissions.contains({origins:gmgnOrigins});
    await this.registration();
    if(this.enabled){
      // Registration applies to future loads. An already open tab may still
      // hold an invalidated context after the extension was reloaded.
      const tabs=await this.api.tabs.query({url:gmgnOrigins});
      await Promise.all(tabs.map(async tab=>{
        if(tab.id==null||!isBscTrenches(tab.url??''))return;
        const active=await this.api.tabs.sendMessage(tab.id,{kind:'request-page'}).catch(()=>null);
        if(active?.ok!==true)await this.api.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},world:'ISOLATED',files:['content.js']}).catch(()=>{});
      }));
    }
  }
  private async registration(){
    const existing=await this.api.scripting.getRegisteredContentScripts({ids:[registrationId]});
    if(!this.enabled){if(existing.length)await this.api.scripting.unregisterContentScripts({ids:[registrationId]});return;}
    if(!existing.length)await this.api.scripting.registerContentScripts([{id:registrationId,matches:gmgnOrigins,js:['content.js'],runAt:'document_idle',world:'ISOLATED',persistAcrossSessions:true}]);
  }
  setEnabled(wanted:boolean){
    const next=this.operations.then(async()=>{
      if(wanted&&(!this.localBuild||!await this.api.permissions.contains({origins:gmgnOrigins})))throw Error('Allow GMGN site access first');
      this.enabled=wanted&&this.localBuild;
      try{await this.registration();await this.api.storage.local.set({gmgnLiveEnabled:this.enabled});}
      catch(error){this.enabled=false;await this.api.storage.local.set({gmgnLiveEnabled:false});await this.registration().catch(()=>{});throw error;}
      // tabs permission is not requested. IDs suffice to stop our own isolated script.
      const tabs=await this.api.tabs.query(this.enabled?{url:gmgnOrigins}:{});
      await Promise.all(tabs.map(async tab=>{
        if(tab.id==null)return;
        if(this.enabled){if(isBscTrenches(tab.url??''))await this.api.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},world:'ISOLATED',files:['content.js']}).catch(()=>{});}
        else await this.api.tabs.sendMessage(tab.id,{kind:'stop-gmgn'}).catch(()=>{});
      }));
    });
    this.operations=next.catch(()=>{});return next;
  }
}
