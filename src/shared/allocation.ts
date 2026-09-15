import { monthLength, type MonthKey } from './dates';
import type { Cents } from './money';
import { monthWeeks, weekIndexOfDay, type MonthWeek } from './weeks';

/** "due_day" lands in the week of its due day; "even" spreads across weeks by day count. */
export type Timing = 'due_day' | 'even';

export interface PlannedLine {
  amountCents: Cents;
  timing: Timing;
  dueDay?: number | null;
}

/**
 * Splits a total across weights using integer largest-remainder rounding, so the
 * parts always add back to the exact total. Ties go to the earlier slot.
 */
export function distribute(total: Cents, weights: readonly number[]): Cents[] {
  if (weights.length === 0) return [];
  const out = weights.map(() => 0);
  const weightSum = weights.reduce((a, b) => a + Math.max(0, b), 0);
  if (total === 0) return out;
  if (weightSum <= 0) {
    out[0] = total;
    return out;
  }

  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const remainders: { i: number; rem: number }[] = [];
  let assigned = 0;
  weights.forEach((w, i) => {
    const product = abs * Math.max(0, w);
    const part = Math.floor(product / weightSum);
    out[i] = part;
    assigned += part;
    remainders.push({ i, rem: product % weightSum });
  });
  remainders.sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (let k = 0; k < abs - assigned; k++) {
    const slot = remainders[k % remainders.length];
    if (slot) out[slot.i] = (out[slot.i] ?? 0) + 1;
  }
  return sign < 0 ? out.map((v) => (v === 0 ? 0 : -v)) : out;
}

/** 0-based position in the month's week list for a line's due day, or null when it has none. */
export function dueWeekPosition(
  line: Pick<PlannedLine, 'timing' | 'dueDay'>,
  month: MonthKey,
): number | null {
  if (line.timing !== 'due_day' || line.dueDay == null) return null;
  const day = Math.max(1, Math.min(line.dueDay, monthLength(month)));
  return weekIndexOfDay(day) - 1;
}

/** Per-week planned amounts for one budget line. A due-day line without a day spreads evenly. */
export function allocateLine(
  line: PlannedLine,
  month: MonthKey,
  weeks: readonly MonthWeek[] = monthWeeks(month),
): Cents[] {
  const position = dueWeekPosition(line, month);
  if (position === null) return distribute(line.amountCents, weeks.map((w) => w.days));
  const out = weeks.map(() => 0);
  out[position] = line.amountCents;
  return out;
}
