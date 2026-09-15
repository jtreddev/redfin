import { allocateLine, distribute, dueWeekPosition, type Timing } from './allocation';
import type { ISODate, MonthKey } from './dates';
import type { Cents } from './money';
import { extraPaychecks, payDatesInMonth, type PaySchedule } from './paySchedule';
import { monthWeeks, weekIndexOf, type MonthWeek } from './weeks';

/** One budget line as the forecast sees it. Savings transfers count as expense (cash leaving). */
export interface ForecastLine {
  id: string | number;
  kind: 'income' | 'expense';
  /** Positive planned amount for the month. */
  budgetCents: Cents;
  timing: Timing;
  dueDay?: number | null;
  /** Positive amounts already recorded against this line, by week position (0-based). */
  actualByWeek?: readonly Cents[];
}

export interface ForecastPaySource {
  id: string | number;
  netPayCents: Cents;
  schedule: PaySchedule;
  /** Expected paydays that already have a matching deposit. */
  receivedPayDates?: readonly ISODate[];
}

export interface ForecastInput {
  month: MonthKey;
  /** Household-local today. */
  today: ISODate;
  /** Cash on the first day of the month. */
  startingBalanceCents: Cents;
  lowBalanceCents: Cents;
  paySources: readonly ForecastPaySource[];
  lines: readonly ForecastLine[];
  /** Actual activity not tied to a budget line (paycheck deposits, unbudgeted spending), by week position. */
  otherActual?: { incomeByWeek?: readonly Cents[]; outflowByWeek?: readonly Cents[] };
}

export type BalanceStatus = 'ok' | 'low' | 'negative';

export interface ForecastWeek extends MonthWeek {
  isPast: boolean;
  isCurrent: boolean;
  /** The original plan. */
  plannedIncome: Cents;
  plannedOutflow: Cents;
  /** Recorded so far. */
  actualIncome: Cents;
  actualOutflow: Cents;
  /** Actual plus what is still expected; drives the balance. */
  projectedIncome: Cents;
  projectedOutflow: Cents;
  startBalance: Cents;
  endBalance: Cents;
  status: BalanceStatus;
}

export interface ForecastPayDate {
  sourceId: string | number;
  date: ISODate;
  weekIndex: number;
  received: boolean;
}

export interface Forecast {
  month: MonthKey;
  weeks: ForecastWeek[];
  payDates: ForecastPayDate[];
  extraPaychecks: number;
  /** Position of the week containing today, or null when today is outside the month. */
  currentWeekPosition: number | null;
  /** Unspent flexible ("even") budget still available this week. */
  flexibleLeftThisWeek: Cents;
  /** Still-expected amount per line, by week position. */
  remainingByLine: Map<string | number, Cents[]>;
  totals: {
    plannedIncome: Cents;
    plannedOutflow: Cents;
    actualIncome: Cents;
    actualOutflow: Cents;
    projectedIncome: Cents;
    projectedOutflow: Cents;
    endBalance: Cents;
  };
}

export function balanceStatus(balance: Cents, lowBalanceCents: Cents): BalanceStatus {
  if (balance < 0) return 'negative';
  if (balance < lowBalanceCents) return 'low';
  return 'ok';
}

/** 0 before the month starts, weeks.length after it ends. */
function positionOfToday(weeks: readonly MonthWeek[], today: ISODate): number {
  const first = weeks[0];
  if (!first || today < first.start) return 0;
  const i = weeks.findIndex((w) => today >= w.start && today <= w.end);
  return i === -1 ? weeks.length : i;
}

/**
 * What a line is still expected to cost (or bring in) in each week from position t on.
 *
 * - Due-day bills count as paid once at least half the budget has been recorded;
 *   an unpaid bill whose week has passed moves into the current week.
 * - Flexible lines keep each week's share. Under- or over-spending in past weeks is
 *   spread over the remaining weeks, and overspending this week eats into later weeks,
 *   so a $40 purchase lowers this week's remaining amount by exactly $40.
 */
export function remainingForLine(
  line: ForecastLine,
  month: MonthKey,
  weeks: readonly MonthWeek[],
  t: number,
): Cents[] {
  const out = weeks.map(() => 0);
  if (t >= weeks.length || line.budgetCents <= 0) return out;
  const actual = weeks.map((_, i) => line.actualByWeek?.[i] ?? 0);

  const duePosition = dueWeekPosition(line, month);
  if (duePosition !== null) {
    const recorded = actual.reduce((a, b) => a + b, 0);
    if (recorded * 2 >= line.budgetCents) return out;
    out[Math.max(duePosition, t)] = line.budgetCents - recorded;
    return out;
  }

  const planned = allocateLine({ amountCents: line.budgetCents, timing: line.timing }, month, weeks);
  let rollover = 0;
  for (let i = 0; i < t; i++) rollover += (planned[i] ?? 0) - (actual[i] ?? 0);
  const shares = distribute(rollover, weeks.slice(t).map((w) => w.days));

  let carry = 0;
  for (let i = t; i < weeks.length; i++) {
    const value = (planned[i] ?? 0) + (shares[i - t] ?? 0) - (actual[i] ?? 0) + carry;
    if (value < 0) {
      out[i] = 0;
      carry = value;
    } else {
      out[i] = value;
      carry = 0;
    }
  }
  return out;
}

export function buildForecast(input: ForecastInput): Forecast {
  const { month, today } = input;
  const weeks = monthWeeks(month);
  const t = positionOfToday(weeks, today);
  const zeros = () => weeks.map(() => 0);

  const plannedIncome = zeros();
  const plannedOutflow = zeros();
  const actualIncome = zeros();
  const actualOutflow = zeros();
  const remainingIncome = zeros();
  const remainingOutflow = zeros();

  const payDates: ForecastPayDate[] = [];
  let extra = 0;
  for (const source of input.paySources) {
    const received = new Set(source.receivedPayDates ?? []);
    extra += extraPaychecks(source.schedule, month);
    for (const date of payDatesInMonth(source.schedule, month)) {
      const position = weekIndexOf(date) - 1;
      const isReceived = received.has(date);
      plannedIncome[position] = (plannedIncome[position] ?? 0) + source.netPayCents;
      // A payday that has passed without a deposit is not counted on (conservative).
      if (!isReceived && date >= today) {
        remainingIncome[position] = (remainingIncome[position] ?? 0) + source.netPayCents;
      }
      payDates.push({ sourceId: source.id, date, weekIndex: position + 1, received: isReceived });
    }
  }

  let flexibleLeftThisWeek = 0;
  const remainingByLine = new Map<string | number, Cents[]>();
  for (const line of input.lines) {
    const isIncome = line.kind === 'income';
    const planned = allocateLine(
      { amountCents: Math.max(0, line.budgetCents), timing: line.timing, dueDay: line.dueDay },
      month,
      weeks,
    );
    const remaining = remainingForLine(line, month, weeks, t);
    remainingByLine.set(line.id, remaining);
    weeks.forEach((_, i) => {
      const actual = line.actualByWeek?.[i] ?? 0;
      if (isIncome) {
        plannedIncome[i] = (plannedIncome[i] ?? 0) + (planned[i] ?? 0);
        actualIncome[i] = (actualIncome[i] ?? 0) + actual;
        remainingIncome[i] = (remainingIncome[i] ?? 0) + (remaining[i] ?? 0);
      } else {
        plannedOutflow[i] = (plannedOutflow[i] ?? 0) + (planned[i] ?? 0);
        actualOutflow[i] = (actualOutflow[i] ?? 0) + actual;
        remainingOutflow[i] = (remainingOutflow[i] ?? 0) + (remaining[i] ?? 0);
      }
    });
    if (!isIncome && t < weeks.length && dueWeekPosition(line, month) === null) {
      flexibleLeftThisWeek += remaining[t] ?? 0;
    }
  }

  weeks.forEach((_, i) => {
    actualIncome[i] = (actualIncome[i] ?? 0) + (input.otherActual?.incomeByWeek?.[i] ?? 0);
    actualOutflow[i] = (actualOutflow[i] ?? 0) + (input.otherActual?.outflowByWeek?.[i] ?? 0);
  });

  let balance = input.startingBalanceCents;
  const forecastWeeks: ForecastWeek[] = weeks.map((week, i) => {
    const projectedIncome = (actualIncome[i] ?? 0) + (remainingIncome[i] ?? 0);
    const projectedOutflow = (actualOutflow[i] ?? 0) + (remainingOutflow[i] ?? 0);
    const startBalance = balance;
    balance = startBalance + projectedIncome - projectedOutflow;
    return {
      ...week,
      isPast: i < t,
      isCurrent: i === t && today >= week.start,
      plannedIncome: plannedIncome[i] ?? 0,
      plannedOutflow: plannedOutflow[i] ?? 0,
      actualIncome: actualIncome[i] ?? 0,
      actualOutflow: actualOutflow[i] ?? 0,
      projectedIncome,
      projectedOutflow,
      startBalance,
      endBalance: balance,
      status: balanceStatus(balance, input.lowBalanceCents),
    };
  });

  const sum = (key: keyof ForecastWeek) =>
    forecastWeeks.reduce((total, w) => total + (w[key] as number), 0);

  const inMonth = t < weeks.length && today >= (weeks[0]?.start ?? today);
  return {
    month,
    weeks: forecastWeeks,
    payDates,
    extraPaychecks: extra,
    currentWeekPosition: inMonth ? t : null,
    flexibleLeftThisWeek: inMonth ? flexibleLeftThisWeek : 0,
    remainingByLine,
    totals: {
      plannedIncome: sum('plannedIncome'),
      plannedOutflow: sum('plannedOutflow'),
      actualIncome: sum('actualIncome'),
      actualOutflow: sum('actualOutflow'),
      projectedIncome: sum('projectedIncome'),
      projectedOutflow: sum('projectedOutflow'),
      endBalance: balance,
    },
  };
}
