import type { FastifyInstance } from 'fastify';
import { championshipLastDay, validChampionshipDate, type ChampionshipPeriod } from '../shared/championship.js';
import { createChampionshipService } from './championship.js';
import { pool } from './db.js';

export function registerChampionshipRoutes(app: FastifyInstance, service = createChampionshipService({ store: {
  async load(key) {
    return (await pool.query('SELECT value FROM worker_state WHERE key=$1', [`championship:ggc-s1:${key}`])).rows[0]?.value;
  },
  async save(key, value) {
    await pool.query(`INSERT INTO worker_state(key,value) VALUES($1,$2::jsonb)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [`championship:ggc-s1:${key}`, JSON.stringify(value)]);
  },
} })) {
  app.get<{ Querystring: { period?: string; date?: string; refresh?: string } }>('/api/championship', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const period = request.query.period ?? 'daily';
    if (period !== 'daily' && period !== 'overall') return reply.code(400).send({ error: 'Invalid championship period' });
    const date = period === 'daily' ? request.query.date ?? championshipLastDay() : null;
    if (date !== null && !validChampionshipDate(date)) return reply.code(400).send({ error: 'Invalid championship date' });
    if (request.query.refresh !== undefined && request.query.refresh !== '1') return reply.code(400).send({ error: 'Invalid championship refresh' });
    try {
      return request.query.refresh === '1'
        ? await service.get(period as ChampionshipPeriod, date, { refresh: true })
        : await service.get(period as ChampionshipPeriod, date);
    }
    catch { return reply.code(503).header('Retry-After', '60').send({ error: 'Championship rankings are unavailable' }); }
  });
}
