import type { CategoryKind } from '../../shared/actuals';
import { flowCents } from '../../shared/actuals';
import type { MonthKey } from '../../shared/dates';
import { addSpend, plannedMonthTotal, type AmountRow, type SpendMap } from '../../shared/plannedCosts';
import { all } from '../lib/db';

export interface PlannedCostRow {
  id: number;
  name: string;
  startMonth: MonthKey;
  startBalanceCents: number;
  amounts: AmountRow[];
  categoryIds: number[];
}

/** Every active planned cost with its amount changes and categories (three queries, no per-cost lookups). */
export async function loadPlannedCosts(db: D1Database): Promise<PlannedCostRow[]> {
  const [costs, amounts, links] = await Promise.all([
    all<{ id: number; name: string; startMonth: MonthKey; startBalanceCents: number }>(
      db,
      `SELECT id, name, start_month AS startMonth, start_balance_cents AS startBalanceCents
         FROM planned_costs WHERE archived = 0 ORDER BY sort, id`,
    ),
    all<{ costId: number; month: MonthKey; monthlyCents: number }>(
      db,
      'SELECT planned_cost_id AS costId, month, monthly_cents AS monthlyCents FROM planned_cost_amounts ORDER BY month',
    ),
    all<{ costId: number; categoryId: number }>(
      db,
      'SELECT planned_cost_id AS costId, category_id AS categoryId FROM planned_cost_categories ORDER BY category_id',
    ),
  ]);
  const byId = new Map<number, PlannedCostRow>(costs.map((c) => [c.id, { ...c, amounts: [], categoryIds: [] }]));
  for (const a of amounts) byId.get(a.costId)?.amounts.push({ month: a.month, monthlyCents: a.monthlyCents });
  for (const l of links) byId.get(l.costId)?.categoryIds.push(l.categoryId);
  return [...byId.values()];
}

/** The month's set-aside across active planned costs, or null when none has started by then. */
export async function plannedCostsForMonth(db: D1Database, month: MonthKey): Promise<number | null> {
  const rows = await all<{ id: number; startMonth: MonthKey; month: MonthKey; monthlyCents: number }>(
    db,
    `SELECT p.id, p.start_month AS startMonth, a.month, a.monthly_cents AS monthlyCents
       FROM planned_costs p JOIN planned_cost_amounts a ON a.planned_cost_id = p.id
      WHERE p.archived = 0 AND p.start_month <= ?`,
    month,
  );
  if (!rows.length) return null;
  const costs = new Map<number, { startMonth: MonthKey; amounts: AmountRow[] }>();
  for (const r of rows) {
    const cost = costs.get(r.id) ?? { startMonth: r.startMonth, amounts: [] };
    cost.amounts.push({ month: r.month, monthlyCents: r.monthlyCents });
    costs.set(r.id, cost);
  }
  return plannedMonthTotal([...costs.values()], month);
}

/**
 * Spending in planned-cost categories by month, summed in SQL, for dates older than the loaded
 * ledger. Same counting rules as ledgerEntries + flowCents: no deleted or ignored transactions,
 * split transactions count by their parts, transfer categories never count.
 */
export async function addOlderSpend(db: D1Database, spend: SpendMap, from: string, to: string): Promise<void> {
  const rows = await all<{ categoryId: number; month: MonthKey; kind: CategoryKind; amountCents: number }>(
    db,
    `SELECT c.id AS categoryId, substr(t.date, 1, 7) AS month, c.kind,
            SUM(CASE WHEN s.id IS NULL THEN t.amount_cents ELSE s.amount_cents END) AS amountCents
       FROM transactions t
       LEFT JOIN splits s ON t.is_split = 1 AND s.transaction_id = t.id
       JOIN categories c ON c.id = CASE WHEN s.id IS NULL THEN t.category_id ELSE s.category_id END
      WHERE t.deleted_at IS NULL AND t.is_ignored = 0 AND t.date BETWEEN ? AND ? AND c.kind != 'transfer'
        AND c.id IN (SELECT category_id FROM planned_cost_categories)
      GROUP BY c.id, month`,
    from,
    to,
  );
  for (const r of rows) addSpend(spend, r.categoryId, r.month, flowCents({ kind: r.kind, amountCents: r.amountCents }));
}
