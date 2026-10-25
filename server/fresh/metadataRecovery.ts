import { createHash } from 'node:crypto';
import { AbiCoder, getCreateAddress, keccak256 } from 'ethers';
import { decodeFreshEvidence, validateFreshBlock, validateFreshReceipt, type FreshBlock, type FreshReceipt, type FreshTransaction } from './capture.js';
import { createFreshStateEvidenceRpc } from './stateEvidence.js';

export interface FreshMetadataRecoveryBlock { number: number; hash: string; timestamp: string }
export interface FreshImmutableDecimalsRecoveryInput {
  chainId: number;
  tokenAddress: string;
  target: FreshMetadataRecoveryBlock;
  creation: { transaction: FreshTransaction; receipt: FreshReceipt; block: FreshBlock };
  source: { payload: Buffer; block: FreshMetadataRecoveryBlock };
  implementation: { address: string; code: string; block: FreshMetadataRecoveryBlock };
}

/** This is an exact bytecode audit, not a rule for all minimal proxies. The
 * getter reads slot3; it is NOT a pure function. Its sole write is initializer
 * 0x7e737760 at 0x139a. The initializer requires slot9 byte21==0 and sets that
 * byte to1 BEFORE writing precision. No path resets that byte. Other slot9
 * writes alter only byte0 or owner bytes1..20. Dynamic string helpers are
 * called only with base slots4/5 from the initializer; balance/allowance/flag
 * mappings use hashed storage keys. There is no arbitrary storage writer,
 * CALLCODE, DELEGATECALL, CREATE, CREATE2 or SELFDESTRUCT in this implementation.
 * Thus a nonzero committed decimals result proves initialization completed,
 * and the precision cannot subsequently change in this exact runtime.
 */
export const FRESH_INITIALIZED_DECIMALS_AUDIT = Object.freeze({
  id: 'bsc_c566e94c_write_once_decimals_v1',
  implementationAddress: '0x75b2fd32294ec37c70e8f3b1bbce81b6cc71f0c6',
  codeHash: '0xc566e94ce5a163215929b07a34383035366b709245734097780ab18d0ed4567d',
  codeBytes: 19726,
  getterPc: 0x0aea,
  precisionWritePc: 0x139a,
  initializedFlagWritePc: 0x133b,
  initializerSelector: '0x7e737760',
  storageWritePcs: Object.freeze([0x846, 0x89b, 0xad7, 0xc1a, 0xf2e, 0x11fc, 0x133b, 0x1343, 0x1380, 0x139a,
    0x13b8, 0x13fb, 0x143c, 0x149d, 0x14a4, 0x14f9, 0x154d, 0x1554, 0x155b, 0x16e5, 0x1739, 0x1853,
    0x1984, 0x1b27, 0x1bc1, 0x2279, 0x2520, 0x2763, 0x289c, 0x2ac3, 0x2b19, 0x2bf0, 0x2d6f, 0x2d87,
    0x2e5e, 0x2fc9, 0x3ec2, 0x3ff4, 0x4018, 0x404a, 0x4055]),
});

// BSC mainnet Haber/Cancun activates BEP-344/EIP-6780 at this timestamp.
// https://github.com/bnb-chain/bsc/blob/v1.4.7/params/config.go
// https://github.com/bnb-chain/BEPs/blob/master/BEPs/BEP-344.md
const BSC_PERSISTENT_CODE_TIME = 1718863500;
const decimalsSelector = '0x313ce567';
const maxSourcePayloadBytes = 2 * 1024 * 1024;
const address = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value);
const quantity = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{1,64}$/i.test(value);
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const equal = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const seconds = (block: FreshMetadataRecoveryBlock) => Date.parse(block.timestamp) / 1000;
function validBlock(block: FreshMetadataRecoveryBlock) {
  return block && Number.isSafeInteger(block.number) && block.number >= 0 && hash(block.hash)
    && Number.isSafeInteger(seconds(block)) && seconds(block) >= BSC_PERSISTENT_CODE_TIME;
}

export interface FreshImmutableDecimalsProof {
  version: 1;
  kind: 'initialized_immutable_decimals';
  auditId: typeof FRESH_INITIALIZED_DECIMALS_AUDIT.id;
  chainId: 56;
  tokenAddress: string;
  decimals: number;
  target: FreshMetadataRecoveryBlock;
  creation: { transactionHash: string; block: FreshMetadataRecoveryBlock; transactionIndex: string; creator: string; nonce: string; input: string; runtimeHash: string };
  source: { transactionHash: string; block: FreshMetadataRecoveryBlock; payloadSha256: string; stateEvidenceSha256: string;
    call: { to: string; data: '0x313ce567'; result: string } };
  implementation: { address: string; codeHash: string; codeBytes: number; observedBlock: FreshMetadataRecoveryBlock;
    historicalCodeAnchor: 'committed_fixed_proxy_response_and_bsc_bep344' };
}

function auditedCode(code: unknown): code is string {
  const audit = FRESH_INITIALIZED_DECIMALS_AUDIT;
  if (typeof code !== 'string' || code.length !== 2 + audit.codeBytes * 2 || !/^0x[\da-f]+$/i.test(code) || keccak256(code) !== audit.codeHash) return false;
  const bytes = Buffer.from(code.slice(2), 'hex'), stores: number[] = [];
  const metadataStart = bytes.length - bytes.readUInt16BE(bytes.length - 2) - 2;
  if (metadataStart <= 0 || bytes[metadataStart - 1] !== 0xfe) return false;
  for (let pc = 0; pc < bytes.length; pc++) {
    const opcode = bytes[pc];
    if (pc < metadataStart && [0xf0, 0xf2, 0xf4, 0xf5, 0xff].includes(opcode) || pc >= metadataStart && opcode === 0x5b) return false;
    if (pc < metadataStart && opcode === 0x55) stores.push(pc);
    if (opcode >= 0x60 && opcode <= 0x7f) { pc += opcode - 0x5f; if (pc >= bytes.length) return false; }
  }
  return stores.length === audit.storageWritePcs.length && stores.every((pc, index) => pc === audit.storageWritePcs[index]);
}

/** Recover only immutable precision, never supply, balance, identity or price.
 *
 * All supplied headers must have been independently checked against retained
 * canonical node capture by the caller. The recent implementation.code must
 * be an actual own-node eth_getCode result pinned to implementation.block.
 * The source payload is the original checksum-verified retained receipt and
 * its successful block-hash-pinned raw call, NOT a current metadata row.
 *
 * The exact fixed proxy cannot produce a nonempty response without code at
 * its fixed implementation at the END of the source block. After BSC BEP-344,
 * code present in a committed block cannot later be replaced by SELFDESTRUCT;
 * EIP-7702 also rejects overwriting an ordinary nonempty contract runtime.
 * Therefore the audited recent code is anchored to that earlier committed
 * response. This excludes unknown chains, pre-Haber/metamorphic assumptions,
 * mutable implementation proxies, future-only observations and zero/unproven
 * initialization. A separate derived proof records both blocks; no eth_call
 * response is fabricated for the target block.
 */
export function recoverFreshImmutableDecimals(input: FreshImmutableDecimalsRecoveryInput): { decimals: number; proof: FreshImmutableDecimalsProof } | null {
  try {
    const { tokenAddress, target, source, creation, implementation } = input;
    if (input.chainId !== 56 || !address(tokenAddress) || !validBlock(target) || !validBlock(source.block) || !validBlock(implementation.block)
      || source.block.number >= target.number || seconds(source.block) > seconds(target)
      || implementation.block.number < target.number || seconds(implementation.block) < seconds(target)
      || !equal(implementation.address, FRESH_INITIALIZED_DECIMALS_AUDIT.implementationAddress) || !auditedCode(implementation.code)
      || !Buffer.isBuffer(source.payload) || source.payload.length > maxSourcePayloadBytes) return null;

    const { transaction: tx, receipt, block } = creation;
    validateFreshBlock(block, Number(BigInt(block.number))); validateFreshReceipt(receipt, tx, block);
    if (tx.to !== null || receipt.status !== '0x1' || !address(tx.from) || !address(receipt.contractAddress)
      || !quantity(tx.nonce) || BigInt(tx.nonce) > 0xffff_ffff_ffff_ffffn || !quantity(tx.transactionIndex) || typeof tx.input !== 'string'
      || !equal(receipt.contractAddress, tokenAddress) || !equal(getCreateAddress({ from: tx.from.toLowerCase(), nonce: BigInt(tx.nonce) }), tokenAddress)) return null;
    const included = block.transactions[Number(BigInt(tx.transactionIndex))];
    if (!included || !equal(included.hash, tx.hash) || included.to !== null || !equal(included.from, tx.from)
      || typeof included.input !== 'string' || !equal(included.input, tx.input) || !quantity(included.nonce) || BigInt(included.nonce) !== BigInt(tx.nonce)) return null;
    const clone = tx.input.match(/^0x3d602d80600a3d3981f3363d3d373d3d3d363d73([\da-f]{40})5af43d82803e903d91602b57fd5bf3$/i);
    if (!clone || !equal(`0x${clone[1]}`, implementation.address)) return null;
    const creationBlock: FreshMetadataRecoveryBlock = { number: Number(BigInt(block.number)), hash: block.hash.toLowerCase(), timestamp: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString() };
    if (!validBlock(creationBlock) || creationBlock.number > source.block.number || seconds(creationBlock) > seconds(source.block)) return null;

    const entry = decodeFreshEvidence(source.payload);
    if (!hash(entry.transaction.hash) || !equal(entry.transaction.hash, entry.receipt.transactionHash) || !hash(entry.transaction.blockHash)
      || !equal(entry.transaction.blockHash, source.block.hash) || !equal(entry.receipt.blockHash, source.block.hash)
      || !quantity(entry.transaction.blockNumber) || !quantity(entry.receipt.blockNumber)
      || Number(BigInt(entry.transaction.blockNumber)) !== source.block.number || Number(BigInt(entry.receipt.blockNumber)) !== source.block.number) return null;
    const state = createFreshStateEvidenceRpc(async () => { throw new Error('metadata_recovery_network_forbidden'); }, source.block, entry.stateEvidence);
    if (state.rejectedPrior) return null;
    const call = state.snapshot()?.calls.find(value => equal(value.to, tokenAddress) && value.data === decimalsSelector);
    if (!call || !/^0x[\da-f]{64}$/i.test(call.result)) return null;
    const decimals = Number(BigInt(call.result));
    // Slot3 starts at zero. A nonzero committed value proves its guarded
    // initializer already ran; zero precision needs a separate init proof.
    if (!Number.isInteger(decimals) || decimals < 1 || decimals > 255) return null;
    const normalizedBlock = (value: FreshMetadataRecoveryBlock): FreshMetadataRecoveryBlock => ({ number: value.number, hash: value.hash.toLowerCase(), timestamp: new Date(value.timestamp).toISOString() });
    return { decimals, proof: { version: 1, kind: 'initialized_immutable_decimals', auditId: FRESH_INITIALIZED_DECIMALS_AUDIT.id, chainId: 56,
      tokenAddress: tokenAddress.toLowerCase(), decimals, target: normalizedBlock(target),
      creation: { transactionHash: tx.hash.toLowerCase(), block: creationBlock, transactionIndex: tx.transactionIndex,
        creator: tx.from.toLowerCase(), nonce: tx.nonce, input: tx.input.toLowerCase(), runtimeHash: keccak256(`0x${tx.input.slice(22)}`) },
      source: { transactionHash: entry.transaction.hash.toLowerCase(), block: normalizedBlock(source.block), payloadSha256: sha256(source.payload),
        stateEvidenceSha256: sha256(JSON.stringify(entry.stateEvidence)), call: { to: tokenAddress.toLowerCase(), data: decimalsSelector, result: call.result } },
      implementation: { address: implementation.address.toLowerCase(), codeHash: FRESH_INITIALIZED_DECIMALS_AUDIT.codeHash,
        codeBytes: FRESH_INITIALIZED_DECIMALS_AUDIT.codeBytes, observedBlock: normalizedBlock(implementation.block),
        historicalCodeAnchor: 'committed_fixed_proxy_response_and_bsc_bep344' } } };
  } catch { return null; }
}

/** Serialized proof alone is never authority. Reload the referenced original
 * source payload and canonical creation/header/code contexts before reuse. */
export function revalidateFreshImmutableDecimalsProof(proof: unknown, input: FreshImmutableDecimalsRecoveryInput): proof is FreshImmutableDecimalsProof {
  try {
    const recovered = recoverFreshImmutableDecimals(input);
    const stable = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
    return recovered !== null && stable(recovered.proof) === stable(proof);
  } catch { return false; }
}

export interface FreshInitializedCallDecimalsInput {
 chainId:number;tokenAddress:string;target:FreshMetadataRecoveryBlock;targetTransactionIndex:number;
 creation:FreshImmutableDecimalsRecoveryInput['creation'];
 initialization:FreshImmutableDecimalsRecoveryInput['creation'];
 source:{tokenAddress:string;creation:FreshImmutableDecimalsRecoveryInput['creation'];payload:Buffer;block:FreshMetadataRecoveryBlock};
 implementation:FreshImmutableDecimalsRecoveryInput['implementation'];
}
const initializerTypes=['string','string','address','uint8','uint256','uint256','uint256','uint256','uint256'];
const ownershipTopic='0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0';
/** The exact audited implementation's sole precision write takes initializer
 * argument3 through its strict uint8 decoder. A successful direct initializer
 * and its zero->owner event establish that write, including explicit zero
 * precision. A genuinely earlier committed response through another exact
 * fixed proxy anchors the SAME full implementation before initialization;
 * equal decimals values alone are never used as a code/version proof. */
export function recoverFreshInitializedDecimalsFromCall(input:FreshInitializedCallDecimalsInput){
 try{
  const {target,creation,initialization,source,implementation,tokenAddress}=input;
  if(!address(tokenAddress)||!Number.isSafeInteger(input.targetTransactionIndex)||input.targetTransactionIndex<0||!validBlock(target))return null;
  const anchored=recoverFreshImmutableDecimals({chainId:input.chainId,tokenAddress:source.tokenAddress,target,creation:source.creation,source:{payload:source.payload,block:source.block},implementation});
  if(!anchored)return null;
  for(const context of [creation,initialization]){
   validateFreshBlock(context.block,Number(BigInt(context.block.number)));validateFreshReceipt(context.receipt,context.transaction,context.block);
   const included=context.block.transactions[Number(BigInt(context.transaction.transactionIndex))];
   if(!included||JSON.stringify(included)!==JSON.stringify(context.transaction)||context.receipt.status!=='0x1')return null;
  }
  const created=blockHeader(creation.block),initialized=blockHeader(initialization.block);
  if(!validBlock(created)||!validBlock(initialized)||created.number>initialized.number
   ||created.number===initialized.number&&Number(BigInt(creation.transaction.transactionIndex))>=Number(BigInt(initialization.transaction.transactionIndex))
   ||source.block.number>=initialized.number||initialized.number>target.number
   ||initialized.number===target.number&&Number(BigInt(initialization.transaction.transactionIndex))>input.targetTransactionIndex
   ||Date.parse(source.block.timestamp)>Date.parse(initialized.timestamp)||Date.parse(initialized.timestamp)>Date.parse(target.timestamp))return null;
  const tx=creation.transaction,receipt=creation.receipt;
  if(tx.to!==null||!quantity(tx.nonce)||!address(receipt.contractAddress)||!equal(receipt.contractAddress,tokenAddress)
   ||!equal(getCreateAddress({from:tx.from.toLowerCase(),nonce:BigInt(tx.nonce)}),tokenAddress)
   ||typeof tx.input!=='string'||!equal(tx.input,`0x3d602d80600a3d3981f3363d3d373d3d3d363d73${FRESH_INITIALIZED_DECIMALS_AUDIT.implementationAddress.slice(2)}5af43d82803e903d91602b57fd5bf3`))return null;
  const init=initialization.transaction;
  if(!init.to||!equal(init.to,tokenAddress)||BigInt(init.value)!==0n||typeof init.input!=='string'||!init.input.toLowerCase().startsWith(FRESH_INITIALIZED_DECIMALS_AUDIT.initializerSelector)||init.input.length>2+4096*2)return null;
  const abi=AbiCoder.defaultAbiCoder(),args=abi.decode(initializerTypes,'0x'+init.input.slice(10));
  if(!equal(FRESH_INITIALIZED_DECIMALS_AUDIT.initializerSelector+abi.encode(initializerTypes,args).slice(2),init.input))return null;
  const owner=String(args[2]).toLowerCase(),decimals=Number(args[3]);
  if(!address(owner)||!Number.isInteger(decimals)||decimals<0||decimals>255)return null;
  const events=initialization.receipt.logs.filter(log=>equal(log.address,tokenAddress)&&log.topics.length===3&&log.topics[0]===ownershipTopic
   &&log.topics[1]==='0x'+'0'.repeat(64)&&log.topics[2]==='0x'+owner.slice(2).padStart(64,'0')&&log.data==='0x');
  if(events.length!==1)return null;
  return{decimals,proof:{version:1 as const,kind:'initialized_precision_from_canonical_call' as const,auditId:FRESH_INITIALIZED_DECIMALS_AUDIT.id,chainId:56 as const,
   tokenAddress:tokenAddress.toLowerCase(),decimals,target:{...target},creation:{transactionHash:tx.hash.toLowerCase(),block:created,transactionIndex:tx.transactionIndex,creator:tx.from.toLowerCase(),nonce:tx.nonce,initcodeHash:keccak256(tx.input)},
   initialization:{transactionHash:init.hash.toLowerCase(),block:initialized,transactionIndex:init.transactionIndex,selector:FRESH_INITIALIZED_DECIMALS_AUDIT.initializerSelector,inputSha256:sha256(init.input.toLowerCase()),precisionArgument:3,ownerEventLogIndex:events[0].logIndex},
   source:{tokenAddress:source.tokenAddress.toLowerCase(),creation:anchored.proof.creation,...anchored.proof.source},implementation:anchored.proof.implementation}};
 }catch{return null;}
}
function blockHeader(block:FreshBlock):FreshMetadataRecoveryBlock{return{number:Number(BigInt(block.number)),hash:block.hash.toLowerCase(),timestamp:new Date(Number(BigInt(block.timestamp))*1000).toISOString()};}
