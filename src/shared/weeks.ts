import { makeDate, monthLength, parseDate, parseMonth, type ISODate, type MonthKey } from './dates';

/**
 * Budget weeks, carried over from the original spreadsheet: days 1–7, 8–14, 15–21,
 * 22–28 and 29–end. With weekly pay exactly one payday lands in each full week.
 * A 28-day February has no week 5.
 */
export interface MonthWeek {
  /** 1-based week number. */
  index: number;
  start: ISODate;
  end: ISODate;
  days: number;
}

const WEEK_START_DAYS = [1, 8, 15, 22, 29] as const;

export function monthWeeks(month: MonthKey): MonthWeek[] {
  const { y, m } = parseMonth(month);
  const dim = monthLength(month);
  const weeks: MonthWeek[] = [];
  WEEK_START_DAYS.forEach((startDay, i) => {
    if (startDay > dim) return;
    const endDay = i < WEEK_START_DAYS.length - 1 ? Math.min(startDay + 6, dim) : dim;
    weeks.push({
      index: i + 1,
      start: makeDate(y, m, startDay),
      end: makeDate(y, m, endDay),
      days: endDay - startDay + 1,
    });
  });
  return weeks;
}

/** Week number (1–5) for a day of the month. */
export function weekIndexOfDay(day: number): number {
  return Math.min(5, Math.floor((day - 1) / 7) + 1);
}

export function weekIndexOf(date: ISODate): number {
  return weekIndexOfDay(parseDate(date).d);
}
