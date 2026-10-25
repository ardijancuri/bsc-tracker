import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
/** Runtime watermark: stale processes earn no new credit. Reviewed earlier
 * build segments retain their audited healthy intervals. */
export async function freshRuntimeDigest() {
  const directory=path.resolve('server/fresh');
  const names=(await readdir(directory)).filter(name=>name.endsWith('.ts')&&!name.endsWith('.test.ts')&&!name.endsWith('.integration.ts')&&!name.endsWith('.fixture.ts')).map(name=>`server/fresh/${name}`);
  names.push('server/index.ts','server/worker.ts','server/db.ts','server/rpc.ts','server/gmgnTransport.ts','server/telegramNotifications.ts','server/freshInit.ts','server/freshTrial.ts','server/freshTrialReview.ts','server/swap.ts','server/launchpad.ts','server/nodeMarketProtocols.ts','server/nodeMarketMath.ts');
  names.push('shared/freshAccounting.ts','shared/kolTokenTrades.ts','shared/nodeAccounting.ts','shared/replayPreparation.ts','src/replayPreparationRequest.ts','src/nodeReplay.ts','src/tradeReplayData.ts','src/tradeReplayCanvas.js','src/tradeReplayExport.ts');
  names.push('shared/intelligence.ts','src/App.tsx','src/TokenMarketPanel.tsx','src/trackedTokenGroups.ts','src/types.ts','src/zh-CN.ts','src/styles.css');
  names.push('server/tokenLogo.ts','server/tokenImage.ts');
  const hash=createHash('sha256');for(const name of names.sort()){hash.update(name);hash.update(await readFile(name));}return hash.digest('hex');
}
