import type { MonthKey } from '../../shared/dates';
import { nowIso, placeholders, stmt, type Param } from '../lib/db';
import { LIVE_BALANCE, LIVE_MINIMUM } from './debts';

/**
 * The saved plan's budget lines (Save as my plan, and a month created later): each goal's line is its monthly
 * amount, and a category linked to debts gets their minimums + extras (not paid in full, with a balance).
 * `months`: every month after `after` that already has a budget, or the one month just created. Only lines whose
 * amount changes are written; a new debt line is due on the debts' first due day. Balances and estimated
 * minimums are read live, as GET /api/ahead shows them. `goalIds` and `debtCategoryIds` narrow it to what changed.
 */
export function planLineStatements(
  db: D1Database,
  months: { after: MonthKey } | { month: MonthKey },
  memberId: number,
  only: { goalIds?: readonly number[]; debtCategoryIds?: readonly number[] } = {},
): D1PreparedStatement[] {
  const monthsSql = 'after' in months ? '(SELECT DISTINCT month FROM budget_lines WHERE month > ?)' : '(SELECT ? AS month)';
  const monthParam = 'after' in months ? months.after : months.month;
  const upsert = `ON CONFLICT (month, category_id) DO UPDATE SET budget_cents = excluded.budget_cents,
       updated_by_member_id = excluded.updated_by_member_id, updated_at = ?
     WHERE budget_lines.budget_cents <> excluded.budget_cents`;
  const within = (column: string, ids: readonly number[] | undefined): [string, Param[]] =>
    ids === undefined ? ['', []] : [`AND ${column} IN (${ids.length ? placeholders(ids.length) : 'NULL'})`, [...ids]];
  const now = nowIso();
  const statements: D1PreparedStatement[] = [];

  if (only.goalIds === undefined || only.goalIds.length) {
    const [goalsIn, goalParams] = within('g.id', only.goalIds);
    statements.push(
      stmt(
        db,
        `INSERT INTO budget_lines (month, category_id, budget_cents, updated_by_member_id)
         SELECT m.month, g.category_id, g.monthly_cents, ? FROM ${monthsSql} m, goals g
          WHERE g.archived = 0 AND g.category_id IS NOT NULL AND g.monthly_cents IS NOT NULL ${goalsIn}
         ${upsert}`,
        memberId,
        monthParam,
        ...goalParams,
        now,
      ),
    );
  }
  if (only.debtCategoryIds === undefined || only.debtCategoryIds.length) {
    const [debtsIn, debtParams] = within('d.category_id', only.debtCategoryIds);
    statements.push(
      stmt(
        db,
        `INSERT INTO budget_lines (month, category_id, budget_cents, timing, due_day, updated_by_member_id)
         SELECT m.month, d.category_id, SUM(${LIVE_MINIMUM} + d.extra_cents),
                CASE WHEN MIN(d.due_day) IS NULL THEN 'even' ELSE 'due_day' END, MIN(d.due_day), ?
           FROM ${monthsSql} m CROSS JOIN debts d LEFT JOIN accounts a ON a.id = d.account_id
          WHERE d.archived = 0 AND d.paid_in_full = 0 AND ${LIVE_BALANCE} > 0 AND d.category_id IS NOT NULL ${debtsIn}
          GROUP BY m.month, d.category_id
         ${upsert}`,
        memberId,
        monthParam,
        ...debtParams,
        now,
      ),
    );
  }
  return statements;
}
