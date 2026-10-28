import { getCreateAddress, keccak256 } from 'ethers';
import { describe, expect, it } from 'vitest';
import type { FreshBlock, FreshReceipt, FreshTransaction } from './capture.js';
import { classifyFreshPinnedCreationToken as classifyFreshCreationToken, FRESH_IMMUTABLE_NONLEDGER_TEMPLATES, FRESH_LITERAL_NONLEDGER_TEMPLATES, FRESH_NONLEDGER_TEMPLATES } from './tokenAuthenticity.js';
import { FRESH_USDC_NONLEDGER_CREATION } from './usdcNonledgerCreation.fixture.js';
import { FRESH_BNB_LITERAL_NONLEDGER_CREATION } from './bnbLiteralNonledgerCreation.fixture.js';
import { FRESH_BNB_CONTROLLER_NONLEDGER_CREATION } from './bnbNonledgerCreation.fixture.js';

const hash = (digit: string) => `0x${digit.repeat(64)}`;
function fixture(initcode: string, nonce = '0x0') {
  const transaction: FreshTransaction = { hash: hash('a'), from: `0x${'1'.repeat(40)}`, to: null, nonce, value: '0x0', input: initcode,
    blockHash: hash('b'), blockNumber: '0x65', transactionIndex: '0x0' };
  const block: FreshBlock = { number: transaction.blockNumber, hash: transaction.blockHash, parentHash: hash('c'), timestamp: '0x69000000', transactions: [transaction] };
  const receipt: FreshReceipt = { transactionHash: transaction.hash, blockHash: transaction.blockHash, blockNumber: transaction.blockNumber,
    transactionIndex: transaction.transactionIndex, status: '0x1', contractAddress: getCreateAddress({ from: transaction.from, nonce }), gasUsed: '0x80000', logs: [] };
  return { transaction, receipt, block };
}

// Public canonical creation identities captured from the own node. Unrelated
// transactions retain only their hashes; the full creation occupies its actual
// indexed position. Initcode is the separately pinned complete literal above.
const capturedImmutableCreations = [
  {
    "templateIndex": 0,
    "transaction": {
      "hash": "0xd261510b98009f17972ce998c2ff45e4725d9a0f26d07d661b8fdb078a10b40c",
      "from": "0xaaf5d91d2c2aced59231b857f3ed24aab1b7a74f",
      "to": null,
      "nonce": "0x9",
      "value": "0x0",
      "blockHash": "0x7156ba0dfbb4fb39e37deea41767c99f7d27cf031034c42e76248a2ca9946404",
      "blockNumber": "0x7b37921",
      "transactionIndex": "0xa"
    },
    "receipt": {
      "transactionHash": "0xd261510b98009f17972ce998c2ff45e4725d9a0f26d07d661b8fdb078a10b40c",
      "blockHash": "0x7156ba0dfbb4fb39e37deea41767c99f7d27cf031034c42e76248a2ca9946404",
      "blockNumber": "0x7b37921",
      "transactionIndex": "0xa",
      "status": "0x1",
      "contractAddress": "0xc2e9f0061ae4ff415194aae2275c53820402fdf6",
      "gasUsed": "0x425b4"
    },
    "block": {
      "number": "0x7b37921",
      "hash": "0x7156ba0dfbb4fb39e37deea41767c99f7d27cf031034c42e76248a2ca9946404",
      "parentHash": "0x8a59ba3c28607f8ef1b47b9d26839fc8253aaf0d0027d887506271d76b9731fd",
      "timestamp": "0x6ada80e2"
    },
    "transactionHashes": [
      "0xadfa8f14498c5d90b0eb8ca4c9f0ba3bf08d5f0e422bc05edda597152131b99d",
      "0xfd0b434818e6d2d5cf0f0ee9bb1a7acc44b7134a7fb62df5d99098e0f44c0f5c",
      "0x147451b47547cc4393c1f8064481f2e676cc83b443681345536c48cbf12a5b94",
      "0x7ef74de94bf8af59d74a26407bfc2297d9c4d84142c886e571226fea4262e25d",
      "0x7e9effd1b37384d3bbd20568eacbbff329b46edcea3ca866919bec913318a5a5",
      "0x81e1864e895bca637573375da087667c42253d07525ebd9565f163c60dcb1777",
      "0xfd6c52be46cdb1cab8ed5c8086d8bba615fd6ad38388f124e4afcbbef1bc2049",
      "0xa0e8fd713276360a386a772d270411b4b54a2349cd2dfb8b30441f0cef68f44e",
      "0x154df2236996c2a48e099673558009c6338f0723822308a2f04c61501b6b9c65",
      "0x217f8ade2484380921f481b95c00b5bc3770a1109fdb984f9e915ac04c6acfdf",
      "0xd261510b98009f17972ce998c2ff45e4725d9a0f26d07d661b8fdb078a10b40c",
      "0x8e7bbb6ce6254cacb2be6e488f1fdd18a4604becb469b5eabf1dc1db7cf586e7",
      "0x9da4cfbe6cdf887e33bb81e7ff944039b29c31852d032232f311a7c4e2b15555",
      "0xf29d66ddc71c07597925aafdbd22fa41742e0a5aa575edb0c7d09d2224e40179",
      "0x4aba51130cb980cec509574c9d6758ba4ffa77fcb19dba60d7284199ce5962a6",
      "0xb561ba1aef9e1fff7237c6dc651053d9ce2c2036ab35e9f2499deab592863fa6",
      "0x5cdbc3c20d973a053dbca2e5d0dbebb3c15a37cf15b4264854e4ebcccfe84599",
      "0x9db64c930882bd7a5048599405e2c578398144bc026e840162c9e0ee13dd1697",
      "0x87f600c2ee578a7560f5237f744af17ac5308ad76e74a8b799245a1aec899350",
      "0xc34ba7740619e1699803574b96a1daa1b8fe364e96128923f6b94714dde19a36",
      "0x26c99998ee821f1bc3ad5c4737aeb5c3dc888152a436d64e281823b149768bfe",
      "0x9f1a33b3a6a015f21e2bd5b0fd92bdbb018b96e9dd1c9ab7410773e3bae0dc07",
      "0xe4cddd71fda54440dc90520a4552f4add4bd9316c115f02c6f0549c57dd9296f",
      "0xb042bf8529c2c3a4c8052f036f81491b7f4c3ea3e6dea05189e920e4008fdd4f",
      "0xda1d19347f4a0bad4f34b4a728270d53d6929b17779de9bdef53ccc7f6ba55ea",
      "0x5bb5dd7adf631a11a468a6ac87d066d6f52fbee0c934a0b102387f323b9aa3fc",
      "0xce70eb0a9f4c5c46ee89b188d62744601f67d7dc815d46fb2c881cd27376fca7",
      "0xb4ca352d0edc9020bd7832df8446b25341a564827f4e1bc446ca20f9ab75b576",
      "0x055cae1d208b6613df9867c6764c3065b0adfa95c1d1ca42979c5aaadcc0676d",
      "0x64d8b7041a0354edf9b02e6a5f78427f651c0882ebd190eca6b5f21e38463ed2",
      "0xe168dfd6812a614eab3f11f3ea177d9e6e82ee5d9c9ebc8fc8d804d36598be7f",
      "0x7567b743f741e50568da1ab38f3d3bc2f50131fbc50afe804a062502c25e35d1",
      "0x2c44108ecc11fd68ea37eea5f9c8589072c569754d3c0afb9b0ef675ab5f1792",
      "0xc1299cff93828cb3910b2da2b193e39ba4666d9a6d0675478f7f1d200ec71e08",
      "0xb2ab0c7d340e0844b85e04d035dd191441b63bb7bf66bd7f6890c1e817057472",
      "0xbef00268ff463eb78a906791ce628733fbf6aa8d8cf5daa2de119d79457641ce",
      "0x729d4e9fe684fa991fbb8b6508344b298a2cfd7182b91334a3a3bb66bce1685a",
      "0x3bfdcd9ec1a98cf81f503af74ac3c542466349305afd019d5b6d3e6fb3dfc664",
      "0x3d24bd91cde45cb5f88c035f5d3619bba7ad6cb832c038dc848dfc167f2ec948",
      "0x8c53d696ff31fde2440bb4fc89ed55d373a7607a31a60c248b74e616f5ba5caa",
      "0x1bef83f157a6a065c76c28a6d32b66d754fb26b6d709fb57f0981172613b29b0",
      "0xfd019b9c4508c66c54763fd1977ff13a4f884bcf6156c5d6e8fad271a492c5a1",
      "0xad48910bc3c5fda2c165e08c4baa5d08dcb52546798fc46225aecf431e61c82c",
      "0x67a6823a1ae74e7f857c210c2af6f6893d2e17f2c533d7b0877bbbb1e6f32180",
      "0xdde7e1eac191279000b38832b4070932fc25f733f5c179b53adead1767853fb2",
      "0x601f849c5133b6518ffb771f4279fc762d924d198db76755ce1102f38a7abafb"
    ]
  },
  {
    "templateIndex": 1,
    "transaction": {
      "hash": "0x37cf98f56ec8be9afaf09b3e2f86ca977fb897f3ec7fef43a0758f87455550bf",
      "from": "0xaaf5d91d2c2aced59231b857f3ed24aab1b7a74f",
      "to": null,
      "nonce": "0x4",
      "value": "0x0",
      "blockHash": "0x188bb08a8fdfba5cc1b22790611bc374af9031c32f16d826db70f0ef268f9033",
      "blockNumber": "0x7b37904",
      "transactionIndex": "0x9"
    },
    "receipt": {
      "transactionHash": "0x37cf98f56ec8be9afaf09b3e2f86ca977fb897f3ec7fef43a0758f87455550bf",
      "blockHash": "0x188bb08a8fdfba5cc1b22790611bc374af9031c32f16d826db70f0ef268f9033",
      "blockNumber": "0x7b37904",
      "transactionIndex": "0x9",
      "status": "0x1",
      "contractAddress": "0x649d2c0ae1be5c7deb7adf997ad27fb67b07cd22",
      "gasUsed": "0x426bc"
    },
    "block": {
      "number": "0x7b37904",
      "hash": "0x188bb08a8fdfba5cc1b22790611bc374af9031c32f16d826db70f0ef268f9033",
      "parentHash": "0x52d6d1e61d66733748738e490a9edc7442ef88677757768d57e25df645d6fa8a",
      "timestamp": "0x6ada80d5"
    },
    "transactionHashes": [
      "0x9617ff40dcc4d118eff0dc9b179308e28836ef1a7eaec4c7fe8c21f5c9e1e69d",
      "0xc6cb46027eff350301fffe3cc33c081805abbadd0c00135c9d6012397e2ad12f",
      "0x0cf3adfcd55aa98cac82a8e4994e379e2302e3f39c0f1b3aa499e3d2adc5c3b1",
      "0x3fe7509035a153b05ce3b29b3359129a216f4aa3e430949fc75113e2596f8b75",
      "0x4ff8e91c21ef0016d58978ed1e53613e14eec4c4e9f715ccb1a62c8eb3c919e7",
      "0xa9dced6c2f4a711428c6f7d262657ec8245c2b88b67e67056c00d617b1ffb3c3",
      "0x9c320712507bbd91ea4af567c63ca93978d8df5a7c73f2ad9b4d2e9d967755ea",
      "0x543414aa32b2eb0b350fccb8ea4e4285ef0065499ba153e7feeb608762c0a90a",
      "0xef7369c748de9818b90896fe2df9951315e1559a1c882d121ed82d469712ece7",
      "0x37cf98f56ec8be9afaf09b3e2f86ca977fb897f3ec7fef43a0758f87455550bf",
      "0xb1a9e492930e6105a628e6a9aef9390435e21b03fd3d83083e0c0ba0469b71d9",
      "0x52e52f5021d922251b5a507901ae28bc743087c3fe8ac99e86d007d60e5cfab6",
      "0x70f5f5b7c0e7dbd2f724179dc5394ad5ac4df1253181c30bf5359a77046e60e6",
      "0x2f9f9a40f36b58d0619397c4b2fa97f1bf253131d7fd283db5d73dd229396abe",
      "0x33aea3e5ff696a0aa8d04358a2ac9bb7dde0cf76b96dece243620ee2f6a89822",
      "0xc6a6109ced4e6fd3fc76cb336043c83c4b357b8f96083050af48b3f609f05c4e",
      "0x3b93dd58f8788a2cc9310c9eef77d4a74036489643bcbe3b8a7b8932eefebc2d",
      "0xbeadd60c5434f7753390278fd968c3115bb438b61caa5d8e8576074e9d0b6406",
      "0x48b6cb5d361915725927c1408f059a91623184d9994833194cbbcf90b2dd0ec9",
      "0x6a97e52bde4b30558e2b5dea0ff09fbfcfc85a23d3183e00e44d1c65edaf6108",
      "0x276888d764dbf68d25a14e0cb0f4b38e3d66dabb777ffb6cd1a2cab07034872a",
      "0x45a6ffa689d4887a7c51f25e753e2062e46e64f5bf49353f0967d44d8361feb7",
      "0xc23f2002f287a85df9a394358f6f45a28bb6d45d199f2eb25054f75795255769",
      "0x294f9ca8213790869a7c40e2aaa002c80bf618da501bf65f6a5ab0c227758b0b",
      "0xa72a50740ac26fa3e0faf3db0fa14a6c72a315901ab60fd8cb02028195a1a31b",
      "0xebb492dbf407853ab0f47385aecb15b9de5ba723874b1305c2de9c647595d2fd",
      "0x2c8a70603df022c9fc986e963cb3560b42e7432fc7106839cb7bcf930cd3e145",
      "0xae96c07a199b98ab105b23119b398211ef25f9ec8bf9c38f6095a43ed8722717",
      "0x2cbb1eeb733a5c4f156d466ea0db85605ca489eb8b3fc9b3195b524bcf780092",
      "0x3ccd442da8941a30fa9b25142c3d74ed0dd16ca0ec4929d652429bc7c518b85b",
      "0x6c8b894aa67e09c7865bd7380d3bbd1863cf674d05f401bdadb3917a217e3131",
      "0x6a8dd0fbcffbb6059fe502162cb20260b5f4c7e6ad1974a27b238d7d646367c9",
      "0x8b82c1c7d5f912548e8af700790a7d4c27c19e0c1dc0bad05f2820951096d726",
      "0x887c2d6e5391bc517f3fa457b2666edff5e488dc754ce24f95249bb779ffd4c9",
      "0x172cb058c1e50f3d21dde2495f332d1213514697ad7b05110c390769eb092175",
      "0x1e5af7ba42647a8d0407003ea86ad99dd001470d5e7567363ae09d5fdec1edf5",
      "0x6283c9cc69e81fadd338f3c50ae818d8678666368b07917175ab72da7b9e4e9b",
      "0xe5d748de55e4eb065e3e43c7c5a9bb4ec9f94c345f45531e4f0a12be5cb1cc71",
      "0x79fa64657db0c3e7d605b6459522fcff281e207c0701bcb9bb04f1bea7b25dda",
      "0x4e1725d4a16135bfd7812251d4845194a44b16d451f3974e8b12f8e306141ffe",
      "0x9e90afe80e7fe52ed853c74c60ceb90b168dc32ce956a63c1acf2e8192b48767",
      "0x1b88f4ace26d5ebc2a607c3f49c2116eef7dad280f6ab6de26d7768613ba6e48",
      "0x20961b1c9702e8e752dbbd2660ff87cd639a0d6207eb506f1ad730f84b2f677a",
      "0x8764b4edc616453368621cf35906449599b11ae3318be77e6cc2218f7e264f28",
      "0xb29bc9ea26a272349887820d1743cc836031732121ae1ffdc52f84872dee992b",
      "0xbbb556e6851f0e001200d358552473f45289431c20df03dc4a7f8778b6e1947e",
      "0x1f7f951dc2592fd081531a1c08a2badee212f9062afbb2a02e6b046a53c2371d",
      "0xdbbf111426a1df603d3106365b35f9a1f951ec8e35be301c0ffa08f0bbe5e4bd",
      "0x5984ae2002b8276ef8ee87f1ef73d2685071c070dfd78922941eecdb4683fdfe",
      "0x6a8205a2a8f5300ebca8d6e4ee5c5cd99c002cb354438220d7217308e619d023",
      "0x8f7261580fc9f6e6e68aa1f2697d6823128de0ff3f6210b1e0a9479a2f1a4f60",
      "0x3f08fbb23cdf9125714d19ae54c53917d9ba2b9cc171329e65fdeacdc15b5b38",
      "0xf0954e5326232e6adf61c55b41cb6a768a9e70a5052a277a5f22de1a74e7107a",
      "0x4902bab1a42fb409770f78eb3f4981ec5212013743cc7d4fca7b2164362e365f",
      "0x1a60167d5077388cae2cb8c33098b099059b4d465effcaf3c634ebf448dfc1b1",
      "0xbbaaff0f4e33e767b1aec2a8d920157ff9de66c306d9b540249f9b9f7ebbc334",
      "0x93802f734196ecc67eb1c1d95026893f3831f52f16c2791a259569966c1d7c36",
      "0xcb4b0a76e2124e500230f60fcac546d82081b2cd0c5932a0f486a2ee92f424b3",
      "0xb375bfcc2421db6c2dd99b0215b02c2bd9b04d5a82799cc82dea3bea7783bd73",
      "0xaf4b8a5cd2b204333bba5065d28a15c45a4dc03e6a28b0ba4af666dd02efed15",
      "0x38ac15d9a1b9212851dfc5ec592abcd2e09db2e79b2c3861facd297ad3fd53a0",
      "0xa8e028ecda3151b70fbc76a0967bd96f32fd75c483a433d5c8a2f5d4cc13f376",
      "0xc58c3bf96886ed0e0b70a987204e47e16f84fdd55a08fc7eb0e29b0db153111b",
      "0x32beb5f03cac908f687ad1d45d126dc46a39d8ba42d1d73895c7a02a65e14ee2",
      "0x7c399de7d879a249a6cd0595e36dd4417585f1d80a8b2af73a77092a3d814c46",
      "0x6cbe527b01b2c6e891efa15ebe42b8da355294f03116be3222f91ebada1d4f9c",
      "0x553c167c7135483829a0b02f20d505c57b5b8873066338bda57f99bb277e13d3",
      "0x0ff6139d620a7be91fcc7769b5b2f4acfa8229ad4645637f53c0b374886c4660",
      "0x161c8bba347a3d829def30125d41cc971ed8ff6c3550cdbb98622e05ab54bdf0",
      "0xed3fb1e7f4008a65f18e1c83e9c16e5c94613e9ee59579314c2cf172cdf5ba88",
      "0x84c2b580211c364d6be733b7875aa4fe3bd76c4016e944263027ef995ff2e3e8",
      "0xc1dfdb3cc6424a39e277d75a9dc206607b981aabb507418e8d711ee159f35f96",
      "0x6b5539fe638d3a360f0eb636eafbf4c94f285e896915998f15e0b7eed51b8436"
    ]
  }
] as const;
function capturedImmutableFixture(index: number) {
  if (index === 2) {
    const saved = FRESH_USDC_NONLEDGER_CREATION;
    const {hash, from, to, nonce, value, input, blockHash, blockNumber, transactionIndex} = saved.transaction;
    const transaction: FreshTransaction = {hash, from, to, nonce, value, input, blockHash, blockNumber, transactionIndex};
    const transactions = saved.block.transactionHashes.map(hash => ({hash}) as FreshTransaction);
    transactions[Number(BigInt(transaction.transactionIndex))] = transaction;
    const block: FreshBlock = {number: saved.block.number, hash: saved.block.hash, parentHash: saved.block.parentHash,
      timestamp: saved.block.timestamp, transactions};
    const receipt: FreshReceipt = {...saved.receipt, logs: [...saved.receipt.logs]};
    return {transaction, receipt, block};
  }
  const saved = capturedImmutableCreations[index], template = FRESH_IMMUTABLE_NONLEDGER_TEMPLATES[saved.templateIndex];
  const transaction: FreshTransaction = {...saved.transaction, input: template.initcode};
  const transactions = saved.transactionHashes.map(hash => ({hash}) as FreshTransaction);
  transactions[Number(BigInt(transaction.transactionIndex))] = transaction;
  const block: FreshBlock = {...saved.block, transactions};
  const receipt: FreshReceipt = {...saved.receipt, logs: []};
  return {transaction, receipt, block};
}

function capturedLiteralFixture() {
  const saved = FRESH_BNB_LITERAL_NONLEDGER_CREATION;
  const {hash, from, to, nonce, value, input, blockHash, blockNumber, transactionIndex} = saved.transaction;
  const transaction: FreshTransaction = {hash, from, to, nonce, value, input, blockHash, blockNumber, transactionIndex};
  const transactions = saved.block.transactionHashes.map(hash => ({hash}) as FreshTransaction);
  transactions[Number(BigInt(transaction.transactionIndex))] = transaction;
  const block: FreshBlock = {number: saved.block.number, hash: saved.block.hash, parentHash: saved.block.parentHash,
    timestamp: saved.block.timestamp, transactions};
  const receipt: FreshReceipt = {...saved.receipt, logs: [...saved.receipt.logs]};
  return {transaction, receipt, block};
}

/** Test-only bounded execution of these frozen constructors. Unknown opcodes,
 * external effects, invalid jumps, excessive memory or steps fail the audit.
 * This checks the actual successful CODECOPY/RETURN path rather than assuming
 * that bytes embedded in a creation transaction were necessarily deployed. */
function executeAuditedConstructor(initcode: string) {
  const code = Buffer.from(initcode.slice(2), 'hex'), memory = Buffer.alloc(8192), stack: bigint[] = [], storage = new Map<bigint, bigint>();
  const copies: {pc: number; source: number; offset: number; length: number}[] = [], stores: {pc: number; offset: number; value: bigint}[] = [];
  const writes: string[] = [], validJumps = new Set<number>(), mask = (1n << 256n) - 1n;
  for (let offset = 0; offset < code.length; offset++) { const op = code[offset]; if (op === 0x5b) validJumps.add(offset); if (op >= 0x60 && op <= 0x7f) offset += op - 0x5f; }
  const pop = () => { if (!stack.length) throw new Error('constructor_stack'); return stack.pop()!; };
  const push = (value: bigint) => { if (stack.length >= 1024) throw new Error('constructor_stack'); stack.push(value & mask); };
  const number = (value: bigint) => { if (value > BigInt(memory.length)) throw new Error('constructor_memory'); return Number(value); };
  const bounds = (offset: number, length: number) => { if (offset + length > memory.length) throw new Error('constructor_memory'); };
  const signed = (value: bigint) => value >= (1n << 255n) ? value - (1n << 256n) : value;
  const word = (value: Buffer) => BigInt(`0x${value.toString('hex') || '0'}`);
  const jump = (destination: bigint) => { const value = number(destination); if (!validJumps.has(value)) throw new Error('constructor_jump'); return value; };
  let pc = 0;
  for (let steps = 1; steps <= 1024; steps++) {
    const op = code[pc++]; let a: bigint, b: bigint, offset: number, length: number;
    if (op >= 0x60 && op <= 0x7f) { const count = op - 0x5f; push(word(code.subarray(pc, pc + count))); pc += count; continue; }
    if (op >= 0x80 && op <= 0x8f) { const value = stack.at(-(op - 0x7f)); if (value === undefined) throw new Error('constructor_stack'); push(value); continue; }
    if (op >= 0x90 && op <= 0x9f) { const index = stack.length - 1 - (op - 0x8f); if (index < 0) throw new Error('constructor_stack'); [stack[index], stack[stack.length - 1]] = [stack.at(-1)!, stack[index]]; continue; }
    switch (op) {
      case 0x01: push(pop() + pop()); break;
      case 0x02: push(pop() * pop()); break;
      case 0x03: a = pop(); b = pop(); push(a - b); break;
      case 0x04: a = pop(); b = pop(); push(b === 0n ? 0n : a / b); break;
      case 0x0a: a = pop(); b = pop(); if (b > 256n) throw new Error('constructor_exponent'); push(a ** b); break;
      case 0x10: a = pop(); b = pop(); push(a < b ? 1n : 0n); break;
      case 0x11: a = pop(); b = pop(); push(a > b ? 1n : 0n); break;
      case 0x12: a = pop(); b = pop(); push(signed(a) < signed(b) ? 1n : 0n); break;
      case 0x14: push(pop() === pop() ? 1n : 0n); break;
      case 0x15: push(pop() === 0n ? 1n : 0n); break;
      case 0x16: push(pop() & pop()); break;
      case 0x17: push(pop() | pop()); break;
      case 0x19: push(~pop()); break;
      case 0x1b: a = pop(); b = pop(); push(a >= 256n ? 0n : b << a); break;
      case 0x1c: a = pop(); b = pop(); push(a >= 256n ? 0n : b >> a); break;
      case 0x20: offset = number(pop()); length = number(pop()); bounds(offset, length); push(BigInt(keccak256(memory.subarray(offset, offset + length)))); break;
      case 0x34: push(0n); break;
      case 0x38: push(BigInt(code.length)); break;
      case 0x39: { offset = number(pop()); const source = number(pop()); length = number(pop()); bounds(offset, length); copies.push({pc: pc - 1, source, offset, length}); memory.fill(0, offset, offset + length); code.copy(memory, offset, source, source + length); break; }
      case 0x50: pop(); break;
      case 0x51: offset = number(pop()); bounds(offset, 32); push(word(memory.subarray(offset, offset + 32))); break;
      case 0x52: offset = number(pop()); a = pop(); bounds(offset, 32); stores.push({pc: pc - 1, offset, value: a}); Buffer.from(a.toString(16).padStart(64, '0'), 'hex').copy(memory, offset); break;
      case 0x54: push(storage.get(pop()) ?? 0n); break;
      case 0x55: a = pop(); b = pop(); storage.set(a, b); writes.push(a.toString()); break;
      case 0x56: pc = jump(pop()); break;
      case 0x57: a = pop(); if (pop() !== 0n) pc = jump(a); break;
      case 0x5b: break;
      case 0x5f: push(0n); break;
      case 0xf3: offset = number(pop()); length = number(pop()); bounds(offset, length); return { runtime: memory.subarray(offset, offset + length), storage, writes, steps, copies, stores, returnOffset: offset, returnPc: pc - 1 };
      default: throw new Error(`unaudited_constructor_opcode_${op?.toString(16)}`);
    }
  }
  throw new Error('constructor_step_limit');
}

describe('exact creation-derived nonledger authenticity proofs', () => {
  it('keeps the original two audited complete creations pinned unchanged', () => {
    expect(FRESH_NONLEDGER_TEMPLATES.map(({id, initcode, initcodeHash, runtimeHash}) => ({id, initcodeHash: keccak256(initcode), pinned: initcodeHash, runtimeHash}))).toEqual([
      {id: 'batch_transfer_log_emitter_solc_0_8_26', initcodeHash: '0x69b9560a97c08e32dd784ead032aa5b04fd83e4a8c7f798b7bf0429ebeb012bd',
        pinned: '0x69b9560a97c08e32dd784ead032aa5b04fd83e4a8c7f798b7bf0429ebeb012bd', runtimeHash: '0x49218248d9883419ef3e0c4201fe47bfee66db5349118539daada66822b26402'},
      {id: 'transfer_from_log_emitter_solc_0_8_26', initcodeHash: '0xf25b76807479251aa0cb8fa2bdb7de9360240655dab4a5c7fcc8ce665fda4703',
        pinned: '0xf25b76807479251aa0cb8fa2bdb7de9360240655dab4a5c7fcc8ce665fda4703', runtimeHash: '0x11a984090a1b94193998b8cd3dd210cd0f2244259be113e9a598e8b4d72fd798'},
    ]);
    expect(Object.isFrozen(FRESH_NONLEDGER_TEMPLATES)).toBe(true);
    expect(FRESH_IMMUTABLE_NONLEDGER_TEMPLATES.slice(0, 2).map(({id, initcode, initcodeHash, runtimeHash}) =>
      ({id, initcodeHash: keccak256(initcode), pinned: initcodeHash, runtimeHash}))).toEqual([
      {id: 'immutable_bnb_transfer_log_emitter_v1', initcodeHash: '0x9ce359a84e27b83be66d1f123ee3e499beaae96492d0e37625509b99d24018ea',
        pinned: '0x9ce359a84e27b83be66d1f123ee3e499beaae96492d0e37625509b99d24018ea', runtimeHash: '0x4c9fcb53e78cd6d76304663035e0c9fea2c18dada4dfa450083db76ad412755a'},
      {id: 'immutable_usdt_transfer_log_emitter_v1', initcodeHash: '0xdf167eeff687eb530b1abfd502a2114308d23da471fc279e70247f7db40bb062',
        pinned: '0xdf167eeff687eb530b1abfd502a2114308d23da471fc279e70247f7db40bb062', runtimeHash: '0x47c7c3007340508fbe16ac109b07c4f90dd09b4a2d53046bbef972f88a9b54cb'},
    ]);
    for (const template of FRESH_IMMUTABLE_NONLEDGER_TEMPLATES) {
      expect(Object.isFrozen(template)).toBe(true); expect(Object.isFrozen(template.immutablePatches)).toBe(true);
      for (const patch of template.immutablePatches) expect(Object.isFrozen(patch)).toBe(true);
    }
  });

  it.each(FRESH_IMMUTABLE_NONLEDGER_TEMPLATES)('executes the full fixed-argument immutable constructor for $id', template => {
    const result = executeAuditedConstructor(template.initcode), bytes = Buffer.from(template.initcode.slice(2), 'hex');
    const expected = Buffer.from(bytes.subarray(template.runtimeOffset, template.argumentsOffset));
    const args = bytes.subarray(template.argumentsOffset);
    expect(result.steps).toBe(184); expect(result.returnPc).toBe(0xd8); expect(result.returnOffset).toBe(0x200);
    expect(result.copies).toEqual([{pc: 0x37, source: template.argumentsOffset, offset: 0x140, length: 192},
      {pc: 0xa7, source: 0x100, offset: 0x200, length: template.runtimeBytes}]);
    expect(result.writes).toEqual([]); expect(result.storage.size).toBe(0);
    expect(keccak256(bytes.subarray(0, template.runtimeOffset))).toBe(template.constructorHash);
    expect(keccak256(expected)).toBe(template.runtimeTemplateHash); expect(keccak256(args)).toBe(template.argumentsHash);
    const runtimeStores = result.stores.filter(store => store.offset >= result.returnOffset);
    expect(runtimeStores).toHaveLength(6);
    for (const patch of template.immutablePatches) {
      expect(expected[patch.runtimeOffset - 1]).toBe(0x7f);
      expect(expected.subarray(patch.runtimeOffset, patch.runtimeOffset + 32)).toEqual(Buffer.alloc(32));
      const argument = args.subarray(patch.argumentWord * 32, (patch.argumentWord + 1) * 32);
      expect(runtimeStores).toContainEqual(expect.objectContaining({offset: 0x200 + patch.runtimeOffset, value: BigInt('0x' + argument.toString('hex'))}));
      argument.copy(expected, patch.runtimeOffset);
    }
    expect(result.runtime).toEqual(expected); expect(result.runtime.length).toBe(template.runtimeBytes);
    expect(keccak256(result.runtime)).toBe(template.runtimeHash);
  });

  it.each([0, 1, 2])('binds captured canonical immutable creation %s and its complete argument/runtime proof', index => {
    const value = capturedImmutableFixture(index), template = FRESH_IMMUTABLE_NONLEDGER_TEMPLATES[index];
    const proof = classifyFreshCreationToken(value);
    expect(proof).toMatchObject({version: 1, classification: 'proven_nonledger_event_emitter', ledgerAbsent: true, templateId: template.id,
      creationEvidence: {transaction: value.transaction, receipt: {contractAddress: value.receipt.contractAddress}, block: {
        hash: value.block.hash, number: value.block.number, parentHash: value.block.parentHash, timestamp: value.block.timestamp}},
      bytecode: {runtimeHash: template.runtimeHash, runtimeOffset: 256, runtimeBytes: template.runtimeBytes,
        constructorArguments: {offset: template.argumentsOffset, bytes: 192, hash: template.argumentsHash, returnPc: 216, immutablePatches: template.immutablePatches}}});
    expect(proof?.creationEvidence.receipt).not.toHaveProperty('logs');
    expect(JSON.stringify(proof).length).toBeLessThan(6000);
    for (const nonce of ['0x0', '0x123']) expect(classifyFreshCreationToken(fixture(template.initcode, nonce))?.templateId).toBe(template.id);
  });

  it('binds the independently captured BNB controller creation without accepting another controller', () => {
    const saved = FRESH_BNB_CONTROLLER_NONLEDGER_CREATION;
    const transaction: FreshTransaction = {...saved.transaction};
    const transactions = saved.block.transactionHashes.map(hash => ({hash}) as FreshTransaction);
    transactions[Number(BigInt(transaction.transactionIndex))] = transaction;
    const context = {transaction, receipt: {...saved.receipt, logs: [...saved.receipt.logs]},
      block: {number:saved.block.number,hash:saved.block.hash,parentHash:saved.block.parentHash,timestamp:saved.block.timestamp,transactions}};
    const proof = classifyFreshCreationToken(context);
    expect(proof?.templateId).toBe('immutable_bnb_controller_044bab_log_emitter_v1');
    expect(proof?.creationEvidence.receipt.contractAddress).toBe('0x8be4215c0458ef8ec0ca21f274f1b2dfacfb50b1');
    const result = executeAuditedConstructor(transaction.input as string);
    expect('0x'+result.runtime.toString('hex')).toBe(saved.derivedRuntime);
    expect(result.writes).toEqual([]); expect(result.storage.size).toBe(0);
    expect(keccak256(result.runtime)).toBe(proof?.bytecode.runtimeHash);
    const template = FRESH_IMMUTABLE_NONLEDGER_TEMPLATES[3];
    const bytes=Buffer.from(template.initcode.slice(2),'hex');
    bytes[template.argumentsOffset+31]^=1;
    const mutated={...context,transaction:{...transaction,input:'0x'+bytes.toString('hex')},block:{...context.block,transactions:[...transactions]}};
    mutated.block.transactions[Number(BigInt(transaction.transactionIndex))]=mutated.transaction;
    expect(classifyFreshCreationToken(mutated)).toBeNull();
  });

  it('reproduces the new exact USDC emitter creation and its independently observed runtime', () => {
    const template = FRESH_IMMUTABLE_NONLEDGER_TEMPLATES[2], saved = FRESH_USDC_NONLEDGER_CREATION;
    expect(template.initcode).toBe(saved.transaction.input);
    expect(keccak256(saved.transaction.input)).toBe('0xb151bca205a88bb10b08869c97f2091564bbbd63e315c793ef47f6e64c76be29');
    expect(keccak256(saved.runtime)).toBe('0xd0343c22f4feabc217e2b62620b431d845970ed5a386078b8721159fa06fc146');
    const result = executeAuditedConstructor(saved.transaction.input);
    expect('0x' + result.runtime.toString('hex')).toBe(saved.runtime);
    expect(result.writes).toEqual([]);
    expect(classifyFreshCreationToken(capturedImmutableFixture(2))).toMatchObject({
      templateId: 'immutable_usdc_transfer_log_emitter_v1', ledgerAbsent: true,
      creationEvidence: {receipt: {contractAddress: '0x760b42b62c896e44e6b3aaa3f43d333470a021af'}},
      bytecode: {initcodeHash: template.initcodeHash, runtimeHash: template.runtimeHash},
    });
  });

  it('does not generalize the USDC emitter proof to a changed supply, executable opcode or constructor argument', () => {
    const template = FRESH_IMMUTABLE_NONLEDGER_TEMPLATES[2];
    const mutations = [
      {offset: template.runtimeOffset + 388, value: 0x20}, // Fixed PUSH12 totalSupply value.
      {offset: template.runtimeOffset + 985, value: 0x55}, // Executable STOP becomes SSTORE.
      {offset: template.argumentsOffset + 31, value: 0x59}, // Controller address changes.
      {offset: template.argumentsOffset + 95, value: 0x0b}, // Name length changes.
      {offset: template.argumentsOffset + 191, value: 0x09}, // Precision changes.
    ];
    for (const {offset, value} of mutations) {
      const bytes = Buffer.from(template.initcode.slice(2), 'hex');
      expect(bytes[offset]).not.toBe(value); bytes[offset] = value;
      expect(classifyFreshCreationToken(fixture('0x' + bytes.toString('hex')))).toBeNull();
    }
  });

  it('pins the complete literal BNB emitter and reproduces its actual no-argument constructor return', () => {
    const saved = FRESH_BNB_LITERAL_NONLEDGER_CREATION, template = FRESH_LITERAL_NONLEDGER_TEMPLATES[0];
    expect(Object.isFrozen(FRESH_LITERAL_NONLEDGER_TEMPLATES)).toBe(true); expect(Object.isFrozen(template)).toBe(true);
    expect(template.initcode).toBe(saved.transaction.input);
    expect(keccak256(template.initcode)).toBe('0xcc97e97c2e6e4a50b6bc79d66547b0ab9bf57fcc3daf4c9f4174576d3ba4931c');
    expect(keccak256(Buffer.from(template.initcode.slice(2, 58), 'hex'))).toBe('0xe75af956289741b81c941e741f658c8bcc5532e5197a1358d9377d99ecf652d0');
    expect(keccak256(saved.runtime)).toBe('0xfd034e0b4861aae5b18320deec520e2af3c52554e79173a90c744e92e06b8667');
    const result = executeAuditedConstructor(template.initcode);
    expect(result.steps).toBe(17);
    expect(result.returnPc).toBe(26); expect(result.returnOffset).toBe(0);
    expect(result.copies).toEqual([{pc: 24, source: 28, offset: 0, length: 1667}]);
    expect(result.writes).toEqual([]); expect(result.storage.size).toBe(0);
    expect('0x' + result.runtime.toString('hex')).toBe(saved.runtime);
    expect(result.runtime.length).toBe(template.runtimeBytes);
    const proof = classifyFreshCreationToken(capturedLiteralFixture());
    expect(proof).toMatchObject({templateId: template.id, ledgerAbsent: true,
      creationEvidence: {receipt: {contractAddress: '0xe2fc0df4dd587fd0e0a6ab71e97bb81ae321e282'}},
      bytecode: {initcodeHash: template.initcodeHash, constructorHash: template.constructorHash, runtimeHash: template.runtimeHash,
        runtimeOffset: 28, runtimeBytes: 1667, returnOffset: 16}});
    expect(proof?.bytecode).not.toHaveProperty('constructorArguments');
  });

  it('audits the complete pinned literal runtime with no storage, external effects or reachable metadata entry', () => {
    const runtime = Buffer.from(FRESH_BNB_LITERAL_NONLEDGER_CREATION.runtime.slice(2), 'hex');
    const start = runtime.length - runtime.readUInt16BE(runtime.length - 2) - 2;
    expect(start).toBe(1614); expect(runtime[start - 1]).toBe(0xfe);
    expect(runtime.subarray(start).includes(0x5b)).toBe(false);
    const forbidden = new Set([0x54, 0x55, 0x5c, 0x5d, 0xf0, 0xf1, 0xf2, 0xf4, 0xf5, 0xfa, 0xff]);
    const logPositions: number[] = [];
    for (let offset = 0; offset < start; offset++) {
      const opcode = runtime[offset]; expect(forbidden.has(opcode)).toBe(false);
      if (opcode === 0xa3) logPositions.push(offset);
      if (opcode >= 0x60 && opcode <= 0x7f) { offset += opcode - 0x5f; expect(offset).toBeLessThan(start); }
    }
    expect(logPositions).toEqual([398, 623]);
  });

  it('rejects any alteration of the literal constructor, runtime, metadata or input boundary', () => {
    const template = FRESH_LITERAL_NONLEDGER_TEMPLATES[0];
    for (const offset of [0, 14, 16, 20, 24, 26, 27, 28, 28 + 398, 28 + 623, 28 + 1614]) {
      const bytes = Buffer.from(template.initcode.slice(2), 'hex'); bytes[offset] ^= 1;
      expect(classifyFreshCreationToken(fixture('0x' + bytes.toString('hex')))).toBeNull();
    }
    for (const input of [template.initcode + '00', template.initcode.slice(0, -2), '0x00' + template.initcode.slice(2),
      FRESH_BNB_LITERAL_NONLEDGER_CREATION.runtime]) expect(classifyFreshCreationToken(fixture(input))).toBeNull();
  });

  it('rejects forged canonical identities, failed creation and wrong transaction order for the literal proof', () => {
    for (const mutate of [(value: ReturnType<typeof capturedLiteralFixture>) => { value.receipt.contractAddress = '0x' + '2'.repeat(40); },
      (value: ReturnType<typeof capturedLiteralFixture>) => { value.receipt.blockHash = hash('d'); },
      (value: ReturnType<typeof capturedLiteralFixture>) => { value.block.transactions = [...value.block.transactions].reverse(); },
      (value: ReturnType<typeof capturedLiteralFixture>) => { value.transaction.from = '0x' + '2'.repeat(40); },
      (value: ReturnType<typeof capturedLiteralFixture>) => { value.receipt.status = '0x0'; }]) {
      const value = capturedLiteralFixture(); mutate(value); expect(classifyFreshCreationToken(value)).toBeNull();
    }
  });

  it('rejects immutable family variations in every argument, constructor, runtime, metadata and input boundary', () => {
    for (const template of FRESH_IMMUTABLE_NONLEDGER_TEMPLATES) {
      const offsets = [0, 55, 154, 167, 216, 255, 256, template.runtimeOffset + template.metadataStart,
        ...template.immutablePatches.map(patch => template.runtimeOffset + patch.runtimeOffset),
        ...template.immutablePatches.map(patch => template.argumentsOffset + 32 * patch.argumentWord + 31)];
      for (const offset of offsets) {
        const bytes = Buffer.from(template.initcode.slice(2), 'hex'); bytes[offset] ^= 1;
        expect(classifyFreshCreationToken(fixture('0x' + bytes.toString('hex')))).toBeNull();
      }
      const args = template.initcode.slice(2 + template.argumentsOffset * 2);
      for (const input of [template.initcode + '00', template.initcode.slice(0, -2), '0x00' + template.initcode.slice(2),
        '0x' + template.initcode.slice(2 + template.runtimeOffset * 2), '0x' + template.initcode.slice(2, 2 + template.argumentsOffset * 2),
        template.initcode.slice(0, 2 + template.argumentsOffset * 2) + args.slice(64, 128) + args.slice(0, 64) + args.slice(128)]) {
        expect(classifyFreshCreationToken(fixture(input))).toBeNull();
      }
    }
  });

  it.each([0, 1, 2])('rejects mismatched canonical identities for immutable creation %s', index => {
    for (const mutate of [(value: ReturnType<typeof capturedImmutableFixture>) => { value.receipt.contractAddress = '0x' + '2'.repeat(40); },
      (value: ReturnType<typeof capturedImmutableFixture>) => { value.receipt.blockHash = hash('d'); },
      (value: ReturnType<typeof capturedImmutableFixture>) => { value.block.transactions = [...value.block.transactions].reverse(); },
      (value: ReturnType<typeof capturedImmutableFixture>) => { value.transaction.to = '0x' + '2'.repeat(40); },
      (value: ReturnType<typeof capturedImmutableFixture>) => { value.receipt.status = '0x0'; }]) {
      const value = capturedImmutableFixture(index); mutate(value); expect(classifyFreshCreationToken(value)).toBeNull();
    }
  });

  it.each(FRESH_NONLEDGER_TEMPLATES)('executes the actual audited creation RETURN for $id', template => {
    const result = executeAuditedConstructor(template.initcode);
    expect(result.steps).toBe(458); expect(result.returnPc).toBe(0x3e0);
    expect(result.runtime).toEqual(Buffer.from(template.initcode.slice(2 + template.runtimeOffset * 2), 'hex'));
    expect(keccak256(result.runtime)).toBe(template.runtimeHash); expect(result.runtime.length).toBe(template.runtimeBytes);
    expect(result.storage.get(0n)).toBe(10n ** 36n); expect(result.storage.get(3n)).toBe(18n);
    expect(result.writes).toEqual(['0', '1', '2', '3']);
  });

  it.each(FRESH_NONLEDGER_TEMPLATES)('returns bounded, reproducible exclusion evidence for $id at different CREATE nonces', template => {
    for (const nonce of ['0x0', '0x123']) {
      const value = fixture(template.initcode, nonce), proof = classifyFreshCreationToken(value);
      expect(proof).toMatchObject({ version: 1, classification: 'proven_nonledger_event_emitter', templateId: template.id, ledgerAbsent: true,
        bytecode: { initcodeHash: template.initcodeHash, constructorHash: template.constructorHash, runtimeHash: template.runtimeHash, runtimeOffset: 994, returnOffset: 981 } });
      expect(proof?.creationEvidence.transaction.input).toBe(template.initcode);
      expect(proof?.creationEvidence.receipt.contractAddress).toBe(value.receipt.contractAddress?.toLowerCase());
      expect(proof?.creationEvidence.block).toEqual({ hash: value.block.hash, parentHash: value.block.parentHash, number: value.block.number, timestamp: value.block.timestamp });
      expect(proof?.creationEvidence.receipt).not.toHaveProperty('logs'); expect(proof?.creationEvidence.transaction).not.toHaveProperty('wallets');
      expect(JSON.stringify(proof).length).toBeLessThan(8500);
    }
  });

  it('does not recognize constructor/runtime changes, extra arguments, wrappers or copied runtime as a creation proof', () => {
    for (const template of FRESH_NONLEDGER_TEMPLATES) {
      for (const offset of [5, 22, 160, 981, 986, 993, 994, 1040]) {
        const bytes = Buffer.from(template.initcode.slice(2), 'hex'); bytes[offset] ^= 1;
        expect(classifyFreshCreationToken(fixture(`0x${bytes.toString('hex')}`))).toBeNull();
      }
      for (const input of [template.initcode + '00', template.initcode.slice(0, -2), `0x00${template.initcode.slice(2)}`, `0x${template.initcode.slice(2 + 994 * 2)}`]) {
        expect(classifyFreshCreationToken(fixture(input))).toBeNull();
      }
    }
  });

  it('keeps unknown or ordinary ERC20 bytecode unknown instead of inferring from identity or a balanceOf failure', () => {
    expect(classifyFreshCreationToken(fixture('0x600160005560016000f3'))).toBeNull();
    const misleading = fixture('0x60006000f3'); misleading.transaction.name = 'U5DT'; misleading.transaction.symbol = 'U5DT'; misleading.transaction.balanceOfReverted = true;
    expect(classifyFreshCreationToken(misleading)).toBeNull();
  });

  it('rejects failed creations, indirect calls, value, invalid identities and mismatching CREATE addresses', () => {
    const mutations: ((value: ReturnType<typeof fixture>) => void)[] = [
      value => { value.receipt.status = '0x0'; }, value => { value.transaction.to = `0x${'2'.repeat(40)}`; },
      value => { value.transaction.value = '0x1'; }, value => { delete value.transaction.nonce; },
      value => { value.receipt.contractAddress = `0x${'3'.repeat(40)}`; }, value => { value.receipt.blockHash = hash('d'); },
      value => { value.receipt.transactionHash = hash('d'); }, value => { value.receipt.transactionIndex = '0x1'; },
      value => { value.transaction.blockNumber = '0x66'; }, value => { value.block.hash = hash('d'); },
      value => { value.transaction.transactionIndex = '0x100000000000000000'; }, value => { value.block.timestamp = 'invalid'; },
    ];
    for (const mutate of mutations) { const value = fixture(FRESH_NONLEDGER_TEMPLATES[0].initcode); mutate(value); expect(classifyFreshCreationToken(value)).toBeNull(); }
  });

  it('requires the full matching transaction at its actual canonical block position', () => {
    for (const field of ['hash', 'from', 'input', 'nonce', 'value', 'blockHash', 'blockNumber', 'transactionIndex'] as const) {
      const value = fixture(FRESH_NONLEDGER_TEMPLATES[0].initcode); value.block.transactions = [structuredClone(value.transaction)];
      value.block.transactions[0][field] = field === 'input' ? '0x00' : field === 'from' ? `0x${'2'.repeat(40)}` : ['hash', 'blockHash'].includes(field) ? hash('d') : '0x1';
      expect(classifyFreshCreationToken(value)).toBeNull();
    }
    const missing = fixture(FRESH_NONLEDGER_TEMPLATES[0].initcode); missing.block.transactions = []; expect(classifyFreshCreationToken(missing)).toBeNull();
  });
});
