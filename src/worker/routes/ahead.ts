import { Hono } from 'hono';
import { addMonths, monthOf, type MonthKey } from '../../shared/dates';
import { currentMonthly, DEBT_STRATEGIES } from '../../shared/planAhead';
import type { AppEnv } from '../env';
import { all, first, nowIso, run, stmt, Updates } from '../lib/db';
import { badRequest, notFound, oneOf, optInt, paramId, readBody, reqInt, reqMonth, reqStr } from '../lib/http';
import { planLineStatements } from '../services/aheadPlan';
import { refreshStatement } from '../services/debts';
import { loadItems, loadMonthsAheadInput } from '../services/monthsAhead';
import { loadPlannedCosts } from '../services/plannedCosts';

/**
 * Plan › Ahead: the inputs and the saved plan (the client runs planAhead and autoFill on them), Save as my plan,
 * and known items. Debts, goals, items and the plan are household-wide.
 */
export const ahead = new Hono<AppEnv>();

const MAX_CENTS = 100_000_000;
const REPEATS = ['once', 'monthly', 'yearly'] as const;

ahead.get('/ahead', async (c) => {
  const today = c.get('today');
  const { input, saved, surprise, debts, goals, items, hasBalance, hasIncome } = await loadMonthsAheadInput(
    c.env.DB,
    today,
    c.get('viewer').memberId,
    c.get('household'),
    { link: true, suggest: true },
  );
  return c.json({ today, input, saved, surprise, debts, goals, items, hasBalance, hasIncome });
});

/** { id: cents } with whole, non-negative cents for known ids. */
function amounts(value: unknown, name: string, known: ReadonlySet<number>): Map<number, number> {
  if (value === undefined) return new Map();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw badRequest(`${name} must be an object`);
  const out = new Map<number, number>();
  for (const [key, cents] of Object.entries(value)) {
    const id = Number(key);
    if (!known.has(id)) throw badRequest(`${name}: no such id ${key}`);
    out.set(id, reqInt(cents, name, { min: 0, max: MAX_CENTS }));
  }
  return out;
}

/**
 * Save as my plan (P7-R5, R6): in one batch, only what changed — each debt's extra and order, next month's
 * set-aside, each goal's monthly amount, the budget lines of months after this one that already have a budget
 * (goal lines; debt-linked category lines at minimum + extra), and the cushion and payoff order.
 */
ahead.post('/ahead/plan', async (c) => {
  const db = c.env.DB;
  const body = await readBody(c);
  const today = c.get('today');
  const household = c.get('household');
  const current = monthOf(today);
  const next = addMonths(current, 1);

  const [debts, goals, costs] = await Promise.all([
    all<{ id: number; extraCents: number; sort: number; categoryId: number | null }>(
      db,
      'SELECT id, extra_cents AS extraCents, sort, category_id AS categoryId FROM debts WHERE archived = 0',
    ),
    all<{ id: number; monthlyCents: number | null }>(db, 'SELECT id, monthly_cents AS monthlyCents FROM goals WHERE archived = 0'),
    loadPlannedCosts(db),
  ]);
  const debtExtra = amounts(body.debtExtra, 'debtExtra', new Set(debts.map((d) => d.id)));
  const costMonthly = amounts(body.costMonthly, 'costMonthly', new Set(costs.map((p) => p.id)));
  const goalMonthly = amounts(body.goalMonthly, 'goalMonthly', new Set(goals.map((g) => g.id)));
  const surpriseCents = body.surpriseCents === undefined ? household.surpriseCents : body.surpriseCents === null ? null : reqInt(body.surpriseCents, 'surpriseCents', { min: 0, max: MAX_CENTS });
  const strategy = oneOf(body.strategy, 'strategy', DEBT_STRATEGIES) ?? household.debtStrategy;
  if (body.order !== undefined && (!Array.isArray(body.order) || body.order.some((id) => !debts.some((d) => d.id === id)))) {
    throw badRequest('order must list debt ids');
  }
  const order = (body.order as number[] | undefined) ?? [];

  const now = nowIso();
  const statements: D1PreparedStatement[] = [];
  const changedCategories = new Set<number>();
  for (const d of debts) {
    const extra = debtExtra.get(d.id);
    if (extra !== undefined && extra !== d.extraCents) {
      statements.push(stmt(db, 'UPDATE debts SET extra_cents = ?, updated_at = ? WHERE id = ?', extra, now, d.id));
      if (d.categoryId !== null) changedCategories.add(d.categoryId);
    }
    const sort = order.indexOf(d.id);
    if (sort >= 0 && sort !== d.sort) statements.push(stmt(db, 'UPDATE debts SET sort = ?, updated_at = ? WHERE id = ?', sort, now, d.id));
  }
  for (const cost of costs) {
    const monthly = costMonthly.get(cost.id);
    if (monthly === undefined || monthly === currentMonthly(cost, today)) continue;
    // From next month on (or its first month); this month is left as is.
    const from: MonthKey = cost.startMonth > next ? cost.startMonth : next;
    statements.push(
      stmt(
        db,
        `INSERT INTO planned_cost_amounts (planned_cost_id, month, monthly_cents) VALUES (?, ?, ?)
         ON CONFLICT (planned_cost_id, month) DO UPDATE SET monthly_cents = excluded.monthly_cents`,
        cost.id,
        from,
        monthly,
      ),
    );
  }
  const changedGoals: number[] = [];
  for (const g of goals) {
    const monthly = goalMonthly.get(g.id);
    if (monthly === undefined || monthly === g.monthlyCents) continue;
    statements.push(stmt(db, 'UPDATE goals SET monthly_cents = ?, updated_at = ? WHERE id = ?', monthly, now, g.id));
    changedGoals.push(g.id);
  }
  if (surpriseCents !== household.surpriseCents || strategy !== household.debtStrategy) {
    statements.push(stmt(db, 'UPDATE household SET surprise_cents = ?, debt_strategy = ?, updated_at = ? WHERE id = 1', surpriseCents, strategy, now));
  }
  // After the rows above, so the lines take the new amounts.
  if (changedGoals.length || changedCategories.size) {
    statements.push(
      ...planLineStatements(db, { after: current }, c.get('viewer').memberId, { goalIds: changedGoals, debtCategoryIds: [...changedCategories] }),
    );
  }
  // Stored balances and estimated minimums first: debt lines are worked out from them.
  if (statements.length) await db.batch([refreshStatement(db), ...statements]);
  return c.json({ ok: true, changes: statements.length });
});

// ───────────────────────── Known items ─────────────────────────

ahead.get('/ahead/items', async (c) => c.json(await loadItems(c.env.DB)));

function checkItem(item: { amountCents: number; month: MonthKey; repeat: string; endMonth: MonthKey | null }) {
  if (item.amountCents === 0) throw badRequest('Enter an amount.');
  if (item.endMonth !== null && item.endMonth < item.month) throw badRequest('The end month is before the first.');
}

const optMonth = (value: unknown, name: string): MonthKey | null | undefined => (value === undefined ? undefined : value === null ? null : reqMonth(value, name));

ahead.post('/ahead/items', async (c) => {
  const body = await readBody(c);
  const repeat = oneOf(body.repeat, 'repeat', REPEATS) ?? 'once';
  const item = {
    name: reqStr(body.name, 'name', 60),
    // Positive = money in, negative = money out.
    amountCents: reqInt(body.amountCents, 'amountCents', { min: -MAX_CENTS, max: MAX_CENTS }),
    month: reqMonth(body.month),
    repeat,
    endMonth: repeat === 'once' ? null : (optMonth(body.endMonth, 'endMonth') ?? null),
  };
  checkItem(item);
  const row = await first<{ id: number }>(
    c.env.DB,
    'INSERT INTO ahead_items (name, amount_cents, month, repeat, end_month, created_by) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    item.name,
    item.amountCents,
    item.month,
    item.repeat,
    item.endMonth,
    c.get('viewer').memberId,
  );
  return c.json(row, 201);
});

ahead.patch('/ahead/items/:id', async (c) => {
  const db = c.env.DB;
  const id = paramId(c);
  const body = await readBody(c);
  const was = (await loadItems(db)).find((i) => i.id === id);
  if (!was) throw notFound();
  const repeat = oneOf(body.repeat, 'repeat', REPEATS);
  const item = {
    name: body.name === undefined ? was.name : reqStr(body.name, 'name', 60),
    amountCents: optInt(body.amountCents, 'amountCents', { min: -MAX_CENTS, max: MAX_CENTS }) ?? was.amountCents,
    month: body.month === undefined ? was.month : reqMonth(body.month),
    repeat: repeat ?? was.repeat,
    endMonth: optMonth(body.endMonth, 'endMonth') === undefined ? was.endMonth : (optMonth(body.endMonth, 'endMonth') ?? null),
  };
  if (item.repeat === 'once') item.endMonth = null;
  checkItem(item);
  const updates = new Updates()
    .set('name', item.name)
    .set('amount_cents', item.amountCents)
    .set('month', item.month)
    .set('repeat', item.repeat)
    .set('end_month', item.endMonth);
  await run(db, `UPDATE ahead_items SET ${updates.sets.join(', ')}, updated_at = ? WHERE id = ?`, ...updates.params, nowIso(), id);
  return c.json({ ok: true });
});

ahead.delete('/ahead/items/:id', async (c) => {
  const result = await run(c.env.DB, 'DELETE FROM ahead_items WHERE id = ?', paramId(c));
  if (!result.meta.changes) throw notFound();
  return c.json({ ok: true });
});
