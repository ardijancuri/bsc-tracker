import { afterEach, describe, expect, it, vi } from 'vitest';
afterEach(() => vi.unstubAllGlobals());
describe('compact summary batching', () => {
  it('batches six cards, coalesces late joins and isolates subscriber cancellation', async () => {
    vi.resetModules();
    const { requestNodePnlSummary } = await import('./nodePnlSummaryRequest');
    const wallet = '0x' + '1'.repeat(40), tokens = Array.from({ length: 6 }, (_, i) => '0x' + String(i + 2).repeat(40));
    let resolve!: (value: Response) => void;
    const fetcher = vi.fn((_url: string) => new Promise<Response>(done => { resolve = done; })); vi.stubGlobal('fetch', fetcher);
    const controllers = tokens.map(() => new AbortController());
    const work = tokens.map((token, i) => requestNodePnlSummary(wallet, token, controllers[i].signal));
    await Promise.resolve(); expect(fetcher).toHaveBeenCalledOnce();
    const late = requestNodePnlSummary(wallet, tokens[0], new AbortController().signal);
    const rejected = expect(work[0]).rejects.toMatchObject({ name: 'AbortError' }); controllers[0].abort();
    await Promise.resolve(); expect(fetcher).toHaveBeenCalledOnce();
    resolve(Response.json({ summaries: Object.fromEntries(tokens.map(token => [token, { tokenAddress: token, status: 'ready', snapshot: null }])) }));
    await rejected; expect((await late).tokenAddress).toBe(tokens[0]); await Promise.all(work.slice(1));
    expect(new URL(fetcher.mock.calls[0][0] as string, 'http://localhost').searchParams.get('tokens')?.split(',')).toHaveLength(6);
  });
});
