import{createHash}from'node:crypto';import{AbiCoder,keccak256,getCreateAddress}from'ethers';import type{Pool}from'pg';
import{freshHash,freshInteger,validateFreshReceipt,type FreshCapturedReceipt,type FreshBlock}from'./capture.js';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const FRESH_SYNTHETIC_BATCH_AUDIT=Object.freeze({id:'exact_synthetic_airdrop_batch_v1',token:'0xf2fbae0d1d5e0c2e1468e9a09e0b14409a69d36e',selector:'0x729ad39e',
 creationBlock:129263916,creationHash:'0xd351d3e23886736f96391475ebf42bb72d7de2f2ed707e6e66b39830c0754afe',creationParent:'0x9f6bf8ad64aed79f8cb0ce1b5c7bac4a53f4faa5374623712805381af2d1e138',
 creationTime:'2026-10-23T05:13:18.000Z',creationTx:'0x523e98750929e5a98f36c24e5114e03e4810418048dc3b3e91bc273a670f0abc',creator:'0x0c9d19e0deb81db95accbc3064c94ced056d537c',
 initcodeHash:'0xe4b754dc1cca3b75da3bb1012940284a4923876993655c5a9626d118f0d5ec47',constructorHash:'0x3874ef451ab834e4d4401ea99ed68ff45c6cd0ac792eaaa6d180e22ea55eceae',
 runtimeHash:'0x97e4bafca612b34555be2e0f27ca04c7dfa9d212358a9fd76962a50027f222ec',constructorBytes:6266,runtimeBytes:19217,initcodeBytes:25707});
export const FRESH_POP_SYNTHETIC_BATCH_AUDIT=Object.freeze({id:'exact_pop_synthetic_airdrop_batch_v1',token:'0x59bb522a41c820b4c71c06d6251c8877a57a1c30',selector:'0x9a60c020',
 creationBlock:129450040,creationHash:'0xdbeb570df6d8e500aa99906c57e84a4208c813d8f452edb2c480e23bd9024c2f',creationParent:'0xeb195d15101cf9d7e32097676e29720e14c9f9a32a2c842b6bb326bab9274f9b',
 creationTime:'2026-10-24T04:29:34.000Z',creationTx:'0x9008e9feff03c76848c02da8372d58a8c2875936bfcfa1a97bd7d0e8090a3418',creator:'0x2875d92eff3268a52a0495cf9d0022bfdb613df7',
 initcodeHash:'0x59268ba42d34960b01da1269285c75a3b0736228cc37a6f6bba4d7a3828357be',constructorHash:'0x89ffeaf3b9b16c5ae8b8e7acfc6c8ffac68422cd8912da566998b4ddcf33d434',
 runtimeHash:'0xbb0e73c9c061ae2abe2635a7bafa321e24c5ba037b9d6d8e157fac535b38af63',constructorBytes:1862,runtimeBytes:3662,initcodeBytes:5812});
export const FRESH_PMC_SYNTHETIC_BATCH_AUDIT=Object.freeze({id:'exact_pmc_synthetic_airdrop_batch_v1',token:'0x34c30559f3c5df0499d9a7485fcf14e8fda20c44',selector:'0x9a60c020',
 creationBlock:129428235,creationHash:'0xb4e50245963f347a2f38b1e7052d4e0742be595046de82715672b8d1f9bd32eb',creationParent:'0xf0c794224b220195870592911d2cd8c2b0c3fdaf07c18b4773de2b16b84f8cd3',
 creationTime:'2026-10-24T01:46:00.000Z',creationTx:'0x00da440ab0b21d0acffe01b243403077c83d9b64e06774aa4c2d694ceab2bc52',creator:'0xf6cb5513e49fbfb2119d7f2fb7c602bb980f1952',
 initcodeHash:'0x7b04dbe0c73f179090729cf8cc2df394ed5de4b360bcf1b87bf9d72e1fc67970',constructorHash:'0x89ffeaf3b9b16c5ae8b8e7acfc6c8ffac68422cd8912da566998b4ddcf33d434',
 runtimeHash:'0xd5a1b7e52413dac0b4c61487d94940e85c6338c01153ec90a8899261c25fe194',constructorBytes:1862,runtimeBytes:3662,initcodeBytes:5812});
export const FRESH_ZODIAC_SYNTHETIC_BATCH_AUDIT=Object.freeze({id:'exact_zodiac_synthetic_airdrop_batch_v1',token:'0x75a0998933abf2aca3cdcd313fc5c16eaf99a4d9',selector:'0x9a60c020',
 creationBlock:129422030,creationHash:'0xb9f3e3b96975ddd4ab95ece1d980efda5ebc4daa18294a329e6a4f955c4bd2b1',creationParent:'0xc584294f5ca683a1e86a67c3cd698db90cf2371833fa1c93272e45ddb536622c',
 creationTime:'2026-10-24T00:59:27.000Z',creationTx:'0x14ea7fe07baf23bbbd63f94f40ed11e4f2e9f8304770ce9630124c5fd8b77c7e',creator:'0xd63d5b05aac4bf499d1e1b7143ce8bec66184aaa',
 initcodeHash:'0x15b28824702f88f052163ab10c1957aea67547b2312f90be1afb0fa970d8eba0',constructorHash:'0x89ffeaf3b9b16c5ae8b8e7acfc6c8ffac68422cd8912da566998b4ddcf33d434',
 runtimeHash:'0xe06d3c56e5a12d96cdc1d0c810a8706b83abd5a5725a77bd02170bed1651424c',constructorBytes:1862,runtimeBytes:3662,initcodeBytes:5812});
export const FRESH_ADDITIONAL_SYNTHETIC_BATCH_AUDITS=Object.freeze([
 Object.freeze({id:'exact_ebb_synthetic_airdrop_batch_v1',token:'0xebb1cfbd908e4fedb99144f034009fb05ae2164e',selector:'0x729ad39e',
  creationBlock:129481279,creationHash:'0x9d417087c3fcbfddcc216b954469bca8a07a88a350bdbdaf23402705d856beac',creationParent:'0x082c610f93e46d0fdbe82b12979982c3255837b240609edcc0129e4984103419',
  creationTime:'2026-10-24T08:23:54.000Z',creationTx:'0x9c572806b073ec5e099b6a322d4499baf9d910d507921ae5c2c1f54f5623245c',creator:'0xf93095f98e3dcc7cd7f5105d6c45124bb91fa645',
  initcodeHash:'0x18f677d82dfec7f05557aeda6c97103c040bf39a620611aa14f0ddc1e6c801a7',constructorHash:'0xee7b1edf2fb6f4a5a3f2e75c1c3276e97e14905b525a05dd1a7541559870628b',
  runtimeHash:'0xfd956d8f9e8d506b626d87f69ecfa4fc653db6379d8a617f4e28c19a1400abff',constructorBytes:3114,runtimeBytes:9597,initcodeBytes:12967}),
 Object.freeze({id:'exact_549_synthetic_airdrop_batch_v1',token:'0x549a71503c2f8b066e7de82ca22b8491b987b493',selector:'0x729ad39e',
  creationBlock:129352290,creationHash:'0x9173f2aa3ea496e2b57df0fd502afbb1dd9832bcf5a4a32a4f553b66a23bbe07',creationParent:'0xaf6efa24c23136a03f1ca685850aa6c1ad8085b5b57d0eed6e362750d67d3c07',
  creationTime:'2026-10-23T16:16:19.000Z',creationTx:'0xc571efda222353950ae150699a74b8c37c8e81a754302f2fd08f60eda92429b9',creator:'0xbe8b97c505b65d8c1b08e707e5461bc99185baea',
  initcodeHash:'0x8ef53f931fc1effea0885de4b63c97bcc1b35c531c7adcef9be02e0f8a8a50db',constructorHash:'0xee7b1edf2fb6f4a5a3f2e75c1c3276e97e14905b525a05dd1a7541559870628b',
  runtimeHash:'0x0f2478e3ef1fc94835108dd27135970b8f74c3705eba64d689fcd911916b9b73',constructorBytes:3114,runtimeBytes:9597,initcodeBytes:12967}),
]);
const audits=[FRESH_SYNTHETIC_BATCH_AUDIT,FRESH_POP_SYNTHETIC_BATCH_AUDIT,FRESH_PMC_SYNTHETIC_BATCH_AUDIT,FRESH_ZODIAC_SYNTHETIC_BATCH_AUDIT,...FRESH_ADDITIONAL_SYNTHETIC_BATCH_AUDITS] as const;
type Audit=typeof audits[number];
const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',abi=AbiCoder.defaultAbiCoder();
export interface FreshSyntheticBatchAnchor{version:1;kind:'audited_execution_only_synthetic_batch';chainId:56;auditId:string;tokenAddress:string;creationBlock:number;creationHash:string;creationTx:string;creator:string;initcodeHash:string;constructorHash:string;runtimeHash:string}
const anchorFor=(audit:Audit):FreshSyntheticBatchAnchor=>Object.freeze({version:1,kind:'audited_execution_only_synthetic_batch',chainId:56,auditId:audit.id,tokenAddress:audit.token,
 creationBlock:audit.creationBlock,creationHash:audit.creationHash,creationTx:audit.creationTx,creator:audit.creator,initcodeHash:audit.initcodeHash,constructorHash:audit.constructorHash,runtimeHash:audit.runtimeHash});
export const FRESH_SYNTHETIC_BATCH_ANCHOR=anchorFor(FRESH_SYNTHETIC_BATCH_AUDIT);
export const FRESH_POP_SYNTHETIC_BATCH_ANCHOR=anchorFor(FRESH_POP_SYNTHETIC_BATCH_AUDIT);
export const FRESH_PMC_SYNTHETIC_BATCH_ANCHOR=anchorFor(FRESH_PMC_SYNTHETIC_BATCH_AUDIT);
export const FRESH_ZODIAC_SYNTHETIC_BATCH_ANCHOR=anchorFor(FRESH_ZODIAC_SYNTHETIC_BATCH_AUDIT);
export interface FreshSyntheticBatchProof{version:1;kind:'synthetic_transfer_batch_execution';auditId:string;tokenAddress:string;transactionHash:string;blockHash:string;blockNumber:number;
 inputSha256:string;logsSha256:string;logIndices:number[];recipients:number;amountRaw:string;creation:FreshSyntheticBatchAnchor}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const anchorValid=(value:unknown,audit:Audit)=>{const anchor=anchorFor(audit);return Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===Object.keys(anchor).length
 &&Object.entries(anchor).every(([key,v])=>(value as Record<string,unknown>)[key]===v));};
const candidateAudit=(entry:FreshCapturedReceipt)=>{const input=entry.transaction.input;return entry.receipt.status==='0x1'&&typeof input==='string'
 ?audits.find(audit=>entry.transaction.to===audit.token&&input.slice(0,10).toLowerCase()===audit.selector):undefined;};

/** Each complete pinned constructor was independently executed and reproduced
 * its exact runtime/immutable patches. Each audited batch path emits only logs
 * without SSTORE/CALL; genuine ERC20 paths remain untouched. */
export function classifyFreshSyntheticBatchCreation(context:{transaction:FreshCapturedReceipt['transaction'];receipt:FreshCapturedReceipt['receipt'];block:FreshBlock},runtime:string):FreshSyntheticBatchAnchor|null{
 try{const{transaction:tx,receipt,block}=context,audit=audits.find(value=>value.creationTx===tx.hash);if(!audit)return null;
  if(tx.hash!==audit.creationTx||tx.from!==audit.creator||tx.to!==null||freshInteger(tx.chainId)!==56n||freshInteger(tx.nonce)!==0n||freshInteger(tx.value)!==0n||tx.authorizationList!==undefined
   ||tx.blockHash!==audit.creationHash||Number(freshInteger(tx.blockNumber))!==audit.creationBlock||block.hash!==audit.creationHash||block.parentHash!==audit.creationParent
   ||Number(freshInteger(block.number))!==audit.creationBlock||Number(freshInteger(block.timestamp))*1000!==Date.parse(audit.creationTime)
   ||receipt.status!=='0x1'||receipt.contractAddress!==audit.token||getCreateAddress({from:tx.from,nonce:0}).toLowerCase()!==audit.token
   ||typeof tx.input!=='string'||tx.input.length!==2+audit.initcodeBytes*2||keccak256(tx.input)!==audit.initcodeHash
   ||keccak256(Buffer.from(tx.input.slice(2),'hex').subarray(0,audit.constructorBytes))!==audit.constructorHash
   ||typeof runtime!=='string'||runtime.length!==2+audit.runtimeBytes*2||keccak256(runtime)!==audit.runtimeHash)return null;
  validateFreshReceipt(receipt,tx,block);const listed=block.transactions[Number(freshInteger(tx.transactionIndex))];
  if((typeof listed==='string'?listed:listed?.hash)!==tx.hash)return null;return anchorFor(audit);
 }catch{return null;}
}

export const isFreshSyntheticBatchCandidate=(entry:FreshCapturedReceipt)=>Boolean(candidateAudit(entry));

/** A retained audited launch is the durable code-identity anchor after72h.
 * Reorg rollback deletes invalidated launch facts, including their marker. An
 * extant conflicting birth header always rejects; a missing unpruned one does
 * not become approval merely because a marker exists. */
export async function readFreshSyntheticBatchAnchor(database:Pick<Pool,'query'>,tokenAddress:string=FRESH_SYNTHETIC_BATCH_AUDIT.token):Promise<FreshSyntheticBatchAnchor|null>{
 const audit=audits.find(value=>value.token===tokenAddress);if(!audit)return null;
 const row=(await database.query(`SELECT f.*,b.block_hash AS canonical_hash,(SELECT min(block_number) FROM fresh.recent_blocks)::text AS earliest_header
 FROM fresh.launch_facts f LEFT JOIN fresh.recent_blocks b ON b.block_number=f.block_number WHERE f.token_address=$1`,[audit.token])).rows[0];
 if(!row||row.protocol!=='evm_creation'||row.status!=='eligible'||row.log_index!==null||Number(row.block_number)!==audit.creationBlock||row.block_hash!==audit.creationHash
  ||row.tx_hash!==audit.creationTx||new Date(row.launched_at).getTime()!==Date.parse(audit.creationTime)||row.proof?.creator!==audit.creator||row.proof?.creation!=='top_level'
  ||!anchorValid(row.proof?.syntheticTransferBatch,audit)||row.canonical_hash!==audit.creationHash&&!(row.canonical_hash==null&&Number(row.earliest_header)>audit.creationBlock))return null;
 return anchorFor(audit);
}

/** This proves only the complete direct call's synthetic logs. A matching
 * selector with absent/contradictory proof must remain repair, never be
 * reinterpreted as ordinary transfers. Uniform values are observed log words,
 * not guessed historical balances or costs. */
export function decodeFreshSyntheticTransferBatch(entry:FreshCapturedReceipt,block:Pick<FreshBlock,'number'|'hash'|'timestamp'>,anchor:unknown):FreshSyntheticBatchProof|null{
 const audit=candidateAudit(entry);if(!audit)return null;
 try{const tx=entry.transaction,receipt=entry.receipt;
  if(!anchorValid(anchor,audit)||receipt.status!=='0x1'||!['0x0','0x1','0x2'].includes(String(tx.type))||tx.authorizationList!==undefined||freshInteger(tx.value)!==0n
   ||Number(freshInteger(block.number))<=audit.creationBlock||tx.blockHash!==block.hash||!freshHash(block.hash)||Number(freshInteger(tx.blockNumber))!==Number(freshInteger(block.number))
   ||typeof tx.input!=='string'||tx.input.length>2+4*1024*1024||!/^0x(?:[\da-f]{2})+$/i.test(tx.input)||receipt.logs.length<1||receipt.logs.length>4096)throw Error();
  validateFreshReceipt(receipt,tx,{...block,parentHash:audit.creationParent,transactions:[]}as FreshBlock);
  const encoded=tx.input.slice(10),pop=audit.id===FRESH_POP_SYNTHETIC_BATCH_AUDIT.id||audit.id===FRESH_PMC_SYNTHETIC_BATCH_AUDIT.id||audit.id===FRESH_ZODIAC_SYNTHETIC_BATCH_AUDIT.id,types=pop?['address','address[]','uint256','uint256']:['address[]'];
  const args=abi.decode(types,'0x'+encoded),recipients=[...args[pop?1:0]].map(v=>String(v).toLowerCase());
  // These otherwise unused words are pinned to the audited POP/PMC/Zodiac calls;
  // future argument variants remain explicit repair rather than broad approval.
  if(recipients.length!==receipt.logs.length||abi.encode(types,args).slice(2)!==encoded.toLowerCase()||pop&&(String(args[0]).toLowerCase()!==audit.token||args[2]!==BigInt(audit.id===FRESH_POP_SYNTHETIC_BATCH_AUDIT.id?'109000000000000000000':audit.id===FRESH_PMC_SYNTHETIC_BATCH_AUDIT.id?'248000000000000000000':'253000000000000000000')||args[3]!==50n))throw Error();
  let amount:string|undefined;const indices:number[]=[];
  for(let i=0;i<receipt.logs.length;i++){const log=receipt.logs[i],topics=[transfer,'0x'+'0'.repeat(24)+audit.token.slice(2),'0x'+'0'.repeat(24)+recipients[i].slice(2)];
   if(log.address!==audit.token||log.removed||!same(log.topics,topics)||!/^0x[\da-f]{64}$/.test(log.data)||amount!==undefined&&amount!==log.data)throw Error();
   if(pop&&BigInt(log.data)!==5000000000000000000n)throw Error();
   amount=log.data;const index=Number(freshInteger(log.logIndex));if(indices.length&&index<=indices.at(-1)!)throw Error();indices.push(index);}
  return{version:1,kind:'synthetic_transfer_batch_execution',auditId:audit.id,tokenAddress:audit.token,transactionHash:tx.hash,blockHash:block.hash,blockNumber:Number(freshInteger(block.number)),
   inputSha256:hash(tx.input),logsSha256:hash(receipt.logs),logIndices:indices,recipients:recipients.length,amountRaw:String(BigInt(amount!)),creation:anchorFor(audit)};
 }catch{throw Error('synthetic_transfer_batch_unverified');}
}
