import { gunzipSync } from 'node:zlib';
import { AbiCoder, getCreateAddress, keccak256 } from 'ethers';
import { describe, expect, it } from 'vitest';
import { encodeFreshEvidence, type FreshCapturedReceipt } from './capture.js';
import { FRESH_INITIALIZED_DECIMALS_AUDIT, recoverFreshImmutableDecimals, recoverFreshInitializedDecimalsFromCall, revalidateFreshImmutableDecimalsProof, type FreshImmutableDecimalsRecoveryInput,type FreshInitializedCallDecimalsInput } from './metadataRecovery.js';

// Exact public implementation bytecode, compressed solely to keep this test
// fixture compact. Tests never fetch code or metadata from the network.
const implementationCode = gunzipSync(Buffer.from('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', 'base64')).toString();
const h = (digit: string) => `0x${digit.repeat(64)}`, creator = `0x${'1'.repeat(40)}`;
const header = (number: number, digit: string) => ({ number, hash: h(digit), timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, number)).toISOString() });
function fixture(): FreshImmutableDecimalsRecoveryInput {
  const audit = FRESH_INITIALIZED_DECIMALS_AUDIT, creationHeader = header(100, 'a'), source = header(110, 'b'), target = header(120, 'c');
  const transaction = { hash: h('d'), from: creator, to: null, nonce: '0x0', value: '0x0', input: `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${audit.implementationAddress.slice(2)}5af43d82803e903d91602b57fd5bf3`,
    blockHash: creationHeader.hash, blockNumber: '0x64', transactionIndex: '0x0', gasPrice: '0x1' };
  const tokenAddress = getCreateAddress({ from: creator, nonce: 0 }).toLowerCase();
  const receipt = { transactionHash: transaction.hash, blockHash: transaction.blockHash, blockNumber: transaction.blockNumber, transactionIndex: '0x0',
    status: '0x1', contractAddress: tokenAddress, gasUsed: '0x10000', effectiveGasPrice: '0x1', logs: [] };
  const entry: FreshCapturedReceipt = { transaction: { hash: h('e'), from: creator, to: tokenAddress, value: '0x0', blockHash: source.hash, blockNumber: '0x6e', transactionIndex: '0x0' },
    receipt: { transactionHash: h('e'), blockHash: source.hash, blockNumber: '0x6e', transactionIndex: '0x0', status: '0x1', gasUsed: '0x1', logs: [] },
    wallets: [creator], observedAt: source.timestamp,
    stateEvidence: { version: 1, blockNumber: source.number, blockHash: source.hash,
      calls: [{ to: tokenAddress, data: '0x313ce567', result: `0x${'9'.padStart(64, '0')}` }] } };
  return { chainId: 56, tokenAddress, target, creation: { transaction, receipt, block: { number: '0x64', hash: creationHeader.hash, parentHash: h('f'),
    timestamp: `0x${(BigInt(Date.parse(creationHeader.timestamp)) / 1000n).toString(16)}`, transactions: [transaction] } }, source: { payload: encodeFreshEvidence(entry), block: source },
    implementation: { address: audit.implementationAddress, code: implementationCode, block: header(130, '9') } };
}

function alterSource(value: FreshImmutableDecimalsRecoveryInput, mutate: (entry: FreshCapturedReceipt) => void) {
  // This helper deliberately re-encodes a valid checksum so rejection tests
  // exercise foreign/invalid evidence, not just accidental byte corruption.
  const raw = JSON.parse(gunzipSync(value.source.payload.subarray(36)).toString());
  mutate(raw); value.source.payload = encodeFreshEvidence(raw);
}

function initializedFixture(decimals=9):FreshInitializedCallDecimalsInput{
 const source=fixture(),created=header(112,'2'),initialized=header(115,'3'),token=getCreateAddress({from:creator,nonce:1}).toLowerCase();
 const tx={...source.creation.transaction,hash:h('4'),nonce:'0x1',blockHash:created.hash,blockNumber:'0x70'};
 const creation={transaction:tx,receipt:{...source.creation.receipt,transactionHash:tx.hash,contractAddress:token,blockHash:created.hash,blockNumber:tx.blockNumber},block:{...source.creation.block,number:tx.blockNumber,hash:created.hash,timestamp:`0x${(BigInt(Date.parse(created.timestamp))/1000n).toString(16)}`,transactions:[tx]}};
 const abi=AbiCoder.defaultAbiCoder(),args=['First','F',creator,decimals,1000,0,10000,56,1];
 const initTx={...tx,hash:h('5'),to:token,nonce:'0x2',input:FRESH_INITIALIZED_DECIMALS_AUDIT.initializerSelector+abi.encode(['string','string','address','uint8','uint256','uint256','uint256','uint256','uint256'],args).slice(2),blockHash:initialized.hash,blockNumber:'0x73'};
 const ownership={address:token,topics:['0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0',h('0'),`0x${creator.slice(2).padStart(64,'0')}`],data:'0x',blockHash:initialized.hash,blockNumber:initTx.blockNumber,transactionHash:initTx.hash,transactionIndex:'0x0',logIndex:'0x0'};
 const initialization={transaction:initTx,receipt:{...creation.receipt,transactionHash:initTx.hash,contractAddress:null,blockHash:initialized.hash,blockNumber:initTx.blockNumber,logs:[ownership]},block:{...creation.block,number:initTx.blockNumber,hash:initialized.hash,timestamp:`0x${(BigInt(Date.parse(initialized.timestamp))/1000n).toString(16)}`,transactions:[initTx]}};
 return{chainId:56,tokenAddress:token,target:source.target,targetTransactionIndex:0,creation,initialization,source:{tokenAddress:source.tokenAddress,creation:source.creation,payload:source.source.payload,block:source.source.block},implementation:source.implementation};
}

describe('write-once precision from a canonical successful direct initializer',()=>{
 it('pins the strict nine-argument decoder and argument3 to the sole precision write',()=>{
  const bytes=Buffer.from(implementationCode.slice(2),'hex');
  expect(bytes.subarray(0x39a4,0x39b1).toString('hex')).toBe('60606139b18c828d0161390756');
  // The nine ABI values remain on the stack: name/symbol/owner/precision.
  expect([bytes[0x1345],bytes[0x1355],bytes[0x1365],bytes[0x1382]]).toEqual([0x88,0x87,0x86,0x85]);
  expect(bytes[0x139a]).toBe(0x55);expect(bytes[0x133b]).toBe(0x55);
 });
 it('uses a different token only to anchor exact implementation code; target calldata proves its own precision',()=>{
  const x=initializedFixture(6),r=recoverFreshInitializedDecimalsFromCall(x);expect(r?.decimals).toBe(6);expect(r?.proof.kind).toBe('initialized_precision_from_canonical_call');
  expect(r?.proof.source.tokenAddress).not.toBe(r?.proof.tokenAddress);expect(r?.proof.source.call.result).toBe(`0x${'9'.padStart(64,'0')}`);
  expect(r).not.toHaveProperty('supplyRaw');expect(r).not.toHaveProperty('price');
 });
 it('permits explicitly initialized zero precision without converting an uninitialized getter into proof',()=>{expect(recoverFreshInitializedDecimalsFromCall(initializedFixture(0))?.decimals).toBe(0);});
 it('rejects future/code-unanchored initialization, wrong target/chain/runtime, failed or wrapped calls and altered ownership evidence',()=>{
  for(const mutate of [(x:any)=>x.chainId=1,(x:any)=>x.source.block=header(116,'3'),(x:any)=>x.initialization.receipt.status='0x0',(x:any)=>x.initialization.transaction.to=creator,
   (x:any)=>x.initialization.receipt.logs[0].topics[2]=h('0'),(x:any)=>x.initialization.transaction.input+='00',(x:any)=>x.implementation.code='0x6000',(x:any)=>x.creation.transaction.input+='00']){
   const x=initializedFixture();mutate(x);expect(recoverFreshInitializedDecimalsFromCall(x)).toBeNull();
  }
 });
 it('rejects an initializer after the selected execution in its same block',()=>{
  const x=initializedFixture();x.target={...header(115,'3')};x.initialization.transaction.transactionIndex='0x1';x.initialization.receipt.transactionIndex='0x1';x.initialization.receipt.logs[0].transactionIndex='0x1';
  const prior={...x.initialization.transaction,hash:h('6'),transactionIndex:'0x0'};x.initialization.block.transactions=[prior,x.initialization.transaction];
  expect(recoverFreshInitializedDecimalsFromCall(x)).toBeNull();
 });
 it('rejects an initializer ordered before its own creation within the same block',()=>{
  const x=initializedFixture(),b=x.initialization.block;
  x.creation.transaction={...x.creation.transaction,blockHash:b.hash,blockNumber:b.number,transactionIndex:'0x1'};
  x.creation.receipt={...x.creation.receipt,blockHash:b.hash,blockNumber:b.number,transactionIndex:'0x1'};
  b.transactions=[x.initialization.transaction,x.creation.transaction];x.creation.block=b;
  expect(recoverFreshInitializedDecimalsFromCall(x)).toBeNull();
 });
});

describe('historical immutable decimals from an earlier canonical raw read', () => {
  it('pins the exact audited runtime and its complete storage-write manifest', () => {
    const audit = FRESH_INITIALIZED_DECIMALS_AUDIT, bytes = Buffer.from(implementationCode.slice(2), 'hex'), stores: number[] = [], codeEnd = bytes.length - 53;
    expect(bytes.length).toBe(19726); expect(keccak256(implementationCode)).toBe(audit.codeHash);
    const slotThreeLiterals: number[] = [];
    for (let pc = 0; pc < codeEnd; pc++) {
      const op = bytes[pc]; if (op === 0x55) stores.push(pc);
      if (op === 0x60 && bytes[pc + 1] === 3) slotThreeLiterals.push(pc);
      expect([0xf0, 0xf2, 0xf4, 0xf5, 0xff]).not.toContain(op);
      if (op >= 0x60 && op <= 0x7f) pc += op - 0x5f;
    }
    expect(stores).toEqual(audit.storageWritePcs); expect(slotThreeLiterals).toEqual([0xaec, 0x1383]);
    // Getter storage read, one-time guard, flag-before-precision write order.
    expect(bytes.subarray(0xaea, 0xaff).toString('hex')).toBe('5b5f60035f9054906101000a900460ff1690509056');
    expect(bytes.subarray(0x11ff, 0x1219).toString('hex')).toBe('5b5f600960159054906101000a900460ff1660ff161461125357');
    expect(audit.initializedFlagWritePc).toBeLessThan(audit.precisionWritePc);
    expect(bytes[audit.initializedFlagWritePc]).toBe(0x55); expect(bytes[audit.precisionWritePc]).toBe(0x55);
  });

  it('derives precision while keeping the original read and target blocks distinct', () => {
    const input = fixture(), recovered = recoverFreshImmutableDecimals(input);
    expect(recovered?.decimals).toBe(9);
    expect(recovered?.proof).toMatchObject({ version: 1, kind: 'initialized_immutable_decimals', chainId: 56, tokenAddress: input.tokenAddress, decimals: 9,
      source: { transactionHash: h('e'), block: input.source.block, call: { to: input.tokenAddress, data: '0x313ce567', result: `0x${'9'.padStart(64, '0')}` } },
      target: input.target, implementation: { address: input.implementation.address, codeHash: FRESH_INITIALIZED_DECIMALS_AUDIT.codeHash,
        historicalCodeAnchor: 'committed_fixed_proxy_response_and_bsc_bep344' } });
    expect(recovered?.proof.source.payloadSha256).toMatch(/^[\da-f]{64}$/);
    expect(recovered?.proof.creation.runtimeHash).toBe(keccak256(`0x${input.creation.transaction.input!.toString().slice(22)}`));
    expect(recovered).not.toHaveProperty('supplyRaw'); expect(recovered).not.toHaveProperty('price');
    expect(recovered?.proof).not.toHaveProperty('wallets');
  });

  it('rejects mutated/mutable implementation code and mismatched proxy targets or constructor wrappers', () => {
    for (const pc of [0xaea, 0x1206, 0x133b, 0x139a, 0x2fc9]) {
      const input = fixture(), bytes = Buffer.from(input.implementation.code.slice(2), 'hex'); bytes[pc] ^= 1;
      input.implementation.code = `0x${bytes.toString('hex')}`; expect(recoverFreshImmutableDecimals(input)).toBeNull();
    }
    const foreign = fixture(); foreign.implementation.address = creator; expect(recoverFreshImmutableDecimals(foreign)).toBeNull();
    const pointer = fixture(); pointer.creation.transaction.input = pointer.creation.transaction.input!.toString().replace(FRESH_INITIALIZED_DECIMALS_AUDIT.implementationAddress.slice(2), creator.slice(2));
    expect(recoverFreshImmutableDecimals(pointer)).toBeNull();
    const wrapper = fixture(); wrapper.creation.transaction.input = `${wrapper.creation.transaction.input}00`; expect(recoverFreshImmutableDecimals(wrapper)).toBeNull();
  });

  it('rejects noncanonical creation references, failed creation, wrong CREATE address and missing indexed transaction', () => {
    const mutations: ((input: FreshImmutableDecimalsRecoveryInput) => void)[] = [
      input => { input.creation.receipt.status = '0x0'; }, input => { input.creation.receipt.blockHash = h('8'); },
      input => { input.creation.receipt.contractAddress = creator; }, input => { input.creation.transaction.to = creator; },
      input => { input.creation.transaction.nonce = '0x1'; }, input => { input.creation.block.transactions = []; },
      input => { input.creation.transaction = { ...input.creation.transaction, input: '0x00' }; },
    ];
    for (const mutate of mutations) { const input = fixture(); mutate(input); expect(recoverFreshImmutableDecimals(input)).toBeNull(); }
  });

  it('rejects zero/uninitialized precision, invalid ABI, foreign selectors/tokens and missing saved reads', () => {
    const mutations: ((entry: FreshCapturedReceipt) => void)[] = [
      entry => { entry.stateEvidence!.calls[0].result = `0x${'0'.repeat(64)}`; },
      entry => { entry.stateEvidence!.calls[0].result = `0x${'100'.padStart(64, '0')}`; },
      entry => { entry.stateEvidence!.calls[0].result = '0x09'; },
      entry => { entry.stateEvidence!.calls[0].result += '00'; },
      entry => { entry.stateEvidence!.calls[0].data = '0x18160ddd'; },
      entry => { entry.stateEvidence!.calls[0].to = creator; },
      entry => { entry.stateEvidence!.calls = []; }, entry => { delete entry.stateEvidence; },
    ];
    for (const mutate of mutations) { const input = fixture(); alterSource(input, mutate); expect(recoverFreshImmutableDecimals(input)).toBeNull(); }
  });

  it('rejects cross-block/corrupt captured evidence instead of reading current metadata', () => {
    const corrupt = fixture(); corrupt.source.payload[12] ^= 255; expect(recoverFreshImmutableDecimals(corrupt)).toBeNull();
    const foreign = fixture(); alterSource(foreign, entry => { entry.stateEvidence!.blockHash = h('8'); }); expect(recoverFreshImmutableDecimals(foreign)).toBeNull();
    const headerMismatch = fixture(); headerMismatch.source.block.hash = h('8'); expect(recoverFreshImmutableDecimals(headerMismatch)).toBeNull();
    const duplicate = fixture(); alterSource(duplicate, entry => { entry.stateEvidence!.calls.push({ ...entry.stateEvidence!.calls[0] }); }); expect(recoverFreshImmutableDecimals(duplicate)).toBeNull();
  });

  it('rejects unsupported chain/metamorphic history assumptions and a future-only/current decimals source', () => {
    const chain = fixture(); chain.chainId = 97; expect(recoverFreshImmutableDecimals(chain)).toBeNull();
    const preHaber = fixture(); preHaber.source.block.timestamp = '2024-06-19T00:00:00Z'; expect(recoverFreshImmutableDecimals(preHaber)).toBeNull();
    const current = fixture(); current.source.block = current.target; expect(recoverFreshImmutableDecimals(current)).toBeNull();
    const oldCode = fixture(); oldCode.implementation.block = oldCode.source.block; expect(recoverFreshImmutableDecimals(oldCode)).toBeNull();
    const malformed = fixture(); malformed.implementation.block.hash = 'latest'; expect(recoverFreshImmutableDecimals(malformed)).toBeNull();
  });

  it('revalidates serialized proofs only against the original contexts, allowing JSONB key order changes', () => {
    const input = fixture(), proof = recoverFreshImmutableDecimals(input)!.proof;
    expect(revalidateFreshImmutableDecimalsProof(proof, input)).toBe(true);
    const reordered = JSON.parse(JSON.stringify(proof), (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value);
    expect(revalidateFreshImmutableDecimalsProof(reordered, input)).toBe(true);
    expect(revalidateFreshImmutableDecimalsProof({ ...proof, decimals: 18 }, input)).toBe(false);
    expect(revalidateFreshImmutableDecimalsProof({ ...proof, extra: true }, input)).toBe(false);
    expect(revalidateFreshImmutableDecimalsProof(proof, { ...input, source: { ...input.source, payload: Buffer.from('not original evidence') } })).toBe(false);
  });
});
