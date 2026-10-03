export const leaderboardTimeZone = 'Europe/Skopje';

export function last24hStart(now = Date.now()): string {
  return new Date(now - 24 * 60 * 60_000).toISOString();
}

export function todayStart(now = Date.now(), timeZone = leaderboardTimeZone): string {
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const parts = (time: number) => Object.fromEntries(formatter.formatToParts(time).map(part => [part.type, part.value]));
  const local = parts(now);
  const midnight = Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day));
  let start = midnight;
  for (let attempt = 0; attempt < 3; attempt++) {
    const clock = parts(start);
    const localTime = Date.UTC(Number(clock.year), Number(clock.month) - 1, Number(clock.day), Number(clock.hour), Number(clock.minute), Number(clock.second));
    start = midnight - (localTime - start);
  }
  return new Date(start).toISOString();
}
