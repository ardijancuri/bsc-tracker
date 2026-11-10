import { parseArgs } from 'node:util';
import { analyticsTimeZone } from '../shared/analytics.js';
import { pool } from './db.js';

try {
  const { values } = parseArgs({ options: { days: { type: 'string', default: '30' }, json: { type: 'boolean' } } });
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error('Use --days with a value from 1 to 366.');

  const { rows } = await pool.query<{ day: string; page_views: string; unique_visitors: string }>(`
    SELECT day::text, page_views::text, unique_visitors::text
    FROM public.website_analytics_daily
    WHERE day >= (now() AT TIME ZONE $1)::date - ($2::integer - 1)
    ORDER BY day DESC
  `, [analyticsTimeZone, days]);
  if (values.json) console.log(JSON.stringify({ timeZone: analyticsTimeZone, days, items: rows }, null, 2));
  else {
    console.log(`Website analytics · ${analyticsTimeZone} · opted-in browsers`);
    if (!rows.length) console.log('No recorded visits in this period.');
    else console.table(rows.map(row => ({
      Date: row.day,
      'Unique browsers': row.unique_visitors,
      'Page views': row.page_views,
    })));
  }
} catch (error) {
  const code = (error as { code?: string }).code;
  console.error(code?.startsWith('ERR_PARSE_ARGS') ? 'Use analytics:report with --days 1–366 and optional --json.'
    : code === '42P01' ? 'Website analytics has not been enabled on this database.'
    : code ? 'Could not read website analytics. Check the database connection.'
    : error instanceof Error ? error.message : 'Could not read website analytics.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
