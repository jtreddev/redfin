import { Hono } from 'hono';
import { buildTrends, whatChanged } from '../../shared/trends';
import type { AppEnv } from '../env';
import { optInt } from '../lib/http';
import { loadTrendsInput, monthsBack } from '../services/trends';

/**
 * Months "what changed" needs: before day 7 it compares last month with the 3 months before it,
 * so the current month plus 4 full ones.
 */
const MONTHS_FOR_CHANGES = 5;

export const trends = new Hono<AppEnv>();

trends.get('/trends', async (c) => {
  const db = c.env.DB;
  const today = c.get('today');
  const shown = optInt(c.req.query('months'), 'months', { min: 3, max: 24 }) ?? 12;
  const wide = monthsBack(today, Math.max(shown, MONTHS_FOR_CHANGES));

  // The ledger loads from the start of the wide range only. That's enough to find where history begins
  // for "usual": it looks back at most 4 months (last month plus the 3 before it), all inside the wide
  // range, so history starting any earlier clamps nothing.
  const input = await loadTrendsInput(db, wide, today);

  const all = buildTrends(input);
  const result = shown === wide.length ? all : buildTrends({ ...input, months: monthsBack(today, shown) });
  // Usual and what changed come from the wider range, so they don't depend on how many months are shown.
  return c.json({ ...result, usual: all.usual, changed: whatChanged(all, today) });
});
