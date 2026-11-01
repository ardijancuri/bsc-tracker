import {describe,it,expect} from 'vitest';
import {tradeReplayDuration,MIN_TRADE_REPLAY_SECONDS,MAX_TRADE_REPLAY_SECONDS} from './tradeReplayTiming';
const minute=60_000;
describe('real-period trade replay duration',()=>{
  it.each([[0,8],[.5,8],[2,9],[10,11],[60,14],[360,17],[1440,20],[4320,23],[10080,25]] as const)
    ('gives a %s-minute position %s seconds', (minutes,seconds)=>{
      expect(tradeReplayDuration(0,minutes*minute,2)).toBe(seconds);
    });
  it('scales continuously across bucket boundaries and stays monotonic across seconds, hours and weeks',()=>{
    let previous=MIN_TRADE_REPLAY_SECONDS;
    for(let seconds=0;seconds<=14*86400;seconds+=137){
      const duration=tradeReplayDuration(0,seconds*1000,2);
      expect(duration).toBeGreaterThanOrEqual(previous);
      expect(duration).toBeLessThanOrEqual(MAX_TRADE_REPLAY_SECONDS);
      expect(duration*30).toBe(Math.round(duration*30));previous=duration;
    }
    for(const seconds of [30,120,600,3600,21600,86400,259200,604800]){
      expect(tradeReplayDuration(0,(seconds+.001)*1000,2)-tradeReplayDuration(0,(seconds-.001)*1000,2)).toBeLessThanOrEqual(.5);
    }
  });
  it('reserves reading time for dense fills without making duration unbounded',()=>{
    expect(tradeReplayDuration(0,1000,2)).toBe(8);
    expect(tradeReplayDuration(0,1000,18)).toBe(12.5);
    expect(tradeReplayDuration(0,1000,40)).toBe(15);
    expect(tradeReplayDuration(0,1000,1000000)).toBe(20);
    expect(tradeReplayDuration(0,14*86400*1000,1000000)).toBe(25);
  });
  it('does not depend on the calendar date and handles missing/reversed time safely',()=>{
    const start=Date.parse('2026-11-01T00:00:00Z');
    expect(tradeReplayDuration(start,start+3600*1000,2)).toBe(tradeReplayDuration(0,3600*1000,2));
    for(const [from,to]of [[NaN,0],[0,NaN],[0,Infinity],[Infinity,0],[1000,0]])expect(tradeReplayDuration(from,to,2)).toBe(8);
    expect(tradeReplayDuration(0,0,NaN)).toBe(8);
  });
});
