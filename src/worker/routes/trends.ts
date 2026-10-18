import { Hono } from 'hono';
import { ledgerEntries } from '../../shared/actuals';
import { addMonths, monthEnd, monthOf, monthStart } from '../../shared/dates';
import { buildTrends, whatChanged } from '../../shared/trends';
import type { AppEnv } from '../env';
import { optInt } from '../lib/http';
import { loadCategories } from '../services/context';
import { loadLedger } from '../services/ledger';

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
  const current = monthOf(today);
  const monthsBack = (n: number) => Array.from({ length: n }, (_, i) => addMonths(current, i - n + 1));
  const wide = monthsBack(Math.max(shown, MONTHS_FOR_CHANGES));

  const [ledger, categoryRows] = await Promise.all([
    loadLedger(db, monthStart(wide[0]!), monthEnd(current)),
    loadCategories(db),
  ]);
  const entries = ledgerEntries(ledger);
  const categories = categoryRows.map((r) => ({ id: r.id, name: r.name, section: r.sectionName, funMemberId: r.funMemberId }));

  const all = buildTrends({ entries, categories, months: wide, today });
  const result = shown === wide.length ? all : buildTrends({ entries, categories, months: monthsBack(shown), today });
  // Usual and what changed come from the wider range, so they don't depend on how many months are shown.
  return c.json({ ...result, usual: all.usual, changed: whatChanged(all, today) });
});
