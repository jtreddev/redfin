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
  usualLessBills,
} from '../../shared/projection';
import { projectMonths, type MonthsAheadInput } from '../../shared/monthsAhead';
import { aheadEvents, aheadLines } from '../../shared/planAhead';
import type { AppEnv } from '../env';
import { loadForecastInputs, withoutSetAside } from '../services/forecastInputs';
import { loadMonthsAheadInput } from '../services/monthsAhead';
import { all } from '../lib/db';
import { aheadDebt, loadDebts, takenByPlan } from '../services/debts';
import { upcomingBills } from '../services/planner';

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

  const inputs = await loadForecastInputs(db, today, viewer.memberId, household, {
    payUntil: addDays(today, PAYDAY_WITHIN_DAYS),
    trendsMonths: USUAL_MONTHS,
  });
  const { cash, planner, setAside } = inputs;
  const payday = nextPayday(inputs.sources, today);
  const lastDate = payday ? addDays(payday.date, -1) : fallbackLastDate(today);

  // This month's due-day lines, recurring bills (every time they come up) and, past the month end, next
  // month's due-day lines (P6-R3b), to the last day.
  const [bills, debts, goals] = await Promise.all([
    upcomingBills(db, planner, today, viewer.memberId, { until: lastDate, repeat: true, laterMonths: true }),
    loadDebts(db, viewer.memberId),
    all<{ id: number; name: string; categoryId: number | null; monthlyCents: number }>(
      db,
      'SELECT id, name, category_id AS categoryId, monthly_cents AS monthlyCents FROM goals WHERE archived = 0 AND monthly_cents IS NOT NULL',
    ),
  ]);
  // The saved plan (Plan › Ahead): from next month its debt payments and goal amounts stand in for the bills and
  // lines they own.
  const parentOf = new Map(planner.data.rows.map((r) => [r.categoryId, r.parentId]));
  const taken = takenByPlan(debts, parentOf, monthOf(today), new Set(goals.flatMap((g) => (g.categoryId === null ? [] : [g.categoryId]))));
  const planEvents = aheadEvents({ debts: debts.map(aheadDebt), goals, debtExtra: Object.fromEntries(debts.map((d) => [d.id, d.extraCents])) }, today, lastDate);
  // Planned-cost set-asides stay in the account, so they aren't taken off (P6-R5). Home says "before set-asides".
  const events: ProjectionEvent[] = bills
    .filter((b) => !taken(b))
    .map((b, i): ProjectionEvent => ({
      id: `${b.source}-${i}`,
      date: b.date,
      name: b.name,
      amountCents: withoutSetAside(b, inputs),
      kind: b.source === 'budget' ? 'budget' : 'bill',
    }))
    .filter((e) => e.amountCents > 0)
    .concat(planEvents)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Bills and Saving are left out: their money is in the events (P6-R4). So are confirmed bills filed under
  // Everyday, Habits or Fun: they come out as events too. The viewer's private bills come out of fun, where
  // Trends counts private charges.
  const usual = usualLessBills(inputs.trends.usual, inputs.confirmed);
  const perDay = (monthly: number) => Math.max(0, Math.round(monthly / DAYS_PER_MONTH));
  const input: ProjectionInput = {
    today,
    startBalanceCents: cash.total,
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
    hasBalance: cash.counted > 0,
  });
});

/**
 * Months ahead: the inputs for the rest of this month and the next 12, and the 12-month projection. The client
 * re-runs projectMonths on the inputs for 3 or 6 months and for a what-if.
 */
forecast.get('/forecast/months', async (c) => {
  const db = c.env.DB;
  const today = c.get('today');
  const { input, saved, hasBalance, hasIncome } = await loadMonthsAheadInput(db, today, c.get('viewer').memberId, c.get('household'));
  // The saved plan's lines (Plan › Ahead), so a re-run for 3 or 6 months or a what-if keeps them.
  const withPlan: MonthsAheadInput = { ...input, ahead: aheadLines(input, saved, 12) };
  return c.json({ today, input: withPlan, projection: projectMonths(withPlan, 12), hasBalance, hasIncome });
});
