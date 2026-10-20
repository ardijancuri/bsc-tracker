import { describe, expect, it } from 'vitest';
import { historicalChartSegments,historicalFailureChartWindows,uncoveredChartWindows } from './nodeTokenChartRecovery.js';
describe('coalesced historical token chart windows', () => {
  const to = Date.parse('2026-10-19T19:46:07Z');
  it.each([[60, 86400], [300, 432000], [3600, 2592000], [14400, 7776000], [86400, 15552000]])('bounds %ss requests in fixed completed segments', (seconds, span) => {
    const windows = historicalChartSegments(to - span * 1000, to, seconds);
    expect(windows.length).toBeLessThanOrEqual(4);
    expect(Date.parse(windows[0].from)).toBeLessThanOrEqual(to - span * 1000);
    expect(Date.parse(windows.at(-1)!.to)).toBe(Math.floor(to / (seconds * 1000)) * seconds * 1000);
    for (const window of windows) expect((Date.parse(window.to) - Date.parse(window.from)) / seconds / 1000).toBeLessThanOrEqual(1000);
    expect(historicalChartSegments(to - span * 1000 + 1000, to, seconds)).toEqual(windows);
  });
  it('rejects unbounded or invalid work without contacting a provider', () => {
    expect(() => historicalChartSegments(1, to, 60)).toThrow('import_chart_window_too_large');
    expect(() => historicalChartSegments(to, to, 60)).toThrow('import_chart_window_invalid');
    expect(() => historicalChartSegments(to - 1000, to, 15)).toThrow('import_chart_window_invalid');
  });
});
describe('selected chart coverage recovery',()=>{
  const from=Date.parse('2026-10-19T00:00:00Z'),to=from+20*3600_000;
  it('does not mistake captured no-swap minutes for missing candles',()=>{
    expect(uncoveredChartWindows(from,to,[{from:new Date(from).toISOString(),to:new Date(to).toISOString()}],{seconds:60})).toEqual([]);
  });
  it('prioritizes bounded recent internal gaps instead of revisiting completed tail pages',()=>{
    const windows=uncoveredChartWindows(from,to,[
      {from:new Date(from).toISOString(),to:new Date(from+3600_000).toISOString()},
      {from:new Date(from+4*3600_000).toISOString(),to:new Date(from+6*3600_000).toISOString()},
      {from:new Date(from+19*3600_000).toISOString(),to:new Date(to).toISOString()},
    ],{seconds:60,maxWindows:1,maxSpanMs:30*60_000});
    expect(windows).toEqual([{from:from+18.5*3600_000,to:from+19*3600_000}]);
  });
  it('merges overlapping proofs and tolerates the genuine inter-block timestamp boundary',()=>{
    expect(uncoveredChartWindows(from,to,[{from:new Date(from).toISOString(),to:new Date(from+3600_000).toISOString()},
      {from:new Date(from+3599_000).toISOString(),to:new Date(from+10*3600_000).toISOString()},
      {from:new Date(from+10*3600_000+3000).toISOString(),to:new Date(to).toISOString()}],{seconds:60})).toEqual([]);
  });
  it('does not let collected logs mask missing historical prices, but reuses completed provider proof',()=>{
    const failures=[{from:new Date(from+3600_000).toISOString(),to:new Date(from+3*3600_000).toISOString()}];
    const captured=[{from:new Date(from).toISOString(),to:new Date(to).toISOString(),source:'node' as const}];
    expect(historicalFailureChartWindows(from,to,failures,captured,60)).toEqual([{from:from+3600_000,to:from+3*3600_000}]);
    expect(historicalFailureChartWindows(from,to,failures,[...captured,{...failures[0],source:'imported'}],60)).toEqual([]);
  });
  it('bounds unavailable history recovery to the selected page and the newest two genuine gaps',()=>{
    const failures=[0,4,8,12].map(hour=>({from:new Date(from+hour*3600_000).toISOString(),to:new Date(from+(hour+2)*3600_000).toISOString()}));
    expect(historicalFailureChartWindows(from+5*3600_000,from+13*3600_000,failures,[],60)).toEqual([
      {from:from+12*3600_000,to:from+13*3600_000},{from:from+8*3600_000,to:from+10*3600_000},
    ]);
  });
  it('recovers the genuine completed bucket for a sub-minute frozen ending without dropping it',()=>{
    const first=from+23000,last=from+40000;
    expect(uncoveredChartWindows(first,last,[],{seconds:60})).toEqual([]);
    expect(uncoveredChartWindows(first,last,[],{seconds:60,includePartialBuckets:true})).toEqual([{from,to:from+60000}]);
    expect(historicalFailureChartWindows(first,last,[{from:new Date(from).toISOString(),to:new Date(from+60000).toISOString()}],[],60,true))
      .toEqual([{from,to:from+60000}]);
  });
});
