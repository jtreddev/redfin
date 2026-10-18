import { Hono } from 'hono';
import { addDays, monthOf } from '../../shared/dates';
import {
  DAYS_PER_MONTH,
  fallbackLastDate,
  nextPayday,
  PAYDAY_WITHIN_DAYS,
  projectToPayday,
  type ProjectionEvent,
  type ProjectionInput,
} from '../../shared/projection';
import { buildTrends } from '../../shared/trends';
import type { AppEnv } from '../env';
import { all, first } from '../lib/db';
import { loadIncomeSources, scheduleOf } from '../services/context';
import { buildPlanner, CASH_ACCOUNTS_WHERE, upcomingBills } from '../services/planner';
import { loadTrendsInput, monthsBack } from '../services/trends';

/** "Usual" is the last 3 full months, so the current month plus 3. */
const USUAL_MONTHS = 4;

export const forecast = new Hono<AppEnv>();

/**
 * Until payday: today's cash, the next payday, the bills before it and the usual daily spending, plus the
 * projection worked out from them. The inputs come back too, so the client can re-run it with a what-if.
 */
forecast.get('/forecast', async (c) => {
  const db = c.env.DB;
  const today = c.get('today');
  const viewer = c.get('viewer');
  const household = c.get('household');

  const [cash, sources, received, planner, trendsInput] = await Promise.all([
    first<{ total: number; counted: number }>(
      db,
      `SELECT COALESCE(SUM(current_balance_cents), 0) AS total, COUNT(current_balance_cents) AS counted FROM accounts WHERE ${CASH_ACCOUNTS_WHERE}`,
    ),
    loadIncomeSources(db),
    all<{ sourceId: number; payDate: string }>(
      db,
      `SELECT DISTINCT income_source_id AS sourceId, pay_date AS payDate FROM transactions
        WHERE deleted_at IS NULL AND is_ignored = 0 AND income_source_id IS NOT NULL AND pay_date BETWEEN ? AND ?`,
      addDays(today, 1),
      addDays(today, PAYDAY_WITHIN_DAYS),
    ),
    buildPlanner(db, monthOf(today), household, today),
    loadTrendsInput(db, monthsBack(today, USUAL_MONTHS), today),
  ]);

  const payday = nextPayday(
    sources.map((s) => ({
      name: s.name,
      netPayCents: s.netPayCents,
      schedule: scheduleOf(s),
      receivedPayDates: received.filter((r) => r.sourceId === s.id).map((r) => r.payDate),
    })),
    today,
  );
  const lastDate = payday ? addDays(payday.date, -1) : fallbackLastDate(today);

  // This month's due-day lines, then recurring bills (every time they come up) to the last day. A payday
  // next month gets no due-day lines for next month: its budget may not exist yet (P6-R3).
  const bills = await upcomingBills(db, planner, today, viewer.memberId, { until: lastDate, repeat: true });
  // Planned-cost set-asides stay in the account, so they aren't taken off (P6-R5): a due-day savings line
  // counts only its hand part. Home says "before set-asides".
  const setAside = new Map(planner.data.rows.filter((r) => r.plannedCostsCents > 0).map((r) => [r.categoryId, r.plannedCostsCents]));
  const events: ProjectionEvent[] = bills
    .map((b, i): ProjectionEvent => ({
      id: `${b.source}-${i}`,
      date: b.date,
      name: b.name,
      amountCents: b.source === 'budget' && b.categoryId !== null ? Math.max(0, b.amountCents - (setAside.get(b.categoryId) ?? 0)) : b.amountCents,
      kind: b.source === 'budget' ? 'budget' : 'bill',
    }))
    .filter((e) => e.amountCents > 0);

  // Bills and Saving are left out: their money is in the events (P6-R4).
  const usual = buildTrends(trendsInput).usual;
  const perDay = (monthly: number) => Math.max(0, Math.round(monthly / DAYS_PER_MONTH));
  const input: ProjectionInput = {
    today,
    startBalanceCents: cash?.total ?? 0,
    payday,
    events,
    dailySpend: { everyday: perDay(usual.everyday), habits: perDay(usual.habits), fun: perDay(usual.fun) },
    lowBalanceCents: household.lowBalanceCents,
  };

  return c.json({
    today,
    input,
    projection: projectToPayday(input),
    hasSetAsides: setAside.size > 0,
    // No cash account has a balance (e.g. only imported files): there's nothing to start from.
    hasBalance: (cash?.counted ?? 0) > 0,
  });
});
