// Category changes that touch other rows: kind rules, and merging one category into another.
import type { CategoryKind } from '../../shared/actuals';
import { kindForGroup, SPECIAL } from '../../shared/categorySet';
import { PRIVACY_SQL } from '../../shared/privacy';
import { first, stmt, type Param } from '../lib/db';

/** stmt() with ?1, ?2… written in the SQL: expanded to plain ? (node:sqlite in tests binds those only by position). */
function numbered(db: D1Database, sql: string, ...values: Param[]): D1PreparedStatement {
  if (/\?(?!\d)/.test(sql)) throw new Error('numbered(): use ?1, ?2… only');
  const params: Param[] = [];
  const text = sql.replace(/\?(\d+)/g, (_, n: string) => {
    params.push(values[Number(n) - 1]);
    return '?';
  });
  return stmt(db, text, ...params);
}

/**
 * Every column that names a category. A merge re-points each of them; tests/categoriesApi.test.ts
 * fails when the schema has one that isn't listed here (a new table must be added, and handled).
 * Category ids inside JSON aren't columns and can't be found that way: category_moves.rule_before
 * (`$.category_id`, the rule a learned move replaced, restored by Undo) is re-pointed separately in
 * mergeStatements. Any new JSON field holding a category id needs the same.
 */
export const CATEGORY_REFERENCES: readonly { table: string; column: string }[] = [
  { table: 'budget_lines', column: 'category_id' },
  { table: 'categories', column: 'parent_id' },
  // Undo of a bulk change (migration 0008) puts old_category_id back only where the charge still
  // has new_category_id, so both follow a merge: Undo after a merge restores the surviving category.
  { table: 'category_move_items', column: 'new_category_id' },
  { table: 'category_move_items', column: 'old_category_id' },
  { table: 'category_moves', column: 'fix_category_id' },
  { table: 'goals', column: 'category_id' },
  { table: 'kid_budgets', column: 'category_id' },
  { table: 'planned_cost_categories', column: 'category_id' },
  { table: 'recurring_bills', column: 'category_id' },
  { table: 'rules', column: 'category_id' },
  { table: 'splits', column: 'category_id' },
  { table: 'transactions', column: 'category_id' },
];

export interface CategoryInfo {
  id: number;
  name: string;
  sectionId: number;
  sectionName: string;
  parentId: number | null;
  kind: CategoryKind;
  archived: number;
  funMemberId: number | null;
  children: number;
}

export function loadCategoryInfo(db: D1Database, id: number): Promise<CategoryInfo | null> {
  return first<CategoryInfo>(
    db,
    `SELECT c.id, c.name, c.section_id AS sectionId, s.name AS sectionName, c.parent_id AS parentId, c.kind,
            c.archived, c.fun_member_id AS funMemberId,
            (SELECT COUNT(*) FROM categories k WHERE k.parent_id = c.id) AS children
       FROM categories c JOIN sections s ON s.id = c.section_id WHERE c.id = ?`,
    id,
  );
}

/** The app finds these by group and name (paychecks, card payments, habits…), so they keep both. */
export function isSpecial(c: Pick<CategoryInfo, 'sectionName' | 'name'>): boolean {
  return Object.values(SPECIAL).some(([section, name]) => section === c.sectionName && name === c.name);
}

/** The kind a category gets in this group. Debt stays debt within the spending groups (like Loans). */
export function kindInGroup(group: string, current: CategoryKind | null): CategoryKind {
  const kind = kindForGroup(group);
  return kind === 'expense' && current === 'debt' ? 'debt' : kind;
}

/** Income ↔ anything else changes which side of the month the money lands on. */
export const crossesIncome = (from: CategoryKind, to: CategoryKind) => (from === 'income') !== (to === 'income');

/**
 * Charges filed (directly or by split) to these categories or their sub-categories:
 * `total` counts everything, `visible` only what this viewer may see.
 */
export async function chargesIn(db: D1Database, categoryId: number, viewerId: number): Promise<{ total: number; visible: number }> {
  const filed = `t.deleted_at IS NULL AND (
      t.category_id IN (SELECT id FROM categories WHERE id = ? OR parent_id = ?)
      OR EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id = t.id
                  AND s.category_id IN (SELECT id FROM categories WHERE id = ? OR parent_id = ?)))`;
  const row = await first<{ total: number; visible: number }>(
    db,
    `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN ${PRIVACY_SQL} THEN 1 ELSE 0 END), 0) AS visible
       FROM transactions t WHERE ${filed}`,
    viewerId,
    categoryId,
    categoryId,
    categoryId,
    categoryId,
  );
  return { total: row?.total ?? 0, visible: row?.visible ?? 0 };
}

export interface MergeCounts {
  transactions: number;
  splits: number;
  budgetLines: number;
  kidBudgets: number;
  rules: number;
  bills: number;
  goals: number;
  plannedCosts: number;
  subCategories: number;
}

/** What a merge would move. Charges, rules and bills count only what this viewer may see. */
export async function mergeCounts(db: D1Database, fromId: number, viewerId: number): Promise<MergeCounts> {
  const row = await numbered(
    db,
    `SELECT
       (SELECT COUNT(*) FROM transactions t WHERE t.category_id = ?1 AND t.deleted_at IS NULL AND (t.private_member_id IS NULL OR t.private_member_id = ?2)) AS transactions,
       (SELECT COUNT(*) FROM splits s JOIN transactions t ON t.id = s.transaction_id
         WHERE s.category_id = ?1 AND t.deleted_at IS NULL AND (t.private_member_id IS NULL OR t.private_member_id = ?2)) AS splits,
       (SELECT COUNT(*) FROM budget_lines WHERE category_id = ?1) AS budgetLines,
       (SELECT COUNT(*) FROM kid_budgets WHERE category_id = ?1) AS kidBudgets,
       (SELECT COUNT(*) FROM rules WHERE category_id = ?1 AND (owner_member_id IS NULL OR owner_member_id = ?2)) AS rules,
       (SELECT COUNT(*) FROM recurring_bills WHERE category_id = ?1 AND (private_member_id IS NULL OR private_member_id = ?2)) AS bills,
       (SELECT COUNT(*) FROM goals WHERE category_id = ?1) AS goals,
       (SELECT COUNT(*) FROM planned_cost_categories WHERE category_id = ?1) AS plannedCosts,
       (SELECT COUNT(*) FROM categories WHERE parent_id = ?1) AS subCategories`,
    fromId,
    viewerId,
  ).first<MergeCounts>();
  if (!row) throw new Error('Could not count');
  return row;
}

/**
 * Statements that fold `from` into `into` (the server-side version of migration 0003's re-pointing):
 * budgets landing on the same month (and kid) are summed, with mixed timing or due days becoming
 * 'even'; planned-cost links move unless `into` already has one; sub-categories move under `into`
 * (taking its group and kind); every other reference is re-pointed; `from` is archived.
 * Run them in one db.batch so they apply together.
 */
export function mergeStatements(db: D1Database, from: number, into: CategoryInfo, viewerId: number, now: string): D1PreparedStatement[] {
  const special: Record<string, D1PreparedStatement[]> = {
    budget_lines: [
      numbered(
        db,
        `UPDATE budget_lines SET
           budget_cents = budget_cents + (SELECT f.budget_cents FROM budget_lines f WHERE f.category_id = ?1 AND f.month = budget_lines.month),
           timing = CASE WHEN EXISTS (SELECT 1 FROM budget_lines f WHERE f.category_id = ?1 AND f.month = budget_lines.month
                                        AND f.timing = budget_lines.timing AND IFNULL(f.due_day, 0) = IFNULL(budget_lines.due_day, 0))
                         THEN timing ELSE 'even' END,
           due_day = CASE WHEN EXISTS (SELECT 1 FROM budget_lines f WHERE f.category_id = ?1 AND f.month = budget_lines.month
                                         AND f.timing = budget_lines.timing AND IFNULL(f.due_day, 0) = IFNULL(budget_lines.due_day, 0))
                          THEN due_day END,
           notes = (SELECT CASE WHEN budget_lines.notes IS NULL THEN f.notes WHEN f.notes IS NULL THEN budget_lines.notes
                                ELSE budget_lines.notes || '; ' || f.notes END
                      FROM budget_lines f WHERE f.category_id = ?1 AND f.month = budget_lines.month),
           updated_by_member_id = ?3, updated_at = ?4
         WHERE category_id = ?2 AND month IN (SELECT month FROM budget_lines WHERE category_id = ?1)`,
        from,
        into.id,
        viewerId,
        now,
      ),
      numbered(db, 'DELETE FROM budget_lines WHERE category_id = ?1 AND month IN (SELECT month FROM budget_lines WHERE category_id = ?2)', from, into.id),
      numbered(
        db,
        'UPDATE budget_lines SET category_id = ?2, updated_by_member_id = ?3, updated_at = ?4 WHERE category_id = ?1',
        from,
        into.id,
        viewerId,
        now,
      ),
    ],
    kid_budgets: [
      numbered(
        db,
        `UPDATE kid_budgets SET budget_cents = budget_cents + (SELECT f.budget_cents FROM kid_budgets f
                 WHERE f.category_id = ?1 AND f.kid_id = kid_budgets.kid_id AND f.month = kid_budgets.month)
          WHERE category_id = ?2 AND EXISTS (SELECT 1 FROM kid_budgets f
                 WHERE f.category_id = ?1 AND f.kid_id = kid_budgets.kid_id AND f.month = kid_budgets.month)`,
        from,
        into.id,
      ),
      numbered(
        db,
        `DELETE FROM kid_budgets WHERE category_id = ?1 AND EXISTS (SELECT 1 FROM kid_budgets i
           WHERE i.category_id = ?2 AND i.kid_id = kid_budgets.kid_id AND i.month = kid_budgets.month)`,
        from,
        into.id,
      ),
      numbered(db, 'UPDATE kid_budgets SET category_id = ?2 WHERE category_id = ?1', from, into.id),
    ],
    // A category belongs to one planned cost: if `into` has one, it keeps it.
    planned_cost_categories: [
      numbered(
        db,
        'DELETE FROM planned_cost_categories WHERE category_id = ?1 AND EXISTS (SELECT 1 FROM planned_cost_categories WHERE category_id = ?2)',
        from,
        into.id,
      ),
      numbered(db, 'UPDATE planned_cost_categories SET category_id = ?2 WHERE category_id = ?1', from, into.id),
    ],
    categories: [
      numbered(db, 'UPDATE categories SET parent_id = ?2, section_id = ?3, kind = ?4 WHERE parent_id = ?1', from, into.id, into.sectionId, into.kind),
    ],
  };
  return [
    ...CATEGORY_REFERENCES.flatMap(
      (ref) => special[ref.table] ?? [numbered(db, `UPDATE ${ref.table} SET ${ref.column} = ?2 WHERE ${ref.column} = ?1`, from, into.id)],
    ),
    // Not a column: the rule a learned move replaced, kept as JSON for Undo.
    numbered(
      db,
      `UPDATE category_moves SET rule_before = json_set(rule_before, '$.category_id', ?2)
        WHERE rule_before IS NOT NULL AND json_extract(rule_before, '$.category_id') = ?1`,
      from,
      into.id,
    ),
    numbered(db, 'UPDATE categories SET archived = 1 WHERE id = ?1', from),
  ];
}
