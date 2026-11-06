import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import {beforeAll, expect, it, vi} from 'vitest';
import {defaultExtensionPreferences} from '../../../shared/extension';

let content: string;
beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./content.ts', import.meta.url))],
    bundle: true, platform: 'browser', format: 'iife', write: false,
    define: {__API_ORIGIN__: '""', __GMGN_AUTHORIZED__: 'false', __LOCAL_GMGN_LIVE__: 'true'},
  });
  content = result.outputFiles[0].text;
});

it.each(['synchronous throw', 'promise rejection', 'missing runtime'])(
  'retires the page script on a stale extension context: %s', async (failure) => {
    let stale = false;
    const invalidated = () => new Error('Extension context invalidated.');
    const message = vi.fn(() => {
      if (!stale) return Promise.resolve();
      if (failure === 'promise rejection') return Promise.reject(invalidated());
      throw invalidated();
    });
    const runtime = {id: 'kollens', sendMessage: message, onMessage: {
      addListener: vi.fn(), removeListener: vi.fn(() => { throw invalidated(); }),
    }};
    const style = {setAttribute: vi.fn(), remove: vi.fn()};
    const disconnect = vi.fn(), observe = vi.fn();
    const listeners = new Map<string, () => void>();
    const clearInterval = vi.fn();
    const location = {hostname: '127.0.0.1', pathname: '/fixture', href: 'http://127.0.0.1:3360/fixture'};
    const globals = {
      chrome: {get runtime() { return stale && failure === 'missing runtime' ? undefined : runtime; }},
      document: {createElement: () => style, head: {append: vi.fn()}, body: {}, querySelector: () => null},
      window: {
        addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
        removeEventListener: (type: string) => listeners.delete(type),
      },
      MutationObserver: class {observe = observe; disconnect = disconnect;},
      crypto: {randomUUID: () => 'fixture-page'}, location, queueMicrotask,
      setInterval: () => 123, clearInterval,
    };
    runInNewContext(content, globals);
    expect(message).toHaveBeenCalledTimes(1);
    // A navigation callback already registered in the open tab publishes again.
    stale = true;
    location.href += '?sort=volume';
    expect(() => listeners.get('popstate')!()).not.toThrow();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(clearInterval).toHaveBeenCalledWith(123);
    expect(style.remove).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
    expect(globals).not.toHaveProperty('__kollensContent');
  },
);

it('retries a transient settings startup failure and only decorates after an authorized response', async () => {
  const readySettings = {preferences:defaultExtensionPreferences,saved:[]};
  const runtime = {
    id:'kollens',
    sendMessage:vi.fn()
      .mockRejectedValueOnce(new Error('Could not establish connection.'))
      .mockResolvedValueOnce(readySettings)
      .mockResolvedValue(undefined),
    onMessage:{addListener:vi.fn(),removeListener:vi.fn()},
  };
  const append=vi.fn(),timers=new Map<number,()=>void>();
  const observe=vi.fn();
  const location={hostname:'gmgn.ai',pathname:'/',href:'https://gmgn.ai/?chain=bsc'};
  const style={setAttribute:vi.fn(),remove:vi.fn()};
  const globals={
    chrome:{runtime},location,URL,queueMicrotask,
    window:{addEventListener:vi.fn(),removeEventListener:vi.fn()},
    document:{createElement:()=>style,head:{append},body:{},querySelector:()=>null},
    MutationObserver:class{observe=observe;disconnect=vi.fn();},
    crypto:{randomUUID:()=> 'gmgn-page'},
    setInterval:()=>123,clearInterval:vi.fn(),
    setTimeout:(run:()=>void,delay:number)=>{timers.set(delay,run);return delay;},
    clearTimeout:(id:number)=>{timers.delete(id);},
  };
  runInNewContext(content,globals);
  await new Promise<void>(resolve=>setImmediate(resolve));
  expect(append).not.toHaveBeenCalled();
  expect([...timers.keys()]).toEqual([80]);
  const response=vi.fn();
  runtime.onMessage.addListener.mock.calls[0][0]({kind:'request-page'},{id:'kollens'},response);
  expect(response).toHaveBeenCalledWith({ok:true});
  expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  timers.get(80)!();
  await new Promise<void>(resolve=>setImmediate(resolve));
  expect(append).toHaveBeenCalledOnce();
  expect(observe).toHaveBeenCalledOnce();
  expect(runtime.sendMessage.mock.calls.map(([message])=>message.kind)).toEqual(['content-settings','content-settings','page']);
});

it('waits for a known Trenches layout to mount, then recovers if it appears after the grace window', async () => {
  let now=10_000, nextId=0, routeTick:()=>void=()=>{};
  const route={hostname:'gmgn.ai',pathname:'/',href:'https://gmgn.ai/?chain=bsc'};
  const root={querySelector:()=>({}),querySelectorAll:()=>[],addEventListener:vi.fn(),removeEventListener:vi.fn()};
  let mounted:typeof root|null=null;
  const publish=vi.fn(async(message:{kind:string})=>message.kind==='content-settings'
    ?{preferences:defaultExtensionPreferences,saved:[]}:undefined);
  const globals={
    chrome:{runtime:{id:'kollens',sendMessage:publish,onMessage:{addListener:vi.fn(),removeListener:vi.fn()}}},
    location:route,URL,queueMicrotask,performance,Date:{now:()=>now},
    window:{addEventListener:vi.fn(),removeEventListener:vi.fn()},
    document:{
      createElement:()=>({setAttribute:vi.fn(),remove:vi.fn()}),head:{append:vi.fn()},body:{},
      querySelector:()=>mounted,visibilityState:'visible',addEventListener:vi.fn(),removeEventListener:vi.fn(),
    },
    MutationObserver:class{observe=vi.fn();disconnect=vi.fn();},
    crypto:{randomUUID:()=> String(++nextId)},
    setInterval:(run:()=>void)=>{routeTick=run;return 123;},clearInterval:vi.fn(),
    setTimeout:vi.fn(()=>124),clearTimeout:vi.fn(),
  };
  runInNewContext(content,globals);
  await new Promise<void>(resolve=>setImmediate(resolve));
  const pages=()=>publish.mock.calls.map(([value])=>value as {kind:string;page?:{status:string;pageId:string}})
    .flatMap(value=>value.page?[value.page]:[]);
  expect(pages()).toEqual([expect.objectContaining({status:'waiting'})]);
  now+=1_000;
  routeTick();
  expect(pages()).toHaveLength(1);
  now+=1_000;
  routeTick();
  expect(pages()).toEqual([
    expect.objectContaining({status:'waiting'}),
    expect.objectContaining({status:'unsupported',pageId:pages()[0].pageId}),
  ]);
  mounted=root;
  routeTick();
  expect(pages().at(-1)).toMatchObject({status:'ready'});
  mounted=null;
  routeTick();
  expect(pages().at(-1)).toMatchObject({status:'waiting',cards:[],groups:[]});
  mounted=root;
  routeTick();
  expect(pages().at(-1)).toMatchObject({status:'ready'});
  route.href='https://gmgn.ai/?chain=sol';
  routeTick();
  expect(pages().at(-1)).toMatchObject({status:'disabled',cards:[],groups:[]});
});
