import { createHash } from 'node:crypto';

export const watchCookieName = 'bscan_watch';
export const hashSecret = (value: string) => createHash('sha256').update(value).digest('hex');
export function sessionSecret(cookie: string | undefined) {
  const matches = (cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${watchCookieName}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(watchCookieName.length + 1);
  return /^[0-9a-f]{64}$/.test(value) ? value : null;
}
