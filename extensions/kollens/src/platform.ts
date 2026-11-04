// Permissions deliberately exclude cookie, wallet, all-tabs and interception APIs.
export const browserApi:typeof chrome=(globalThis as unknown as {chrome:typeof chrome}).chrome;
export const isExtension = Boolean(browserApi?.runtime?.id);
let demoPage:unknown=null,demoSelected:string|null=null;
if(!isExtension&&typeof window!=='undefined')window.addEventListener('message',event=>{
  if(event.origin!==location.origin||event.source!==parent)return;
  if(event.data?.kind==='fixture/page'){demoPage=event.data.page;window.dispatchEvent(new CustomEvent('kollens:live-page',{detail:demoPage}));}
  if(event.data?.kind==='fixture/focus'){demoSelected=event.data.groupId;window.dispatchEvent(new CustomEvent('kollens:live-focus',{detail:demoSelected}));}
});
export const config = { apiOrigin: __API_ORIGIN__, gmgnAuthorized: __GMGN_AUTHORIZED__,localGmgnLive:__LOCAL_GMGN_LIVE__ };
declare const __API_ORIGIN__: string;
declare const __GMGN_AUTHORIZED__: boolean;
declare const __LOCAL_GMGN_LIVE__:boolean;
export async function requestBackground<T>(message: unknown): Promise<T> {
  if (isExtension) {
    const response = await browserApi.runtime.sendMessage(message);
    if (response?.error) throw new Error(response.error);
    return response;
  }
  if((message as any).kind==='select'){
    demoSelected=(message as any).groupId;
    parent.postMessage({kind:'fixture/settings',settings:{kind:'select',groupId:demoSelected}},location.origin);
    return {ok:true} as T;
  }
  let clientId=localStorage.getItem('kollens-demo-client');if(!clientId){clientId=crypto.randomUUID();localStorage.setItem('kollens-demo-client',clientId);}
  const response = await fetch('/__demo/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json','X-Demo-Client':clientId },
    body: JSON.stringify(message),
    signal: (message as any).kind === 'state' ? AbortSignal.timeout(8000) : undefined,
  });
  const value = await response.json();
  if (!response.ok || value.error) throw new Error(value.error ?? 'Request failed');
  if((message as any).kind==='state'){
    parent.postMessage({kind:'fixture/settings',settings:{kind:'settings',preferences:{...value.preferences,sound:value.preferences.sound&&value.soundActivated},saved:value.saved}},location.origin);
    return {...value,page:demoPage,selected:demoSelected};
  }
  if((message as any).kind==='connect'&&value.url)window.open(value.url,'_blank','noopener,noreferrer');
  return value;
}
