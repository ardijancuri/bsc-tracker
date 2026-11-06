import { Interface, ZeroAddress, getAddress } from 'ethers';

// BNB Chain deployments and interfaces published by the launchpads:
// https://github.com/four-meme-community/fourmeme-docs/blob/main/docs/trade-guide.md
// https://docs.flap.sh/en/flap/developers/deployed-contract-addresses
// https://docs.flap.sh/en/flap/developers/wallet-and-terminal-and-bot-developers/trade-tokens
// https://docs.flap.sh/en/flap/drafts/pool-launch
// https://developer.pancakeswap.finance/contracts/v2/addresses
const fourHelper = '0xf251f83e40a78868fcfa3fa4599dad6494e46034';
const fourV1Manager = '0xec4549cadce5da21df6e6422d448034b5233bfbc';
const fourV2Manager = '0x5c952063c7fc8610ffdb798152d69f0b9550762b';
const flapPortal = '0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0';
const flapPoolPortal = '0x000042108465206185a077edc3f3fd2b49060000';
const pancakeV2Factory = '0xca143ce32fe78f1f7019d7d551a6402fc5350c73';
const wrappedBnb = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';

const fourAbi = new Interface([
  'function getTokenInfo(address token) view returns (uint256 version,address tokenManager,address quote,uint256 lastPrice,uint256 tradingFeeRate,uint256 minTradingFee,uint256 launchTime,uint256 offers,uint256 maxOffers,uint256 funds,uint256 maxFunds,bool liquidityAdded)',
  'function tryBuy(address token,uint256 amount,uint256 funds) view returns (address tokenManager,address quote,uint256 estimatedAmount,uint256 estimatedCost,uint256 estimatedFee,uint256 amountMsgValue,uint256 amountApproval,uint256 amountFunds)',
  'function purchaseTokenAMAP(address token,uint256 funds,uint256 minAmount) payable',
  'function buyTokenAMAP(address token,uint256 funds,uint256 minAmount) payable',
]);
const flapAbi = new Interface([
  'function getTokenV8Safe(address token) view returns ((uint8 status,uint256 reserve,uint256 circulatingSupply,uint256 price,uint8 tokenVersion,uint256 r,uint256 h,uint256 k,uint256 dexSupplyThresh,address quoteTokenAddress,bool nativeToQuoteSwapEnabled,bytes32 extensionID,uint256 buyTaxRate,uint256 sellTaxRate,address pool,uint256 progress,uint8 lpFeeProfile,uint8 dexId) state)',
  'function getLaunchToken(address token) view returns ((uint8 kind,uint8 tokenVersion,uint8 externalVenue,uint8 dexId,uint8 quoteTokenType,address quoteTokenAddress,uint8 status,uint256 circulatingSupply,uint256 pendingRemainder,address pool,uint8 poolType,bytes venueData,uint256 totalSupply) state)',
  'function quoteExactInput((address inputToken,address outputToken,uint256 inputAmount) params) returns (uint256 outputAmount)',
  'function swapExactInput((address inputToken,address outputToken,uint256 inputAmount,uint256 minOutputAmount,bytes permitData) params) payable returns (uint256 outputAmount)',
]);
const factoryAbi = new Interface(['function getPair(address tokenA,address tokenB) view returns (address pair)']);

interface LaunchpadBuyInput {
  token: string;
  wallet: string;
  value: bigint;
  rpc: (method: string, params: unknown[]) => Promise<unknown>;
  signal?: AbortSignal;
}

export interface LaunchpadBuyQuote {
  kind: 'fourmeme' | 'flap';
  estimatedOutput: bigint;
  buildData(minimumOutput: bigint): { to: string; data: string; value: bigint };
}

async function call(
  { rpc, wallet }: LaunchpadBuyInput,
  to: string,
  abi: Interface,
  method: string,
  args: unknown[],
  resultWords: number,
) {
  const data = abi.encodeFunctionData(method, args);
  const raw = await rpc('eth_call', [{ from: wallet, to, data }, 'latest']);
  if (typeof raw !== 'string' || raw.length !== 2 + resultWords * 64 || !/^0x[\da-f]+$/i.test(raw)) {
    throw new Error('Invalid launchpad quote response.');
  }
  return abi.decodeFunctionResult(method, raw);
}

function quote(
  kind: LaunchpadBuyQuote['kind'],
  estimatedOutput: bigint,
  to: string,
  value: bigint,
  encodeSwap: (minimumOutput: bigint) => string,
): LaunchpadBuyQuote {
  return {
    kind,
    estimatedOutput,
    buildData(minimumOutput) {
      if (minimumOutput <= 0n || minimumOutput > estimatedOutput) throw new Error('Invalid minimum token amount.');
      return { to, data: encodeSwap(minimumOutput), value };
    },
  };
}

async function quoteFourBuy(input: LaunchpadBuyInput): Promise<LaunchpadBuyQuote | null> {
  const { token, value } = input;
  const info = await call(input, fourHelper, fourAbi, 'getTokenInfo', [token], 12);
  const manager = info.version === 1n ? fourV1Manager : info.version === 2n ? fourV2Manager : null;
  if (!manager || info.tokenManager.toLowerCase() !== manager || info.quote !== ZeroAddress
      || info.offers === 0n || info.liquidityAdded) return null;

  const estimate = await call(input, fourHelper, fourAbi, 'tryBuy', [token, 0n, value], 8);
  if (estimate.tokenManager.toLowerCase() !== manager || estimate.quote !== ZeroAddress
      || estimate.estimatedAmount <= 0n || estimate.amountApproval !== 0n
      || estimate.amountMsgValue !== value || estimate.amountFunds !== value) return null;

  const method = info.version === 1n ? 'purchaseTokenAMAP' : 'buyTokenAMAP';
  // Both overloads without a recipient deliver the tokens to the signing wallet.
  return quote('fourmeme', estimate.estimatedAmount, manager, value,
    min => fourAbi.encodeFunctionData(method, [token, value, min]));
}

async function quoteFlapSwap(input: LaunchpadBuyInput, portal: string): Promise<LaunchpadBuyQuote | null> {
  const { token, value } = input;
  // The Portal applies per-wallet buy quotas, so the quote uses the actual signer as eth_call.from.
  const [output] = await call(input, portal, flapAbi, 'quoteExactInput', [[ZeroAddress, token, value]], 1);
  if (output <= 0n) return null;
  return quote('flap', output, portal, value,
    min => flapAbi.encodeFunctionData('swapExactInput', [[ZeroAddress, token, value, min, '0x']]));
}

async function quoteFlapBuy(input: LaunchpadBuyInput): Promise<LaunchpadBuyQuote | null> {
  const [state] = await call(input, flapPortal, flapAbi, 'getTokenV8Safe', [input.token], 18);
  if (state.quoteTokenAddress !== ZeroAddress && !state.nativeToQuoteSwapEnabled) return null;
  // Status 1 is the bonding curve. Status 4 uses the migration pool registered with Flap.
  if (state.status !== 1n && !(state.status === 4n && state.pool !== ZeroAddress)) return null;
  return quoteFlapSwap(input, flapPortal);
}

async function quoteFlapPoolBuy(input: LaunchpadBuyInput): Promise<LaunchpadBuyQuote | null> {
  const [state] = await call(input, flapPoolPortal, flapAbi, 'getLaunchToken', [input.token], 15);
  // Match the documented native-quoted direct V2 launch. Other kinds or quote assets need their own validation.
  if (state.kind !== 0n || state.tokenVersion !== 0n || state.externalVenue !== 1n || state.dexId !== 0n
      || state.quoteTokenType !== 0n || state.quoteTokenAddress !== ZeroAddress || state.status !== 4n
      || state.poolType !== 0n || state.venueData !== '0x' || state.pool === ZeroAddress) return null;
  const [pool] = await call(input, pancakeV2Factory, factoryAbi, 'getPair', [input.token, wrappedBnb], 1);
  if (pool !== state.pool) return null;
  return quoteFlapSwap(input, flapPoolPortal);
}

export async function quoteLaunchpadBuy(input: LaunchpadBuyInput): Promise<LaunchpadBuyQuote | null> {
  const token = getAddress(input.token);
  const wallet = getAddress(input.wallet);
  if (token === ZeroAddress || wallet === ZeroAddress || input.value <= 0n) return null;
  input.signal?.throwIfAborted();
  const request = { ...input, token, wallet };
  const quotes = await Promise.allSettled([quoteFourBuy(request), quoteFlapBuy(request), quoteFlapPoolBuy(request)]);
  input.signal?.throwIfAborted();
  for (const result of quotes) {
    if (result.status === 'fulfilled' && result.value) return result.value;
  }
  return null;
}
