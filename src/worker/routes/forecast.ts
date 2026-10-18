import { Hono } from 'hono';
import { addDays } from '../../shared/dates';
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
import { projectMonths } from '../../shared/monthsAhead';
import type { AppEnv } from '../env';
import { loadForecastInputs, withoutSetAside } from '../services/forecastInputs';
import { loadMonthsAheadInput } from '../services/monthsAhead';
import { upcomingBills } from '../services/planner';
import { goalsWithProgress } from './planning';

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
  const bills = await upcomingBills(db, planner, today, viewer.memberId, { until: lastDate, repeat: true, laterMonths: true });
  // Planned-cost set-asides stay in the account, so they aren't taken off (P6-R5). Home says "before set-asides".
  const events: ProjectionEvent[] = bills
    .map((b, i): ProjectionEvent => ({
      id: `${b.source}-${i}`,
      date: b.date,
      name: b.name,
      amountCents: withoutSetAside(b, inputs),
      kind: b.source === 'budget' ? 'budget' : 'bill',
    }))
    .filter((e) => e.amountCents > 0);

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
  const { input, ledger, hasBalance, hasIncome } = await loadMonthsAheadInput(db, today, c.get('viewer').memberId, c.get('household'));
  // Goals reuse the ledger just loaded when it reaches back far enough (fewer D1 queries).
  const goals = await goalsWithProgress(db, today, false, ledger);
  input.goals = goals.map((g) => ({ name: g.name, remainingCents: g.progress.remainingCents, recentAverageCents: g.progress.recentAverageCents }));
  return c.json({ today, input, projection: projectMonths(input, 12), hasBalance, hasIncome });
});
