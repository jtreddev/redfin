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
  starterFor,
  suggestionMonths,
  suggestMonthly,
  withStarter,
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

/** Each default with the ids of its (live, shared) categories here. */
function defaultsHere(categories: readonly CategoryRow[]) {
  return DEFAULT_PLANNED_COSTS.map((d) => ({
    ...d,
    categoryIds: d.categories.flatMap(
      ([section, name]) => categories.find((c) => c.sectionName === section && c.name === name && isEligible(c))?.id ?? [],
    ),
  }));
}

/**
 * The amount and category rows for the cost inserted by the statement just before (in the same
 * batch). They find it with last_insert_rowid(), and do nothing when that insert added no row.
 */
function costChildStatements(db: D1Database, month: MonthKey, monthlyCents: number, categoryIds: readonly number[]): D1PreparedStatement[] {
  return [
    stmt(
      db,
      `INSERT INTO planned_cost_amounts (planned_cost_id, month, monthly_cents) SELECT last_insert_rowid(), ?, ? WHERE changes() = 1`,
      month,
      monthlyCents,
    ),
    // Right after the amount row, last_insert_rowid() is that row's rowid.
    ...(categoryIds.length
      ? [
          stmt(
            db,
            `INSERT INTO planned_cost_categories (planned_cost_id, category_id)
             SELECT a.planned_cost_id, v.value FROM planned_cost_amounts a, json_each(?) v
              WHERE a.rowid = last_insert_rowid() AND changes() = 1`,
            JSON.stringify(categoryIds),
          ),
        ]
      : []),
  ];
}

/**
 * Creates the default costs (Car, Health, Holidays & gifts) in one atomic batch. The batch first
 * claims the seeded flag, which only works while it is unset and no cost exists (a POST may have
 * landed since the GET looked). Each insert needs that claim, and the k-th default needs exactly k
 * costs before it, so a second load that somehow got the same claim adds nothing.
 * When the claim fails because costs exist, the flag is still set at the end: never seed later.
 */
export async function seedDefaults(
  db: D1Database,
  categories: readonly CategoryRow[],
  spend: SpendMap,
  months: readonly MonthKey[],
  month: MonthKey,
  anyCosts: boolean,
): Promise<void> {
  const claim = nowIso();
  const statements: D1PreparedStatement[] = [];
  if (!anyCosts) {
    statements.push(
      stmt(
        db,
        `UPDATE household SET planned_costs_seeded_at = ?
          WHERE id = 1 AND planned_costs_seeded_at IS NULL AND NOT EXISTS (SELECT 1 FROM planned_costs)`,
        claim,
      ),
    );
    let seeded = 0;
    defaultsHere(categories).forEach((d, i) => {
      const ids = d.categoryIds;
      if (!ids.length) return;
      const suggested = withStarter(
        months.length ? suggestMonthly(spendIn(spend, ids, months[0]!, months[months.length - 1]!), months.length) : null,
        d.fallbackMonthlyCents,
      );
      statements.push(
        stmt(
          db,
          `INSERT INTO planned_costs (name, start_month, sort) SELECT ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM household WHERE id = 1 AND planned_costs_seeded_at = ?)
              AND (SELECT COUNT(*) FROM planned_costs) = ?`,
          d.name,
          month,
          (i + 1) * 10,
          claim,
          seeded,
        ),
        ...costChildStatements(db, month, suggested ?? d.fallbackMonthlyCents, ids),
      );
      seeded += 1;
    });
  }
  statements.push(stmt(db, 'UPDATE household SET planned_costs_seeded_at = ? WHERE id = 1 AND planned_costs_seeded_at IS NULL', claim));
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

  const defaults = defaultsHere(categories);
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
      suggestedMonthlyCents: withStarter(suggestMonthly(spent12Cents, months.length), starterFor(cost.categoryIds, defaults)),
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
    const link = links.find((l) => l.categoryId === id);
    // Already in this cost: keep it, even if it has since been archived.
    if (link && link.costId === costId) continue;
    if (link) throw new HttpError(409, `${category.name} is already part of ${link.costName}.`);
    if (category.funMemberId != null) throw badRequest('Fun Money can’t be part of a planned cost.');
    if (!isEligible(category)) throw badRequest(`${category.name} can’t be part of a planned cost.`);
  }
  return ids;
}

/** A start month from a year ago through this month (or the one already stored, however old). */
function validStartMonth(value: unknown, month: MonthKey, stored: MonthKey | null = null): MonthKey {
  const start = reqMonth(value, 'startMonth');
  if (start === stored) return start;
  if (start > month || start < addMonths(month, -12)) throw badRequest('Pick a start month in the last year.');
  return start;
}

export const isUniqueViolation = (error: unknown) => error instanceof Error && /UNIQUE constraint failed/i.test(error.message);

/** Another cost took one of the categories between the check and the write. */
async function linkingCategories<T>(write: Promise<T>): Promise<T> {
  try {
    return await write;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, 'One of those categories is already part of another planned cost.');
    }
    throw error;
  }
}


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
      ...costChildStatements(db, startMonth, monthlyCents, categoryIds),
    ]),
  );
  return c.json({ id: results[0]!.meta.last_row_id }, 201);
});

plannedCosts.patch('/planned-costs/:id', async (c) => {
  const db = c.env.DB;
  const id = paramId(c);
  const month = monthOf(c.get('today'));
  const body = await readBody(c);
  const exists = await first<{ startMonth: MonthKey }>(db, 'SELECT start_month AS startMonth FROM planned_costs WHERE id = ?', id);
  if (!exists) throw notFound();

  const updates = new Updates()
    .set('name', body.name === undefined ? undefined : reqStr(body.name, 'name', 60))
    .set('start_month', body.startMonth === undefined ? undefined : validStartMonth(body.startMonth, month, exists.startMonth))
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
    statements.push(
      ...categoryIds.map((categoryId) =>
        stmt(db, 'INSERT INTO planned_cost_categories (planned_cost_id, category_id) VALUES (?, ?)', id, categoryId),
      ),
    );
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
