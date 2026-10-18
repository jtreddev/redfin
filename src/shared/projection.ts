import { addDays, addMonths, addMonthsToDate, diffDays, monthEnd, monthOf, type ISODate } from './dates';
import type { Cents } from './money';
import { payDatesBetween, type PaySchedule } from './paySchedule';
import type { Cadence } from './recurring';
import type { GroupKey } from './trends';

/**
 * "Until payday": cash from today to the day before the next payday, day by day. Pure, so the client can
 * re-run it with a what-if.
 */

export interface Payday {
  date: ISODate;
  /** Every source paid that day, added up. */
  amountCents: Cents;
  name: string;
}

export interface ProjectionEvent {
  /** Stable within one response; "skip a bill" keys on it. */
  id: string;
  date: ISODate;
  name: string;
  /** Positive = money out. */
  amountCents: Cents;
  kind: 'bill' | 'budget' | 'oneoff';
}

/** Cents per day, by spending group. */
export interface DailySpend {
  everyday: Cents;
  habits: Cents;
  fun: Cents;
}

export interface WhatIf {
  /** 1 = usual, 0.75, 0.5, 0 = none. */
  habitsFactor?: number;
  /** 1 = usual, 0.9, 0.8. */
  everydayFactor?: number;
  /** An added cost, positive = money out. */
  addCents?: Cents;
  /** 'once' lands tomorrow; 'monthly' lands tomorrow and on the same day each month after. */
  addRepeat?: 'once' | 'monthly';
  /** Event ids left out. */
  skip?: readonly string[];
}

export interface ProjectionInput {
  today: ISODate;
  startBalanceCents: Cents;
  payday: Payday | null;
  events: readonly ProjectionEvent[];
  dailySpend: DailySpend;
  lowBalanceCents: Cents;
  whatIf?: WhatIf;
}

export interface ProjectionPoint {
  date: ISODate;
  balanceCents: Cents;
}

export interface Projection {
  /** Today (the starting balance) first, then one per day to the last day. */
  points: ProjectionPoint[];
  payday: Payday | null;
  /** The last day shown: the day before payday, or the end of the month when there's no payday. */
  lastDate: ISODate;
  dayBeforeCents: Cents;
  lowest: ProjectionPoint;
  /** Free to spend until payday: the lowest point above the cushion, never below 0. */
  freeCents: Cents;
  /** Events inside the window, on the day they're counted (overdue ones on tomorrow), by date. */
  events: ProjectionEvent[];
  spendTotalCents: Cents;
  note: string | null;
}

/** How far ahead a payday still counts as "next payday". */
export const PAYDAY_WITHIN_DAYS = 45;
/** Average days in a month, for turning a usual month into a day. */
export const DAYS_PER_MONTH = 30.4;
export const NO_PAYDAY_NOTE = 'No payday set up — showing to the end of the month';

export interface PaydaySource {
  name: string;
  netPayCents: Cents;
  schedule: PaySchedule;
  /** Expected paydays that already have a matching deposit. */
  receivedPayDates?: readonly ISODate[];
}

/**
 * The earliest expected payday after today, within 45 days, across sources. A payday that already has its
 * deposit is skipped; sources paid the same day add up. Null when there's none.
 */
export function nextPayday(sources: readonly PaydaySource[], today: ISODate): Payday | null {
  const end = addDays(today, PAYDAY_WITHIN_DAYS);
  const bySource = sources.map((s) => {
    const received = new Set(s.receivedPayDates ?? []);
    return { source: s, date: payDatesBetween(s.schedule, addDays(today, 1), end).find((d) => !received.has(d)) ?? null };
  });
  const dates = bySource.map((b) => b.date).filter((d): d is ISODate => d !== null).sort();
  const date = dates[0];
  if (date === undefined) return null;
  const paid = bySource.filter((b) => b.date === date).map((b) => b.source);
  return {
    date,
    amountCents: paid.reduce((sum, s) => sum + s.netPayCents, 0),
    name: paid.map((s) => s.name).join(' and '),
  };
}

/** With no payday: this month's end when it's at least 7 days away, otherwise next month's end. */
export function fallbackLastDate(today: ISODate): ISODate {
  const end = monthEnd(monthOf(today));
  return diffDays(end, today) >= 7 ? end : monthEnd(addMonths(monthOf(today), 1));
}

/** A bill's amount as a monthly average. */
export function monthlyEquivalent(amountCents: Cents, cadence: Cadence): Cents {
  const perYear = { weekly: 52, biweekly: 26, monthly: 12, quarterly: 4, yearly: 1 }[cadence];
  return Math.round((amountCents * perYear) / 12);
}

/**
 * Usual monthly spending in the groups the daily rate covers, less the confirmed bills filed in each group (as
 * monthly amounts), never below 0. Those bills come out as events, so they mustn't be in the daily rate too.
 */
export function usualLessBills(
  usual: Record<GroupKey, Cents>,
  bills: readonly { group: GroupKey | null; cadence: Cadence; amountCents: Cents }[],
): Record<'everyday' | 'habits' | 'fun', Cents> {
  const out = { everyday: usual.everyday, habits: usual.habits, fun: usual.fun };
  for (const b of bills) {
    if (b.group === 'everyday' || b.group === 'habits' || b.group === 'fun') out[b.group] -= monthlyEquivalent(Math.abs(b.amountCents), b.cadence);
  }
  return { everyday: Math.max(0, out.everyday), habits: Math.max(0, out.habits), fun: Math.max(0, out.fun) };
}

/** Cents per day after a what-if (whole cents). */
export function dailyTotal(daily: DailySpend, whatIf?: WhatIf): Cents {
  return (
    Math.round(daily.everyday * (whatIf?.everydayFactor ?? 1)) + Math.round(daily.habits * (whatIf?.habitsFactor ?? 1)) + Math.round(daily.fun)
  );
}

/**
 * What a what-if's lasting changes are worth over a year (positive = more money): the daily spending change
 * times 365, less a monthly added cost times 12. A one-off cost isn't lasting.
 */
export function yearlyChangeCents(daily: DailySpend, whatIf: WhatIf): Cents {
  const perDay = dailyTotal(daily) - dailyTotal(daily, whatIf);
  const monthly = whatIf.addRepeat === 'monthly' ? (whatIf.addCents ?? 0) : 0;
  return perDay * 365 - monthly * 12;
}

export function projectToPayday(input: ProjectionInput): Projection {
  const { today, whatIf } = input;
  const tomorrow = addDays(today, 1);
  const lastDate = input.payday ? addDays(input.payday.date, -1) : fallbackLastDate(today);

  // Overdue and due-today bills land tomorrow; anything on or after payday waits for the next one.
  const skip = new Set(whatIf?.skip ?? []);
  const events: ProjectionEvent[] = input.events
    .filter((e) => !skip.has(e.id))
    .map((e) => (e.date < tomorrow ? { ...e, date: tomorrow } : e));
  if (whatIf?.addCents) {
    for (let date = tomorrow, n = 0; date <= lastDate && n < 24; n++) {
      events.push({ id: `whatif-${n}`, date, name: 'Added cost', amountCents: whatIf.addCents, kind: 'oneoff' });
      if (whatIf.addRepeat !== 'monthly') break;
      date = addMonthsToDate(tomorrow, n + 1);
    }
  }
  const inWindow = events
    .filter((e) => e.date <= lastDate)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.amountCents - a.amountCents));

  const outByDate = new Map<ISODate, Cents>();
  for (const e of inWindow) outByDate.set(e.date, (outByDate.get(e.date) ?? 0) + e.amountCents);

  const perDay = dailyTotal(input.dailySpend, whatIf);
  const points: ProjectionPoint[] = [{ date: today, balanceCents: input.startBalanceCents }];
  let balance = input.startBalanceCents;
  let days = 0;
  for (let date = tomorrow; date <= lastDate; date = addDays(date, 1)) {
    balance -= perDay + (outByDate.get(date) ?? 0);
    points.push({ date, balanceCents: balance });
    days++;
  }

  // The earliest of equal lows: that's when it gets tight.
  const lowest = points.reduce((low, p) => (p.balanceCents < low.balanceCents ? p : low), points[0]!);
  return {
    points,
    payday: input.payday,
    lastDate: points.at(-1)!.date,
    dayBeforeCents: balance,
    lowest,
    freeCents: Math.max(0, lowest.balanceCents - input.lowBalanceCents),
    events: inWindow,
    spendTotalCents: perDay * days,
    note: input.payday ? null : NO_PAYDAY_NOTE,
  };
}
