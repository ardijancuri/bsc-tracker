import{describe,expect,it}from'vitest';
import{NodeMarketWorkCache}from'./nodeMarketWorkCache.js';
const deferred=()=>{let resolve!:(value:number)=>void;const promise=new Promise<number>(done=>{resolve=done;});return{promise,resolve};};
describe('bounded market completed work',()=>{
  it('bounds settled results while retaining pending coalescing',async()=>{
    const cache=new NodeMarketWorkCache<string,number>(2),pending=deferred();cache.set('pending',pending.promise);
    for(let index=0;index<20;index++){const result=Promise.resolve(index);cache.set(String(index),result);await result;}
    expect(cache.size).toBe(3);expect(cache.get('pending')).toBe(pending.promise);expect(cache.get('0')).toBeUndefined();
    cache.clearCompleted();expect(cache.size).toBe(1);expect(cache.get('pending')).toBe(pending.promise);
    pending.resolve(1);await pending.promise;expect(cache.get('pending')).toBe(pending.promise);
  });
  it('does not let an old generation replace or evict a replacement job',async()=>{
    const cache=new NodeMarketWorkCache<string,number>(1),old=deferred(),fresh=deferred();cache.set('same',old.promise);cache.clear();cache.set('same',fresh.promise);
    old.resolve(1);await old.promise;expect(cache.get('same')).toBe(fresh.promise);expect(cache.size).toBe(1);
    fresh.resolve(2);await fresh.promise;cache.set('later',Promise.resolve(3));await Promise.resolve();expect(cache.get('same')).toBeUndefined();expect(cache.size).toBe(1);
  });
  it('bounds rejected jobs without leaving unhandled failures',async()=>{
    const cache=new NodeMarketWorkCache<string,number>(0),failure=Promise.reject(Error('node unavailable'));cache.set('failed',failure);
    await expect(failure).rejects.toThrow('node unavailable');expect(cache.size).toBe(0);
  });
});
