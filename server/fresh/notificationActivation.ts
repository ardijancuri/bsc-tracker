import type {Pool,PoolClient} from 'pg';

export interface FreshNotificationActivation {
  activatedAt:string;
  alertStartBlock:string;
  alertStartHash:string;
  sourceManifestSha256:string;
}
type Row=Record<string,any>;
const hash=(v:unknown):v is string=>typeof v==='string'&&/^0x[0-9a-f]{64}$/.test(v);
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const block=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v);

/** A production sender is disabled until the separate-database cutover has
 * been sealed and explicitly activated. Imported delivery rows remain intact. */
export function freshNotificationActivation(row:Row|undefined,now:number):FreshNotificationActivation|null {
  if(!row)return null;
  const a=row.activation,s=row.seal;
  if(!a||a.version!==1||a.invalidatedAt||!s||s.version!==1
    ||!digest(a.sourceManifestSha256)||a.sourceManifestSha256!==s.sourceManifestSha256
    ||s.legacyPendingCount!==0||s.legacyLeasedCount!==0||s.legacySenderStoppedAcknowledged!==true
    ||s.legacyUnprocessedCount!==0||s.legacyBotSendingCount!==0||s.legacyCollectorStoppedAcknowledged!==true
    ||s.legacyHandoffBlock!==a.alertStartBlock||s.legacyHandoffHash!==a.alertStartHash
    ||!block(a.alertStartBlock)||!hash(a.alertStartHash)||String(row.block_number)!==a.alertStartBlock||row.block_hash!==a.alertStartHash
    ||!block(String(row.capture_block??''))||BigInt(row.capture_block)<BigInt(a.alertStartBlock)
    ||row.current_hash!=null&&row.current_hash!==a.alertStartHash)return null;
  const at=Date.parse(a.activatedAt),sealAt=Date.parse(s.sealedAt);
  if(!Number.isFinite(at)||!Number.isFinite(sealAt)||at>now+1000||sealAt>at
    ||new Date(at).toISOString()!==a.activatedAt)return null;
  return{activatedAt:a.activatedAt,alertStartBlock:a.alertStartBlock,alertStartHash:a.alertStartHash,sourceManifestSha256:a.sourceManifestSha256};
}

export async function readFreshNotificationActivation(db:Pick<Pool|PoolClient,'query'>,now:number){
  const row=(await db.query(`SELECT a.block_number::text,a.block_hash,a.value AS activation,s.value AS seal,
    c.block_number::text AS capture_block,b.block_hash AS current_hash
    FROM fresh.checkpoints a JOIN fresh.checkpoints s ON s.key='production_cutover_seal'
    JOIN fresh.checkpoints c ON c.key='capture'
    LEFT JOIN fresh.recent_blocks b ON b.block_number=a.block_number
    WHERE a.key='production_activation'`)).rows[0];
  return freshNotificationActivation(row,now);
}

export function freshNotificationProductionPolicy(stateTable:string,nodeEnv:string|undefined,flag:string|undefined){
  return stateTable==='fresh.checkpoints'&&nodeEnv==='production'?{enabled:flag==='true'}:null;
}

export async function invalidateFreshNotificationActivation(db:Pick<Pool|PoolClient,'query'>,ancestor:number,now=new Date()){
  await db.query(`UPDATE fresh.checkpoints SET value=value||jsonb_build_object('invalidatedAt',$2::text,'reason','activation_block_reorged'),updated_at=$2::timestamptz
    WHERE key='production_activation' AND block_number>$1 AND NOT(value?'invalidatedAt')`,[ancestor,now.toISOString()]);
}
