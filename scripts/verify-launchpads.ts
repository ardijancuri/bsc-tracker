// Read-only smoke check against the local BSC node and existing live token feed.
import { chainRpc, blockHex } from '../server/rpc.js';
import { decodeFlapState, decodeFourState, flapInterface, fourInterface, fourV1Interface, FOUR_HELPER, FOUR_MANAGERS, FLAP_PORTAL, launchEventTopics } from '../server/launchpad.js';
const head = Number(BigInt(await chainRpc<string>('eth_blockNumber', []))) - 6;
const response = await fetch('http://127.0.0.1:3300/api/tokens?limit=30');
const { items } = await response.json() as { items: { address: string; symbol: string }[] };
const counts: Record<string, number> = {};
for (const token of items) {
  try {
    const raw = await chainRpc<string>('eth_call', [{ to: FOUR_HELPER, data: fourInterface.encodeFunctionData('getTokenInfo', [token.address]) }, blockHex(head)]);
    const state = decodeFourState(raw);
    if (state) { counts.fourmeme = (counts.fourmeme || 0) + 1; console.log(token.symbol, 'Four.meme', state.stage, state.progress); continue; }
  } catch { /* Other protocol. */ }
  try {
    const raw = await chainRpc<string>('eth_call', [{ to: FLAP_PORTAL, data: flapInterface.encodeFunctionData('getTokenV8Safe', [token.address]) }, blockHex(head)]);
    const state = decodeFlapState(raw);
    if (state) { counts.flap = (counts.flap || 0) + 1; console.log(token.symbol, 'Flap', state.stage, state.progress); }
  } catch { /* Leave unsupported tokens unavailable. */ }
}
const logs = await chainRpc<{ address: string; topics: string[]; data: string }[]>('eth_getLogs', [{ fromBlock: blockHex(head - 100), toBlock: blockHex(head), address: [...FOUR_MANAGERS, FLAP_PORTAL], topics: [[...new Set(launchEventTopics)]] }]);
let failed = 0;
for (const log of logs) {
  let parsed = null;
  for (const abi of log.address.toLowerCase() === FLAP_PORTAL ? [flapInterface] : [fourInterface, fourV1Interface]) { try { parsed = abi.parseLog(log); if (parsed) break; } catch { /* Try the supported legacy signature. */ } }
  if (!parsed) failed++;
  else counts[parsed.name] = (counts[parsed.name] || 0) + 1;
}
console.log(JSON.stringify({ confirmedHeight: head, events: logs.length, decodeFailures: failed, counts }));
if (failed || !counts.flap || !counts.fourmeme) process.exitCode = 1;
