import { gunzipSync } from 'node:zlib';
import { Interface, zeroPadValue } from 'ethers';
import { describe, expect, it } from 'vitest';
import type { FreshCapturedReceipt } from './capture.js';
import { freshStockwaveBridgeFee } from './bridgeFee.js';

const token = '0xe36ae6bc18726a84db820ec49dd866145df5a149';
const other = '0x1111111111111111111111111111111111111111';
const fee = 2233912722283742n;
const abi = new Interface([
  'function send((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) param,(uint256 nativeFee,uint256 lzTokenFee) fee,address refundAddress) payable',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'event OFTSent(bytes32 indexed guid,uint32 dstEid,address indexed fromAddress,uint256 amountSentLD,uint256 amountReceivedLD)',
  'event ExecutorFeePaid(address executor,uint256 fee)',
  'event DVNFeePaid(address[] requiredDVNs,address[] optionalDVNs,uint256[] fees)',
  'event PacketSent(bytes encodedPayload,bytes options,address sendLibrary)',
]);

// Recorded BSC receipt 129183304, tx 0x3618320d...aef0b2d8. Only public
// transaction/receipt fields remain; trace and state reads are omitted. The five
// original logs and calldata are retained without re-encoding. Packet layouts:
// https://github.com/LayerZero-Labs/LayerZero-v2/blob/main/packages/layerzero-v2/evm/protocol/contracts/libs/GUID.sol
// https://github.com/LayerZero-Labs/devtools/blob/main/packages/oft-evm/contracts/libs/OFTMsgCodec.sol
const recorded = 'H4sIAAAAAAACCu2YwW4cNwyG32XOm0KkREryLaeml6KH9NIiB1IkE6Nrr7E7dg0Efvdi1kmaNLHjeJ2kAczjCKQ41D/fkHo9zVs53cmYjzen09Hr6ZXsXk1HU7rMDC1jMiXKkJJqGbl6sGsNzQ0VjZOZBgWXHl6jJy1M4pEUrU2rKbabk+tYpUYMNu0yBhUZmKDXTlCzdurdmzZU69Nqmjd7D88szjqgVWRpxbRh8lG6WWOGQhYkUBaPC1mf+96peqgSF6JhPq2m49Oz83m/MuqoQZrTQdbu4/RBUukr2V0LfMgelTp9w/1RKKqMntir9DIqfFm6h/p/wg48vkMTAEw/uk2rSdeb8dezt5QZtVaCVIR78lKlhFBgKjY6F0rAmEhbbgtjkDC3IYE5EWiCgSW/Dfjr+Yn69poCmtHLwp/30PbLqfnlfhkXZryU3W/b43GNjYyw7DNdraatDz8+mxcQvuf87AGZeHNO37Awu1nm893+IVxX4/ed2/UrBgtOq8kjfMzHF/7zp0q1msbmdN7KmJ+abX23m45Oz9fr1bTevNxNR3++nuTt8y+D+bw5Ox5LhCldmgUSioE6jtaV+0BN3GLk2kykE6rUAM6jyJJXCyIpFoRZs8e0mtLlocS6NcidZf9iNZnMsq/GoQy7q+R/ZNU+Pz7x3SwnZ/uoLCYUeVldb17+mwAvCWz9ZHOxiDdkvfOr1YfS69EGFwq0pAjUK1c19tRyNy/qpXvDvO8W3pceg1vq3WuRXgWsRlNNnVBaG9K0anO1lAYgu6TCFaKjNEDIGZrc6cCzq1FNbrkpaNaiozXuvccIStW7USuN7vPTrg2LNWcRZn0UzDvByNcSTKouhNYwFzL2lht0hFSthVXAbH2gj+YdeFgSMchhqJxMsXAp9yXEJ4wPhNX4vl1SSje2ORmiliaZm7Se1ZRElauPToEZKVVOIPXGLj+MG9NoBQYaF2IixhijeiJn6JITA8X3bpLu1eZlruThlVuD+/lHtRq5WOAjMN4BQz8LDJBSFuFRAqSGC669Zh6UIBr1QSm8Yhv/AQaI1pSsDLfliyMFLiNFbT0s9RiqCYitDEwFtEnW0GGdYRgQ1/j/AOOWseSuMD0sgd4/Gq36m4H1xle7a0v6ucGXVZZjDvU6iLtUorJ0A6kkrO44iKB7FalFXLBbT33gYFSOpqWWbMxaAitVwkRMJSDAwa2YyNIBO9YcDzJ4o3d2h9wQHpJXsFQ5L2cAcOuQC1bGrWPhI3B4fBY495ymGpXOWjlJ0RrNmHMr2i0QNDcIMlDw2gOxS6kiUQZmdBsYTl32g9ChMn6Ykeyh0Hfbh/2tbqQepf9O+vax9F9craa/Zb32+Y2Kv0QjG9359sLt6XIHjAn5CaQniM+hH6V2lOmnlNIf09U/47CukQMXAAA=';
function fixture(): FreshCapturedReceipt {
  return JSON.parse(gunzipSync(Buffer.from(recorded, 'base64'), { maxOutputLength: 32_768 }).toString());
}
function log(entry: FreshCapturedReceipt, name: string) {
  return entry.receipt.logs.find(item => item.topics[0] === abi.getEvent(name)!.topicHash)!;
}
function event(entry: FreshCapturedReceipt, name: string, mutate: (args: unknown[]) => void) {
  const item = log(entry, name), parsed = abi.parseLog(item)!;
  const args: unknown[] = Array.from(parsed.args, value => Array.isArray(value) ? Array.from(value) : value);
  mutate(args); Object.assign(item, abi.encodeEventLog(parsed.fragment, args));
}
function call(entry: FreshCapturedReceipt, param: Record<number, unknown> = {}, fees: Record<number, unknown> = {}, refund?: string) {
  const args = abi.decodeFunctionData('send', entry.transaction.input as string);
  entry.transaction.input = abi.encodeFunctionData('send', [Object.assign(Array.from(args[0]), param), Object.assign(Array.from(args[1]), fees), refund ?? args[2]]);
}
function packet(entry: FreshCapturedReceipt, mutate: (bytes: Buffer) => void) {
  event(entry, 'PacketSent', args => { const bytes = Buffer.from((args[0] as string).slice(2), 'hex'); mutate(bytes); args[0] = `0x${bytes.toString('hex')}`; });
}

describe('authenticated Stockwave native LayerZero fee', () => {
  it('recovers the real executor and DVN cost once, independently of transaction gas', () => {
    const entry = fixture();
    expect(entry.transaction.hash).toBe('0x3618320db553100bb4c37ef6eb7fb382b2d60ddbf5f649fe7f90b465aef0b2d8');
    expect(Number(BigInt(entry.receipt.blockNumber))).toBe(129183304);
    expect(entry.receipt.logs).toHaveLength(5);
    expect(freshStockwaveBridgeFee(entry, token)).toBe(fee);
    entry.receipt.gasUsed = '0x1'; entry.receipt.effectiveGasPrice = '0x2';
    expect(freshStockwaveBridgeFee(entry, token)).toBe(fee);
  });

  it('returns zero for transactions outside this token send entrypoint', () => {
    const entry = fixture(); entry.transaction.to = other;
    expect(freshStockwaveBridgeFee(entry, token)).toBe(0n);
    entry.transaction.to = token; entry.transaction.input = '0xa9059cbb';
    expect(freshStockwaveBridgeFee(entry, token)).toBe(0n);
  });

  it('allows OFT dust removal while enforcing the signed minimum', () => {
    const entry = fixture(), args = abi.decodeFunctionData('send', entry.transaction.input as string);
    call(entry, { 2: BigInt(args[0][2]) + 999_999_999_999n });
    expect(freshStockwaveBridgeFee(entry, token)).toBe(fee);
    call(entry, { 3: BigInt(args[0][2]) + 1n });
    expect(freshStockwaveBridgeFee(entry, token)).toBeNull();
  });

  it('requires agreement on a recipient without assuming a self transfer', () => {
    const entry = fixture(); call(entry, { 1: zeroPadValue(other, 32) });
    packet(entry, bytes => { Buffer.from(zeroPadValue(other, 32).slice(2), 'hex').copy(bytes, 113); });
    expect(freshStockwaveBridgeFee(entry, token)).toBe(fee);
  });

  it.each(['Transfer', 'OFTSent', 'ExecutorFeePaid', 'DVNFeePaid', 'PacketSent'])('rejects missing, duplicate or foreign %s evidence', name => {
    for (const kind of ['missing', 'duplicate', 'foreign']) {
      const entry = fixture(), item = log(entry, name);
      if (kind === 'missing') entry.receipt.logs = entry.receipt.logs.filter(value => value !== item);
      else if (kind === 'duplicate') entry.receipt.logs.push({ ...item, topics: [...item.topics], logIndex: '0x6e' });
      else item.address = other;
      expect(freshStockwaveBridgeFee(entry, token), kind).toBeNull();
    }
  });

  it.each([
    ['failed receipt', (e: FreshCapturedReceipt) => { e.receipt.status = '0x0'; }],
    ['refunded to another wallet', (e: FreshCapturedReceipt) => call(e, {}, {}, other)],
    ['LZ token payment', (e: FreshCapturedReceipt) => call(e, {}, { 1: 1n })],
    ['unsupported compose message', (e: FreshCapturedReceipt) => call(e, { 5: '0x1234' })],
    ['unsupported OFT command', (e: FreshCapturedReceipt) => call(e, { 6: '0x01' })],
    ['signed fee differs from value', (e: FreshCapturedReceipt) => call(e, {}, { 0: fee + 1n })],
    ['native value exceeds worker payments', (e: FreshCapturedReceipt) => { e.transaction.value = `0x${(fee + 1n).toString(16)}`; call(e, {}, { 0: fee + 1n }); }],
    ['worker fee differs', (e: FreshCapturedReceipt) => event(e, 'ExecutorFeePaid', a => { a[1] = BigInt(a[1] as bigint) + 1n; })],
    ['DVN fee vector differs', (e: FreshCapturedReceipt) => event(e, 'DVNFeePaid', a => { a[2] = []; })],
    ['unknown send library', (e: FreshCapturedReceipt) => event(e, 'PacketSent', a => { a[2] = other; })],
    ['OFT source wallet differs', (e: FreshCapturedReceipt) => event(e, 'OFTSent', a => { a[2] = other; })],
    ['OFT destination differs', (e: FreshCapturedReceipt) => event(e, 'OFTSent', a => { a[1] = 30184n; })],
    ['burn amount differs', (e: FreshCapturedReceipt) => event(e, 'Transfer', a => { a[2] = BigInt(a[2] as bigint) - 1n; })],
    ['burn recipient differs', (e: FreshCapturedReceipt) => event(e, 'Transfer', a => { a[1] = other; })],
    ['removed burn', (e: FreshCapturedReceipt) => { log(e, 'Transfer').removed = true; }],
    ['removed worker event', (e: FreshCapturedReceipt) => { log(e, 'ExecutorFeePaid').removed = true; }],
    ['noncanonical burn encoding', (e: FreshCapturedReceipt) => { const item = log(e, 'Transfer'); item.data = `0x0${item.data.slice(2)}`; }],
    ['noncanonical event suffix', (e: FreshCapturedReceipt) => { log(e, 'OFTSent').data += '00'; }],
    ['noncanonical calldata suffix', (e: FreshCapturedReceipt) => { e.transaction.input += '00'; }],
    ['truncated packet', (e: FreshCapturedReceipt) => event(e, 'PacketSent', a => { a[0] = '0x01'; })],
    ['packet version differs', (e: FreshCapturedReceipt) => packet(e, b => { b[0] = 2; })],
    ['packet source EID differs', (e: FreshCapturedReceipt) => packet(e, b => { b.writeUInt32BE(30101, 9); })],
    ['packet sender differs', (e: FreshCapturedReceipt) => packet(e, b => { b[44] ^= 1; })],
    ['packet destination EID differs', (e: FreshCapturedReceipt) => packet(e, b => { b.writeUInt32BE(30184, 45); })],
    ['packet GUID differs', (e: FreshCapturedReceipt) => packet(e, b => { b[112] ^= 1; })],
    ['matching forged packet and OFT GUID', (e: FreshCapturedReceipt) => {
      const forged = `0x${'ab'.repeat(32)}`;
      event(e, 'OFTSent', a => { a[0] = forged; });
      packet(e, b => { Buffer.from(forged.slice(2), 'hex').copy(b, 81); });
    }],
    ['packet nonce differs', (e: FreshCapturedReceipt) => packet(e, b => { b[8] ^= 1; })],
    ['packet receiver differs', (e: FreshCapturedReceipt) => packet(e, b => { b[80] ^= 1; })],
    ['signed token recipient differs', (e: FreshCapturedReceipt) => call(e, { 1: zeroPadValue(other, 32) })],
    ['packet token recipient differs', (e: FreshCapturedReceipt) => packet(e, b => { b[144] ^= 1; })],
    ['packet amount differs', (e: FreshCapturedReceipt) => packet(e, b => { b[152] ^= 1; })],
    ['signed amount below burn', (e: FreshCapturedReceipt) => call(e, { 2: 1n })],
    ['received amount below signed minimum', (e: FreshCapturedReceipt) => event(e, 'OFTSent', a => { a[4] = 1n; })],
  ])('leaves %s unknown', (_name, mutate) => {
    const entry = fixture(); mutate(entry); expect(freshStockwaveBridgeFee(entry, token)).toBeNull();
  });
});
