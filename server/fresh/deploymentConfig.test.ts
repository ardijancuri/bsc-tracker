import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
// JSON is a strict subset of Compose's YAML syntax. Parsing the checked-in
// document needs no new runtime/package or access to production credentials.
const read=(name:string)=>readFileSync(name,'utf8');
const config=JSON.parse(read('compose.fresh.vps.yaml')),services=config.services;
describe('Fresh production candidate isolation',()=>{
 it('keeps the legacy database and volumes completely outside the new project',()=>{
  expect(config.name).toBe('kollens-fresh-v14');expect(services['fresh-db'].environment.POSTGRES_DB).toBe('kollens_fresh_v14');
  expect(services['fresh-db'].ports).toEqual(['127.0.0.1:5437:5432']);expect(services['fresh-db'].volumes).toEqual(['fresh_pgdata:/var/lib/postgresql/data']);
  expect(Object.keys(config.volumes)).toEqual(['fresh_pgdata','fresh_chartcache','fresh_frontendassets']);
  for(const name of['app','worker'])expect(services[name].environment.DATABASE_URL).toMatch(/@127\.0\.0\.1:5437\/kollens_fresh_v14$/);
  expect(read('compose.fresh.vps.yaml')).not.toContain('bscan_pgdata');
 });
 it('starts neither the API nor capture as a side effect of an unqualified up',()=>{
  expect(services['fresh-db'].profiles).toBeUndefined();expect(services.app.profiles).toEqual(['runtime']);expect(services.worker.profiles).toEqual(['runtime']);expect(services.cutover.profiles).toEqual(['operators']);
  expect(services.app.environment.HOST).toBe('127.0.0.1');expect(services.app.environment.PORT).toBe('${FRESH_APP_PORT:-3303}');
  expect(services.worker.depends_on.app.condition).toBe('service_healthy');
 });
 it('supplies API chart credentials and persists the cache where the service actually uses it',()=>{
  for(const key of['GMGN_API_KEY','GMGN_CHART_API_KEY','GMGN_ACCOUNTING_API_KEY'])expect(services.app.environment[key]).toBeTruthy();
  expect(services.app.environment.GMGN_CHART_CACHE_DIR).toBe('/app/.cache/fresh/charts');expect(services.app.volumes).toContain('fresh_chartcache:/app/.cache/fresh/charts');
  expect(services.app.environment.FRESH_REPLAY_SECRET).toContain(':?');expect(Object.keys(services.app.environment).some(key=>key.startsWith('VITE_'))).toBe(false);
 });
 it('keeps private tracing worker-only on the existing read-only socket',()=>{
  const mount=services.worker.volumes[0];expect(mount.type).toBe('bind');expect(mount.target).toBe('/run/bsc/geth.ipc');expect(mount.read_only).toBe(true);expect(mount.bind.create_host_path).toBe(false);
  expect(services.worker.environment.BSC_TRACE_IPC).toBe('/run/bsc/geth.ipc');expect(services.app.volumes.every((v:unknown)=>typeof v==='string')).toBe(true);expect(services.app.environment.BSC_TRACE_IPC).toBeUndefined();
 });
 it('provides no real messaging token during preview and has a separate explicit activation overlay',()=>{
  for(const name of['app','worker']){expect(services[name].environment.TELEGRAM_BOT_TOKEN).toBe('');expect(services[name].environment.FRESH_TELEGRAM_ACTIVE).toBe('false');}
  const activation=JSON.parse(read('compose.fresh.activate.yaml'));for(const name of['app','worker']){expect(activation.services[name].environment.FRESH_TELEGRAM_ACTIVE).toBe('true');expect(activation.services[name].environment.TELEGRAM_BOT_TOKEN).toContain(':?');expect(activation.services[name].environment.DATABASE_URL).toBeUndefined();}
 });
 it('ships the guarded dry-run operator without copying private cutover files into Git or image builds',()=>{
  expect(services.cutover.entrypoint).toEqual(['node','dist-server/freshCutover.js']);expect(services.cutover.command).toEqual(['plan']);expect(services.cutover.environment.FRESH_CUTOVER_DEST_DATABASE_NAME).toBe('kollens_fresh_v14');
  expect(services.cutover.volumes[0].bind.create_host_path).toBe(false);expect(services.cutover.environment.FRESH_CUTOVER_DIR).toBe('/app/.cutover');expect(services.cutover.depends_on.app).toBeUndefined();
  expect(JSON.parse(read('package.json')).scripts.build).toContain('server/freshCutover.ts');expect(read('Dockerfile')).toContain('COPY --from=build /app/dist-server ./dist-server');
  expect(read('.gitignore')).toContain('.cutover/');expect(read('.dockerignore')).toContain('.cutover');
 });
});
