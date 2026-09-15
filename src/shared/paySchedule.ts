import {
  addDays,
  addMonths,
  clampDay,
  diffDays,
  monthEnd,
  monthOf,
  monthStart,
  parseDate,
  previousWeekday,
  type ISODate,
  type MonthKey,
} from './dates';

export type PayFrequency = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';

export interface PaySchedule {
  frequency: PayFrequency;
  /** Any real payday. Weekly/biweekly step from it; monthly uses its day of month. */
  anchorDate: ISODate;
  /** Semimonthly paydays, e.g. [15, 31] (31 = last day). */
  semimonthlyDays?: [number, number];
}

/** Paychecks in an ordinary month. Anything above this is an "extra paycheck" month. */
export const REGULAR_PAYS_PER_MONTH: Record<PayFrequency, number> = {
  weekly: 4,
  biweekly: 2,
  semimonthly: 2,
  monthly: 1,
};

export function payDatesBetween(schedule: PaySchedule, start: ISODate, end: ISODate): ISODate[] {
  if (end < start) return [];

  if (schedule.frequency === 'weekly' || schedule.frequency === 'biweekly') {
    const step = schedule.frequency === 'weekly' ? 7 : 14;
    const k = Math.ceil(diffDays(start, schedule.anchorDate) / step);
    const dates: ISODate[] = [];
    for (let d = addDays(schedule.anchorDate, k * step); d <= end; d = addDays(d, step)) {
      dates.push(d);
    }
    return dates;
  }

  const days =
    schedule.frequency === 'monthly'
      ? [parseDate(schedule.anchorDate).d]
      : (schedule.semimonthlyDays ?? [15, 31]);
  const found = new Set<ISODate>();
  // A weekend shift can pull next month's first payday back into range, so look one month past.
  const lastMonth = addMonths(monthOf(end), 1);
  for (let month = monthOf(start); month <= lastMonth; month = addMonths(month, 1)) {
    for (const day of days) {
      const date = previousWeekday(clampDay(month, day));
      if (date >= start && date <= end) found.add(date);
    }
  }
  return [...found].sort();
}

export function payDatesInMonth(schedule: PaySchedule, month: MonthKey): ISODate[] {
  return payDatesBetween(schedule, monthStart(month), monthEnd(month));
}

/** How many paychecks above the usual count land in this month (e.g. a 5th weekly check). */
export function extraPaychecks(schedule: PaySchedule, month: MonthKey): number {
  return Math.max(0, payDatesInMonth(schedule, month).length - REGULAR_PAYS_PER_MONTH[schedule.frequency]);
}

/**
 * The expected payday a deposit belongs to. Deposits often land early (Chime pays up to
 * two days before payday), so match to the nearest payday within the window rather than
 * the week the money arrived in.
 */
export function nearestPayDate(
  schedule: PaySchedule,
  depositDate: ISODate,
  windowDays = 3,
): ISODate | null {
  const candidates = payDatesBetween(
    schedule,
    addDays(depositDate, -windowDays),
    addDays(depositDate, windowDays),
  );
  let best: ISODate | null = null;
  for (const date of candidates) {
    if (best === null || Math.abs(diffDays(date, depositDate)) < Math.abs(diffDays(best, depositDate))) {
      best = date;
    }
  }
  return best;
}
