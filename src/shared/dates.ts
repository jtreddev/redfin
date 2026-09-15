/**
 * Date-only helpers. Dates are 'YYYY-MM-DD' strings and months are 'YYYY-MM'.
 * All arithmetic runs in UTC so daylight-saving changes never shift a day.
 * ISO strings compare correctly with < and >.
 */
export type ISODate = string;
export type MonthKey = string;

const DAY_MS = 86_400_000;

export function parseDate(date: ISODate): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`Invalid date: ${date}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

export function parseMonth(month: MonthKey): { y: number; m: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error(`Invalid month: ${month}`);
  return { y: Number(match[1]), m: Number(match[2]) };
}

export function isISODate(value: unknown): value is ISODate {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const { y, m, d } = parseDate(value);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/** Builds a date, normalizing overflow (e.g. month 13 or day 0). */
export function makeDate(y: number, m: number, d: number): ISODate {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

function toUTC(date: ISODate): number {
  const { y, m, d } = parseDate(date);
  return Date.UTC(y, m - 1, d);
}

export function addDays(date: ISODate, days: number): ISODate {
  return new Date(toUTC(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from b to a (positive when a is later). */
export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((toUTC(a) - toUTC(b)) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(date: ISODate): number {
  return new Date(toUTC(date)).getUTCDay();
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function monthOf(date: ISODate): MonthKey {
  return date.slice(0, 7);
}

export function monthStart(month: MonthKey): ISODate {
  return `${month}-01`;
}

export function monthEnd(month: MonthKey): ISODate {
  const { y, m } = parseMonth(month);
  return makeDate(y, m, daysInMonth(y, m));
}

export function monthLength(month: MonthKey): number {
  const { y, m } = parseMonth(month);
  return daysInMonth(y, m);
}

export function addMonths(month: MonthKey, n: number): MonthKey {
  const { y, m } = parseMonth(month);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}

/** The given day of a month, pulled back to the last day when the month is shorter. */
export function clampDay(month: MonthKey, day: number): ISODate {
  const { y, m } = parseMonth(month);
  return makeDate(y, m, Math.max(1, Math.min(day, daysInMonth(y, m))));
}

/** Same day-of-month n months later, clamped to month end (Jan 31 + 1 → Feb 28). */
export function addMonthsToDate(date: ISODate, n: number, dayOfMonth = parseDate(date).d): ISODate {
  return clampDay(addMonths(monthOf(date), n), dayOfMonth);
}

/** Whole calendar months from a to b; partial months don't count. */
export function monthsBetween(a: ISODate, b: ISODate): number {
  const pa = parseDate(a);
  const pb = parseDate(b);
  let months = (pb.y - pa.y) * 12 + (pb.m - pa.m);
  if (pb.d < pa.d) months -= 1;
  return months;
}

/** Moves Saturday/Sunday back to Friday (how most payroll and billing handles weekends). */
export function previousWeekday(date: ISODate): ISODate {
  const dow = dayOfWeek(date);
  if (dow === 6) return addDays(date, -1);
  if (dow === 0) return addDays(date, -2);
  return date;
}

/** Today's date in a household time zone, e.g. 'America/Chicago'. */
export function todayIn(timeZone: string, now: Date = new Date()): ISODate {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function minDate(a: ISODate, b: ISODate): ISODate {
  return a < b ? a : b;
}

export function maxDate(a: ISODate, b: ISODate): ISODate {
  return a > b ? a : b;
}
