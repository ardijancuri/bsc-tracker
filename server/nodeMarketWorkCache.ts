/** Retain a bounded number of completed exact-block reads. Pending jobs are
 * never evicted, so concurrent consumers keep joining the same work. */
export class NodeMarketWorkCache<K,V>{
  private readonly entries=new Map<K,{promise:Promise<V>;settled:boolean}>();
  private completed=0;
  constructor(private readonly maximumCompleted:number){if(!Number.isInteger(maximumCompleted)||maximumCompleted<0)throw Error('invalid_work_cache_limit');}
  get size(){return this.entries.size;}
  get(key:K){return this.entries.get(key)?.promise;}
  set(key:K,promise:Promise<V>){
    this.delete(key);const entry={promise,settled:false};this.entries.set(key,entry);
    const settled=()=>{if(this.entries.get(key)!==entry)return;entry.settled=true;this.completed++;
      for(const [oldKey,oldEntry]of this.entries){if(this.completed<=this.maximumCompleted)break;if(oldEntry.settled)this.delete(oldKey);}};
    void promise.then(settled,settled);return this;
  }
  delete(key:K){const entry=this.entries.get(key);if(entry?.settled)this.completed--;return this.entries.delete(key);}
  clearCompleted(){for(const[key,entry]of this.entries)if(entry.settled)this.delete(key);}
  /** Reorg invalidation also detaches pending jobs from the new generation. */
  clear(){this.entries.clear();this.completed=0;}
}
