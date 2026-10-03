import { pool } from './db.js';
import { chineseTokenName, type TokenTranslation } from '../shared/tokenTranslation.js';
export { chineseTokenName } from '../shared/tokenTranslation.js';

const han = /\p{Script=Han}/u;
function decodeEntities(value: string) {
  const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, code: string) => {
    if (!code.startsWith('#')) return named[code.toLowerCase()] || entity;
    const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : entity;
  });
}

export function translatedName(body: unknown, source: string): string | null {
  if (!body || typeof body !== 'object') return null;
  const result = body as { responseStatus?: number | string; quotaFinished?: boolean; responseData?: { translatedText?: unknown } };
  if (Number(result.responseStatus) !== 200 || result.quotaFinished || typeof result.responseData?.translatedText !== 'string') return null;
  const text = decodeEntities(result.responseData.translatedText).trim().replace(/\s+/g, ' ');
  if (!text || text.length > 300 || text === source || han.test(text) || !/[a-z]/i.test(text) || /[<>\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

export async function fetchEnglishName(source: string): Promise<{ text: string | null; limited: boolean }> {
  const url = new URL('https://api.mymemory.translated.net/get');
  url.searchParams.set('q', source);
  url.searchParams.set('langpair', 'zh-CN|en');
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (response.status === 429) return { text: null, limited: true };
    if (!response.ok) return { text: null, limited: false };
    const body = await response.json() as { quotaFinished?: boolean; responseStatus?: number | string };
    return { text: translatedName(body, source), limited: body.quotaFinished === true || Number(body.responseStatus) === 429 };
  } catch { return { text: null, limited: false }; }
}

const pending = new Map<string, Promise<string | null>>();
async function translateCached(source: string): Promise<string | null> {
  const cached = await pool.query('SELECT english_name,retry_at FROM token_name_translations WHERE source_text=$1', [source]);
  if (cached.rows[0]?.english_name) return cached.rows[0].english_name;
  if (cached.rows[0]?.retry_at && new Date(cached.rows[0].retry_at).getTime() > Date.now()) return null;
  const existing = pending.get(source);
  if (existing) return existing;
  if (pending.size >= 2) return null;
  const request = (async () => {
    const client = await pool.connect();
    let locked = false;
    try {
      await client.query('BEGIN');
      const lock = await client.query(`SELECT pg_try_advisory_lock(hashtext('token-name-translation'),hashtext($1)) AS acquired`, [source]);
      locked = Boolean(lock.rows[0].acquired);
      if (!lock.rows[0].acquired) { await client.query('COMMIT'); return null; }
      const current = await client.query('SELECT english_name,retry_at FROM token_name_translations WHERE source_text=$1', [source]);
      if (current.rows[0]?.english_name || current.rows[0]?.retry_at && new Date(current.rows[0].retry_at).getTime() > Date.now()) {
        await client.query('COMMIT'); return current.rows[0].english_name ?? null;
      }
      // Reserve the shared daily allowance before calling the provider; retries also consume it.
      const budget = await client.query(`INSERT INTO token_translation_usage(day,characters) VALUES((now() AT TIME ZONE 'UTC')::date,$1)
        ON CONFLICT(day) DO UPDATE SET characters=token_translation_usage.characters+EXCLUDED.characters
        WHERE token_translation_usage.characters+EXCLUDED.characters<=5000 AND (token_translation_usage.paused_until IS NULL OR token_translation_usage.paused_until<=now()) RETURNING day`, [[...source].length]);
      if (!budget.rowCount) { await client.query('COMMIT'); return null; }
      // Release the allowance row before network I/O so other names are not blocked.
      await client.query('COMMIT');
      const result = await fetchEnglishName(source);
      await client.query(`INSERT INTO token_name_translations(source_text,english_name,checked_at,retry_at) VALUES($1,$2,now(),now()+interval '1 hour')
        ON CONFLICT(source_text) DO UPDATE SET english_name=COALESCE(EXCLUDED.english_name,token_name_translations.english_name),checked_at=now(),retry_at=EXCLUDED.retry_at`, [source, result.text]);
      if (result.limited) await client.query(`UPDATE token_translation_usage SET paused_until=now()+interval '24 hours' WHERE day=(now() AT TIME ZONE 'UTC')::date`);
      return result.text;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally {
      try { if (locked) await client.query(`SELECT pg_advisory_unlock(hashtext('token-name-translation'),hashtext($1))`, [source]); }
      finally { client.release(); }
    }
  })().finally(() => pending.delete(source));
  pending.set(source, request);
  return request;
}

export async function getTokenTranslation(address: string): Promise<TokenTranslation> {
  const token = await pool.query(`SELECT name,symbol FROM tokens v WHERE address=$1 AND EXISTS(
    SELECT 1 FROM trades t JOIN kols k ON k.address=t.wallet_address WHERE t.token_address=v.address AND k.is_tracked AND t.block_number IS NOT NULL)`, [address]);
  const source = token.rows[0] ? chineseTokenName(token.rows[0]) : null;
  return { tokenAddress: address, sourceText: source, englishName: source ? await translateCached(source) : null };
}
