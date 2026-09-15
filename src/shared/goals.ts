import { parseDate, type ISODate } from './dates';
import type { Cents } from './money';

export interface GoalInput {
  targetCents: Cents;
  savedCents: Cents;
  targetDate?: ISODate | null;
  /** Contributions per month, oldest first, ending with the current month. */
  contributionsByMonth?: readonly Cents[];
}

export type GoalStatus = 'done' | 'on_track' | 'behind' | 'no_date';

export interface GoalProgress {
  remainingCents: Cents;
  percent: number;
  /** Months left counting the current month, or null without a target date. */
  monthsLeft: number | null;
  monthlyNeededCents: Cents | null;
  /** Average of the last 3 completed months (excludes the current month). */
  recentAverageCents: Cents;
  status: GoalStatus;
}

/** Calendar months from today's month through the target month, inclusive; at least 1. */
export function monthsLeftInclusive(today: ISODate, targetDate: ISODate): number {
  const a = parseDate(today);
  const b = parseDate(targetDate);
  return Math.max(1, (b.y - a.y) * 12 + (b.m - a.m) + 1);
}

export function goalProgress(goal: GoalInput, today: ISODate): GoalProgress {
  const remainingCents = Math.max(0, goal.targetCents - goal.savedCents);
  const percent = goal.targetCents > 0 ? Math.min(100, Math.round((goal.savedCents / goal.targetCents) * 100)) : 0;

  const history = goal.contributionsByMonth ?? [];
  const completed = history.slice(0, -1).slice(-3);
  const recentAverageCents = completed.length
    ? Math.round(completed.reduce((a, b) => a + b, 0) / completed.length)
    : 0;

  if (remainingCents === 0) {
    return { remainingCents, percent: 100, monthsLeft: null, monthlyNeededCents: 0, recentAverageCents, status: 'done' };
  }
  if (!goal.targetDate) {
    return { remainingCents, percent, monthsLeft: null, monthlyNeededCents: null, recentAverageCents, status: 'no_date' };
  }

  const monthsLeft = monthsLeftInclusive(today, goal.targetDate);
  const monthlyNeededCents = Math.ceil(remainingCents / monthsLeft);
  const status: GoalStatus =
    completed.length === 0 || recentAverageCents >= monthlyNeededCents * 0.95 ? 'on_track' : 'behind';
  return { remainingCents, percent, monthsLeft, monthlyNeededCents, recentAverageCents, status };
}
