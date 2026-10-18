import { Hono } from 'hono';
import { ledgerEntries } from '../../shared/actuals';
import { GROUPS } from '../../shared/categorySet';
import { addMonths, monthEnd, monthOf, monthStart, type ISODate, type MonthKey } from '../../shared/dates';
import {
  comingUp,
  costBalance,
  DEFAULT_PLANNED_COSTS,
  monthlyFor,
  spendByCategoryMonth,
  spendIn,
  suggestionMonths,
  suggestMonthly,
  type SpendMap,
  type YearlyBill,
} from '../../shared/plannedCosts';
import type { AppEnv } from '../env';
import { all, batchAll, first, nowIso, stmt, Updates } from '../lib/db';
import { badRequest, HttpError, notFound, optInt, paramId, readBody, reqInt, reqMonth, reqStr } from '../lib/http';
import { loadCategories, type CategoryRow } from '../services/context';
import { loadLedger } from '../services/ledger';
import { addOlderSpend, loadPlannedCosts } from '../services/plannedCosts';

export const plannedCosts = new Hono<AppEnv>();

/** Spending groups a planned cost can pay for. */
const ELIGIBLE_GROUPS: readonly string[] = [GROUPS.bills, GROUPS.everyday, GROUPS.habits, GROUPS.fun];

const isEligible = (c: CategoryRow) => ELIGIBLE_GROUPS.includes(c.sectionName) && !c.archived && c.funMemberId == null;

const ONLY_ONCE = `EXISTS (SELECT 1 FROM household WHERE id = 1 AND planned_costs_seeded_at IS NULL)`;

/**
 * Creates the default costs (Car, Health, Holidays & gifts) in one atomic batch. Every insert is
 * guarded by the seeded flag, which is set last, so two loads at once can't both seed.
 */
async function seedDefaults(
  db: D1Database,
  categories: readonly CategoryRow[],
  spend: SpendMap,
  months: readonly MonthKey[],
  month: MonthKey,
  anyCosts: boolean,
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  if (!anyCosts) {
    DEFAULT_PLANNED_COSTS.forEach((d, i) => {
      const ids = d.categories.flatMap(
        ([section, name]) => categories.find((c) => c.sectionName === section && c.name === name && isEligible(c))?.id ?? [],
      );
      if (!ids.length) return;
      const suggested = months.length ? suggestMonthly(spendIn(spend, ids, months[0]!, months[months.length - 1]!), months.length) : null;
      const newest = '(SELECT MAX(id) FROM planned_costs)';
      statements.push(
        stmt(db, `INSERT INTO planned_costs (name, start_month, sort) SELECT ?, ?, ? WHERE ${ONLY_ONCE}`, d.name, month, (i + 1) * 10),
        stmt(
          db,
          `INSERT INTO planned_cost_amounts (planned_cost_id, month, monthly_cents) SELECT ${newest}, ?, ? WHERE ${ONLY_ONCE}`,
          month,
          suggested ?? d.fallbackMonthlyCents,
        ),
        ...ids.map((id) =>
          stmt(db, `INSERT OR IGNORE INTO planned_cost_categories (planned_cost_id, category_id) SELECT ${newest}, ? WHERE ${ONLY_ONCE}`, id),
        ),
      );
    });
  }
  statements.push(stmt(db, 'UPDATE household SET planned_costs_seeded_at = ? WHERE id = 1 AND planned_costs_seeded_at IS NULL', nowIso()));
  await db.batch(statements);
}

plannedCosts.get('/planned-costs', async (c) => {
  const db = c.env.DB;
  const today = c.get('today');
  const month = monthOf(today);
  const windowStart = addMonths(month, -12);
  const lastFullMonth = addMonths(month, -1);

  const [household, categories, ledger, history, bills, loaded] = await Promise.all([
    first<{ seededAt: string | null }>(db, 'SELECT planned_costs_seeded_at AS seededAt FROM household WHERE id = 1'),
    loadCategories(db),
    loadLedger(db, monthStart(windowStart), monthEnd(month)),
    first<{ first: ISODate | null }>(db, 'SELECT MIN(date) AS first FROM transactions WHERE deleted_at IS NULL'),
    all<YearlyBill>(
      db,
      `SELECT name, next_date AS nextDate, expected_amount_cents AS amountCents, category_id AS categoryId
         FROM recurring_bills
        WHERE cadence = 'yearly' AND status = 'confirmed' AND next_date IS NOT NULL AND category_id IS NOT NULL
          AND (private_member_id IS NULL OR private_member_id = ?)`,
      c.get('viewer').memberId,
    ),
    loadPlannedCosts(db),
  ]);

  const spend = spendByCategoryMonth(ledgerEntries(ledger));
  const historyStart = history?.first ? monthOf(history.first) : null;
  const months = suggestionMonths(month, historyStart);

  let costs = loaded;
  if (household && household.seededAt == null) {
    await seedDefaults(db, categories, spend, months, month, loaded.length > 0);
    if (!loaded.length) costs = await loadPlannedCosts(db);
  }

  // Costs that started before the loaded year need their older spending too (summed in SQL).
  const earliest = costs.reduce<MonthKey | null>((min, cost) => (min === null || cost.startMonth < min ? cost.startMonth : min), null);
  if (earliest !== null && earliest < windowStart) {
    await addOlderSpend(db, spend, monthStart(earliest), monthEnd(addMonths(windowStart, -1)));
  }

  const costByCategory = new Map<number, number>();
  for (const cost of costs) for (const id of cost.categoryIds) costByCategory.set(id, cost.id);

  const out = costs.map((cost) => {
    const spent12Cents = spendIn(spend, cost.categoryIds, windowStart, lastFullMonth);
    return {
      id: cost.id,
      name: cost.name,
      startMonth: cost.startMonth,
      startBalanceCents: cost.startBalanceCents,
      categoryIds: cost.categoryIds,
      monthlyCents: cost.startMonth <= month ? monthlyFor(cost.amounts, month) : 0,
      balanceCents: costBalance(cost, spend, month),
      spent12Cents,
      suggestedMonthlyCents: suggestMonthly(spent12Cents, months.length),
      comingUp: comingUp({ categoryIds: cost.categoryIds, bills, spend, today, historyStart }),
    };
  });

  return c.json({
    month,
    costs: out,
    totalMonthlyCents: out.reduce((total, cost) => total + cost.monthlyCents, 0),
    /** Full months behind each suggestion (under 3 means no suggestion yet). */
    suggestionMonths: months.length,
    categories: categories.filter(isEligible).map((cat) => ({
      id: cat.id,
      name: cat.name,
      section: cat.sectionName,
      plannedCostId: costByCategory.get(cat.id) ?? null,
      spent12Cents: spendIn(spend, [cat.id], windowStart, lastFullMonth),
    })),
  });
});

/** Checks the categories a cost should pay for: spending categories only, each in one cost. */
async function validCategoryIds(db: D1Database, value: unknown, costId: number | null): Promise<number[]> {
  if (!Array.isArray(value)) throw badRequest('categoryIds must be a list');
  const ids = [...new Set(value.map((v) => reqInt(v, 'categoryIds', { min: 1 })))];
  if (!ids.length) return ids;
  const [categories, links] = await Promise.all([
    loadCategories(db),
    all<{ categoryId: number; costId: number; costName: string }>(
      db,
      `SELECT l.category_id AS categoryId, p.id AS costId, p.name AS costName
         FROM planned_cost_categories l JOIN planned_costs p ON p.id = l.planned_cost_id`,
    ),
  ]);
  for (const id of ids) {
    const category = categories.find((cat) => cat.id === id);
    if (!category) throw badRequest('That category doesn’t exist.');
    if (category.funMemberId != null) throw badRequest('Fun Money can’t be part of a planned cost.');
    if (!isEligible(category)) throw badRequest(`${category.name} can’t be part of a planned cost.`);
    const link = links.find((l) => l.categoryId === id);
    if (link && link.costId !== costId) throw new HttpError(409, `${category.name} is already part of ${link.costName}.`);
  }
  return ids;
}

/** A start month from a year ago through this month. */
function validStartMonth(value: unknown, month: MonthKey): MonthKey {
  const start = reqMonth(value, 'startMonth');
  if (start > month || start < addMonths(month, -12)) throw badRequest('Pick a start month in the last year.');
  return start;
}

/** Another cost took one of the categories between the check and the write. */
async function linkingCategories<T>(write: Promise<T>): Promise<T> {
  try {
    return await write;
  } catch (error) {
    if (error instanceof Error && /UNIQUE|constraint/i.test(error.message)) {
      throw new HttpError(409, 'One of those categories is already part of another planned cost.');
    }
    throw error;
  }
}

const linkStatement = (db: D1Database, costId: number | null, categoryId: number) =>
  costId === null
    ? stmt(db, 'INSERT INTO planned_cost_categories (planned_cost_id, category_id) VALUES ((SELECT MAX(id) FROM planned_costs), ?)', categoryId)
    : stmt(db, 'INSERT INTO planned_cost_categories (planned_cost_id, category_id) VALUES (?, ?)', costId, categoryId);

plannedCosts.post('/planned-costs', async (c) => {
  const db = c.env.DB;
  const month = monthOf(c.get('today'));
  const body = await readBody(c);
  const name = reqStr(body.name, 'name', 60);
  const monthlyCents = reqInt(body.monthlyCents, 'monthlyCents', { min: 0 });
  const startMonth = body.startMonth === undefined ? month : validStartMonth(body.startMonth, month);
  const startBalanceCents = optInt(body.startBalanceCents, 'startBalanceCents') ?? 0;
  const categoryIds = body.categoryIds === undefined ? [] : await validCategoryIds(db, body.categoryIds, null);

  // One batch, so a category conflict leaves nothing behind.
  const results = await linkingCategories(
    db.batch([
      stmt(
        db,
        `INSERT INTO planned_costs (name, start_month, start_balance_cents, sort)
         VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 10 FROM planned_costs))`,
        name,
        startMonth,
        startBalanceCents,
      ),
      stmt(
        db,
        'INSERT INTO planned_cost_amounts (planned_cost_id, month, monthly_cents) VALUES ((SELECT MAX(id) FROM planned_costs), ?, ?)',
        startMonth,
        monthlyCents,
      ),
      ...categoryIds.map((id) => linkStatement(db, null, id)),
    ]),
  );
  return c.json({ id: results[0]!.meta.last_row_id }, 201);
});

plannedCosts.patch('/planned-costs/:id', async (c) => {
  const db = c.env.DB;
  const id = paramId(c);
  const month = monthOf(c.get('today'));
  const body = await readBody(c);
  const exists = await first<{ id: number }>(db, 'SELECT id FROM planned_costs WHERE id = ?', id);
  if (!exists) throw notFound();

  const updates = new Updates()
    .set('name', body.name === undefined ? undefined : reqStr(body.name, 'name', 60))
    .set('start_month', body.startMonth === undefined ? undefined : validStartMonth(body.startMonth, month))
    .set('start_balance_cents', optInt(body.startBalanceCents, 'startBalanceCents') ?? undefined);
  const monthlyCents = body.monthlyCents === undefined ? undefined : reqInt(body.monthlyCents, 'monthlyCents', { min: 0 });
  const categoryIds = body.categoryIds === undefined ? undefined : await validCategoryIds(db, body.categoryIds, id);
  if (updates.empty && monthlyCents === undefined && categoryIds === undefined) throw badRequest('Nothing to update');

  const now = nowIso();
  const statements: D1PreparedStatement[] = [
    stmt(db, `UPDATE planned_costs SET ${[...updates.sets, 'updated_at = ?'].join(', ')} WHERE id = ?`, ...updates.params, now, id),
  ];
  if (monthlyCents !== undefined) {
    // From this month on; earlier months keep the amount they had.
    statements.push(
      stmt(
        db,
        `INSERT INTO planned_cost_amounts (planned_cost_id, month, monthly_cents) VALUES (?, ?, ?)
         ON CONFLICT (planned_cost_id, month) DO UPDATE SET monthly_cents = excluded.monthly_cents`,
        id,
        month,
        monthlyCents,
      ),
    );
  }
  if (categoryIds !== undefined) {
    statements.push(stmt(db, 'DELETE FROM planned_cost_categories WHERE planned_cost_id = ?', id));
    statements.push(...categoryIds.map((categoryId) => linkStatement(db, id, categoryId)));
  }
  await linkingCategories(db.batch(statements));
  return c.json({ ok: true });
});

plannedCosts.delete('/planned-costs/:id', async (c) => {
  const db = c.env.DB;
  const id = paramId(c);
  const results = await batchAll(db, [
    stmt(db, 'DELETE FROM planned_cost_categories WHERE planned_cost_id = ?', id),
    stmt(db, 'DELETE FROM planned_cost_amounts WHERE planned_cost_id = ?', id),
    stmt(db, 'DELETE FROM planned_costs WHERE id = ?', id),
  ]);
  if (!results[2]?.meta.changes) throw notFound();
  return c.json({ ok: true });
});
