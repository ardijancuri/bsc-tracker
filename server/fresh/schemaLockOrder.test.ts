import {describe,it,expect} from 'vitest';
import type {Pool} from 'pg';
import {ensureFreshSchema} from './schema.js';

function fixture(legacy:string|null=null){
  const clients:{queries:string[];released:boolean}[]=[];
  const database={
    async connect(){
      const calls={queries:[] as string[],released:false};clients.push(calls);
      return{async query(sql:string){calls.queries.push(sql);return{rows:sql.includes("to_regclass('public.position_snapshots')")?[{legacy}]:[]};},release(){calls.released=true;}};
    },
    async query(_sql:string){return{rows:[]};},
  };
  return{database:database as unknown as Pool,clients};
}

describe('Fresh startup DDL lock order',()=>{
  it('waits for financial writers before the legacy check or any DDL',async()=>{
    const {database,clients}=fixture();await ensureFreshSchema(database);
    const core=clients[0];
    expect(core.queries.slice(0,4)).toEqual(['BEGIN','SELECT pg_advisory_xact_lock(73621940)','SELECT pg_advisory_xact_lock(73621941)',"SELECT to_regclass('public.position_snapshots') AS legacy"]);
    const ddl=core.queries.findIndex(sql=>sql.includes('CREATE SCHEMA IF NOT EXISTS fresh'));
    expect(ddl).toBeGreaterThan(3);expect(core.queries.at(-1)).toBe('COMMIT');expect(core.released).toBe(true);
  });
  it('still rejects a legacy database without issuing DDL or starting public helpers',async()=>{
    const {database,clients}=fixture('position_snapshots');
    await expect(ensureFreshSchema(database)).rejects.toThrow('fresh_requires_separate_database');
    expect(clients).toHaveLength(1);expect(clients[0].queries).toEqual(['BEGIN','SELECT pg_advisory_xact_lock(73621940)','SELECT pg_advisory_xact_lock(73621941)',"SELECT to_regclass('public.position_snapshots') AS legacy",'ROLLBACK']);
    expect(clients[0].released).toBe(true);
  });
});
