import { ledgerEntries, type LedgerEntry } from '../../shared/actuals';
import { addMonths, minDate, monthOf, monthStart, type ISODate, type MonthKey } from '../../shared/dates';
import { goalProgress } from '../../shared/goals';
import { all } from '../lib/db';
import { loadLedger } from './ledger';

export interface GoalRow {
  id: number;
  name: string;
  targetCents: number;
  targetDate: ISODate | null;
  categoryId: number | null;
  categoryName: string | null;
  startingSavedCents: number;
  /** Plan › Ahead's monthly amount; null: not set. */
  monthlyCents: number | null;
  sort: number;
  archived: number;
  createdAt: string;
}

/** `loaded`: ledger entries a caller already has from `from` to today, used when they reach back far enough. */
export async function goalsWithProgress(
  db: D1Database,
  today: ISODate,
  includeArchived = false,
  loaded?: { from: ISODate; entries: readonly LedgerEntry[] },
) {
  const goals = await all<GoalRow>(
    db,
    `SELECT g.id, g.name, g.target_cents AS targetCents, g.target_date AS targetDate, g.category_id AS categoryId,
            c.name AS categoryName, g.starting_saved_cents AS startingSavedCents, g.monthly_cents AS monthlyCents, g.sort, g.archived, g.created_at AS createdAt
       FROM goals g LEFT JOIN categories c ON c.id = g.category_id
      ${includeArchived ? '' : 'WHERE g.archived = 0'}
      ORDER BY g.archived, g.sort, g.id`,
  );
  if (!goals.length) return [];

  const currentMonth = monthOf(today);
  const months: MonthKey[] = [-3, -2, -1, 0].map((n) => addMonths(currentMonth, n));
  const from = goals.reduce((earliest, g) => minDate(earliest, g.createdAt.slice(0, 10)), monthStart(months[0] ?? currentMonth));
  const entries =
    loaded && loaded.from <= from
      ? loaded.entries.filter((e) => e.date >= from && e.date <= today)
      : ledgerEntries(await loadLedger(db, from, today));

  return goals.map((g) => {
    const mine = g.categoryId === null ? [] : entries.filter((e) => e.categoryId === g.categoryId);
    const flow = (list: typeof mine) => list.reduce((sum, e) => sum + (e.kind === 'income' ? e.amountCents : -e.amountCents), 0);
    const savedCents = g.startingSavedCents + flow(mine.filter((e) => e.date >= g.createdAt.slice(0, 10)));
    // Months before the goal existed don't count against it.
    const createdMonth = g.createdAt.slice(0, 7);
    const contributionsByMonth = months
      .filter((m) => m >= createdMonth)
      .map((m) => flow(mine.filter((e) => monthOf(e.date) === m)));
    return {
      ...g,
      archived: g.archived === 1,
      savedCents,
      contributionsByMonth,
      progress: goalProgress({ targetCents: g.targetCents, savedCents, targetDate: g.targetDate, contributionsByMonth }, today),
    };
  });
}
