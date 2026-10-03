import { describe, expect, it } from 'vitest';
import { todayStart } from './dayWindow.js';

describe('Skopje calendar-day leaderboard window', () => {
  it.each([
    ['2026-10-03T02:00:00Z', '2026-10-02T22:00:00.000Z'],
    ['2026-10-02T21:59:59Z', '2026-10-01T22:00:00.000Z'],
    ['2026-10-02T22:00:00Z', '2026-10-02T22:00:00.000Z'],
    ['2026-01-03T12:00:00Z', '2026-01-02T23:00:00.000Z'],
    ['2026-03-29T12:00:00Z', '2026-03-28T23:00:00.000Z'],
    ['2026-10-25T12:00:00Z', '2026-10-24T22:00:00.000Z'],
  ])('calculates local midnight for %s', (time, start) => {
    expect(todayStart(Date.parse(time))).toBe(start);
  });
});
