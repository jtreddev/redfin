import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/worker/env';
import { isUniqueViolation, seedDefaults } from '../src/worker/routes/plannedCosts';
import { loadCategories } from '../src/worker/services/context';
import { api } from './helpers/api';
import { TestD1 } from './helpers/d1';
import { testEnv } from './helpers/plaid';

const YOU = 'you@example.com';
const PARTNER = 'partner@example.com';

interface ComingUp {
  kind: 'bill' | 'usual';
  name?: string;
  date?: string;
  month?: string;
  amountCents: number;
}
interface Cost {
  id: number;
  name: string;
  startMonth: string;
  startBalanceCents: number;
  categoryIds: number[];
  monthlyCents: number;
  balanceCents: number;
  spent12Cents: number;
  suggestedMonthlyCents: number | null;
  comingUp: ComingUp[];
}
interface PlannedCosts {
  month: string;
  costs: Cost[];
  totalMonthlyCents: number;
  suggestionMonths: number;
  categories: { id: number; name: string; section: string; plannedCostId: number | null }[];
}
interface Row {
  categoryId: number;
  lineId: number | null;
  budgetCents: number;
  plannedCostsCents: number;
  computed: string | null;
  timing: string;
  dueDay: number | null;
}

describe('planned costs API', () => {
  let db: TestD1;
  let env: Env;
  let partnerId: number;

  const category = (section: string, name: string) =>
    db.rows<{ id: number }>(
      'SELECT c.id FROM categories c JOIN sections s ON s.id = c.section_id WHERE s.name = ? AND c.name = ? AND c.fun_member_id IS NULL',
      section,
      name,
    )[0]!.id;

  function charge(date: string, cents: number, categoryId: number | null, extra: Record<string, string | number | null> = {}) {
    const cols = ['account_id', 'date', 'amount_cents', 'name', 'source', 'category_id', ...Object.keys(extra)];
    db.exec(
      `INSERT INTO transactions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      1,
      date,
      cents,
      `CHARGE ${date}`,
      'plaid',
      categoryId,
      ...Object.values(extra),
    );
    return db.rows<{ id: number }>('SELECT MAX(id) AS id FROM transactions')[0]!.id;
  }

  const list = async (email = YOU) => {
    const res = await api(env, 'GET', '/planned-costs', undefined, email);
    expect(res.status).toBe(200);
    return (await res.json()) as PlannedCosts;
  };
  const byName = (body: PlannedCosts, name: string) => body.costs.find((c) => c.name === name)!;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T16:00:00Z'));
    db = new TestD1();
    env = testEnv(db);
    await api(env, 'GET', '/me', undefined, YOU);
    await api(env, 'GET', '/me', undefined, PARTNER);
    partnerId = db.rows<{ id: number }>('SELECT id FROM members WHERE email = ?', PARTNER)[0]!.id;
    db.exec(`INSERT INTO accounts (name, type) VALUES ('Card', 'credit')`);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('defaults', () => {
    it('creates the defaults once, with fallback amounts when history is short', async () => {
      charge('2026-09-03', -12000, category('Everyday', 'Car Upkeep'));
      const body = await list();
      expect(body.month).toBe('2026-10');
      expect(body.costs.map((c) => [c.name, c.monthlyCents, c.startMonth, c.startBalanceCents])).toEqual([
        ['Car', 5000, '2026-10', 0],
        ['Health', 4000, '2026-10', 0],
        ['Holidays & gifts', 7500, '2026-10', 0],
      ]);
      expect(byName(body, 'Car').categoryIds).toEqual([category('Everyday', 'Car Upkeep')]);
      expect(byName(body, 'Health').categoryIds).toEqual([category('Everyday', 'Medical')]);
      expect(byName(body, 'Holidays & gifts').categoryIds).toEqual([category('Fun & Wants', 'Gifts')]);
      // The start month counts, so a new cost already holds one month.
      expect(byName(body, 'Car').balanceCents).toBe(5000);
      expect(byName(body, 'Car').suggestedMonthlyCents).toBeNull();
      expect(body.totalMonthlyCents).toBe(16500);
      expect(db.rows('SELECT planned_costs_seeded_at FROM household')[0]).toMatchObject({ planned_costs_seeded_at: expect.any(String) });

      // A second load (either partner) doesn't add more.
      expect((await list(PARTNER)).costs).toHaveLength(3);

      for (const c of body.costs) expect((await api(env, 'DELETE', `/planned-costs/${c.id}`)).status).toBe(200);
      const after = await list();
      expect(after.costs).toEqual([]);
      expect(after.totalMonthlyCents).toBe(0);
    });

    it('suggests amounts from the last 12 full months of history', async () => {
      const car = category('Everyday', 'Car Upkeep');
      charge('2025-06-01', -500000, car); // before the window
      charge('2025-12-05', -60000, car);
      charge('2026-04-05', -9000, car);
      charge('2026-05-05', 3000, car); // refund
      charge('2026-10-05', -77700, car); // this month: not in the suggestion
      const body = await list();
      // $660 over 12 months → $55.
      expect(byName(body, 'Car')).toMatchObject({ monthlyCents: 5500, suggestedMonthlyCents: 5500, spent12Cents: 66000 });
      expect(byName(body, 'Car').balanceCents).toBe(5500 - 77700);
      // Enough history but nothing spent: the starter amount, not $0.
      expect(byName(body, 'Health')).toMatchObject({ monthlyCents: 4000, suggestedMonthlyCents: 4000, spent12Cents: 0 });
      expect(byName(body, 'Holidays & gifts')).toMatchObject({ monthlyCents: 7500, suggestedMonthlyCents: 7500 });
      expect(body.suggestionMonths).toBe(12);

      // Renamed, it's still the default; a cost of your own with nothing spent suggests $0.
      await api(env, 'PATCH', `/planned-costs/${byName(body, 'Health').id}`, { name: 'Doctors' });
      const res = await api(env, 'POST', '/planned-costs', { name: 'Coffee', monthlyCents: 1000, categoryIds: [category('Habits', 'Coffee & Fast Food')] });
      expect(res.status).toBe(201);
      const again = await list();
      expect(byName(again, 'Doctors').suggestedMonthlyCents).toBe(4000);
      expect(byName(again, 'Coffee').suggestedMonthlyCents).toBe(0);
    });

    it('skips a default whose category is gone', async () => {
      db.exec('UPDATE categories SET archived = 1 WHERE id = ?', category('Everyday', 'Medical'));
      expect((await list()).costs.map((c) => c.name)).toEqual(['Car', 'Holidays & gifts']);
    });
  });

  it('lists eligible categories with the cost that uses them', async () => {
    const body = await list();
    const sections = new Set(body.categories.map((c) => c.section));
    expect([...sections].sort()).toEqual(['Bills', 'Everyday', 'Fun & Wants', 'Habits']);
    expect(body.categories.find((c) => c.name === 'Car Upkeep')!.plannedCostId).toBe(byName(body, 'Car').id);
    expect(body.categories.find((c) => c.name === 'Groceries')!.plannedCostId).toBeNull();
    expect(body.categories.some((c) => c.name.includes('Fun Money'))).toBe(false);
  });

  it('shows linked yearly bills and keeps a partner’s private bills out', async () => {
    const car = category('Everyday', 'Car Upkeep');
    const insertBill = (merchant: string, nextDate: string, cents: number, extra = 'NULL', cadence = 'yearly', status = 'confirmed') =>
      db.exec(
        `INSERT INTO recurring_bills (merchant, name, cadence, expected_amount_cents, next_date, category_id, status, private_member_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ${extra})`,
        merchant,
        merchant,
        cadence,
        cents,
        nextDate,
        car,
        status,
      );
    insertBill('DMV', '2027-03-03', -8500);
    insertBill('Secret', '2027-01-03', -9900, String(partnerId));
    insertBill('Wash', '2026-11-03', -2000, 'NULL', 'monthly');
    insertBill('Maybe', '2026-11-03', -2000, 'NULL', 'yearly', 'suggested');
    expect(byName(await list(), 'Car').comingUp).toEqual([{ kind: 'bill', name: 'DMV', date: '2027-03-03', amountCents: 8500 }]);
    expect(byName(await list(PARTNER), 'Car').comingUp.map((i) => i.name)).toEqual(['Secret', 'DMV']);
  });

  describe('editing', () => {
    it('creates a cost and changes its monthly amount from this month on', async () => {
      const shopping = category('Fun & Wants', 'Shopping');
      await list();
      const res = await api(env, 'POST', '/planned-costs', {
        name: 'Clothes',
        monthlyCents: 5000,
        categoryIds: [shopping, shopping],
        startMonth: '2026-08',
        startBalanceCents: 1000,
      });
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: number };
      charge('2026-09-10', -4000, shopping);
      let cost = (await list()).costs.find((c) => c.id === id)!;
      expect(cost).toMatchObject({ name: 'Clothes', categoryIds: [shopping], monthlyCents: 5000, startMonth: '2026-08' });
      expect(cost.balanceCents).toBe(1000 + 3 * 5000 - 4000);

      expect((await api(env, 'PATCH', `/planned-costs/${id}`, { monthlyCents: 8000, name: 'Clothing' })).status).toBe(200);
      cost = (await list()).costs.find((c) => c.id === id)!;
      expect(cost).toMatchObject({ name: 'Clothing', monthlyCents: 8000 });
      expect(cost.balanceCents).toBe(1000 + 5000 + 5000 + 8000 - 4000);

      expect((await api(env, 'PATCH', `/planned-costs/${id}`, { startBalanceCents: -2000, categoryIds: [] })).status).toBe(200);
      cost = (await list()).costs.find((c) => c.id === id)!;
      expect(cost.categoryIds).toEqual([]);
      expect(cost.balanceCents).toBe(-2000 + 5000 + 5000 + 8000);
      expect((await list()).totalMonthlyCents).toBe(16500 + 8000);
    });

    it('allows one cost per category', async () => {
      const body = await list();
      const car = byName(body, 'Car');
      const gifts = category('Fun & Wants', 'Gifts');
      const res = await api(env, 'POST', '/planned-costs', { name: 'Tires', monthlyCents: 1000, categoryIds: [category('Everyday', 'Car Upkeep')] });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('Car Upkeep is already part of Car.');
      expect(db.rows('SELECT id FROM planned_costs WHERE name = ?', 'Tires')).toEqual([]);

      const patch = await api(env, 'PATCH', `/planned-costs/${car.id}`, { categoryIds: [car.categoryIds[0], gifts] });
      expect(patch.status).toBe(409);
      expect(((await patch.json()) as { error: string }).error).toBe('Gifts is already part of Holidays & gifts.');
      // Keeping its own category is fine.
      expect((await api(env, 'PATCH', `/planned-costs/${car.id}`, { categoryIds: car.categoryIds })).status).toBe(200);

      // Deleting a cost frees its categories.
      await api(env, 'DELETE', `/planned-costs/${byName(body, 'Holidays & gifts').id}`);
      expect((await api(env, 'PATCH', `/planned-costs/${car.id}`, { categoryIds: [car.categoryIds[0], gifts] })).status).toBe(200);
    });

    it('rejects Fun Money and non-spending categories, and bad input', async () => {
      await list();
      const fun = db.rows<{ id: number }>('SELECT id FROM categories WHERE fun_member_id = ?', partnerId)[0]!.id;
      const post = (body: Record<string, unknown>) => api(env, 'POST', '/planned-costs', { name: 'X', monthlyCents: 1000, ...body });
      expect((await post({ categoryIds: [fun] })).status).toBe(400);
      expect((await post({ categoryIds: [category('Saving', 'Savings & Planned Costs')] })).status).toBe(400);
      expect((await post({ categoryIds: [category('Income', 'Paychecks')] })).status).toBe(400);
      expect((await post({ categoryIds: [999999] })).status).toBe(400);
      expect((await post({ categoryIds: 'nope' })).status).toBe(400);
      expect((await post({ name: '' })).status).toBe(400);
      expect((await post({ monthlyCents: -5 })).status).toBe(400);
      expect((await post({ startMonth: '2025-01' })).status).toBe(400);
      expect((await post({ startMonth: '2026-11' })).status).toBe(400);
      expect((await api(env, 'PATCH', '/planned-costs/999', { name: 'Y' })).status).toBe(404);
      expect((await api(env, 'PATCH', `/planned-costs/${(await list()).costs[0]!.id}`, {})).status).toBe(400);
      expect((await api(env, 'DELETE', '/planned-costs/999')).status).toBe(404);
    });
  });

  describe('saving a cost back unchanged', () => {
    it('accepts its stored start month even when it is more than a year old', async () => {
      const car = byName(await list(), 'Car');
      db.exec("UPDATE planned_costs SET start_month = '2025-06' WHERE id = ?", car.id);
      const res = await api(env, 'PATCH', `/planned-costs/${car.id}`, { name: 'Car', startMonth: '2025-06', categoryIds: car.categoryIds });
      expect(res.status).toBe(200);
      expect((await api(env, 'PATCH', `/planned-costs/${car.id}`, { startMonth: '2025-05' })).status).toBe(400);
    });

    it('keeps a linked category that has since been archived', async () => {
      const body = await list();
      const car = byName(body, 'Car');
      db.exec('UPDATE categories SET archived = 1 WHERE id = ?', car.categoryIds[0]!);
      expect((await api(env, 'PATCH', `/planned-costs/${car.id}`, { name: 'Car', categoryIds: car.categoryIds })).status).toBe(200);
      expect(byName(await list(), 'Car').categoryIds).toEqual(car.categoryIds);
      // Another cost still can't take it.
      const health = byName(body, 'Health');
      expect((await api(env, 'PATCH', `/planned-costs/${health.id}`, { categoryIds: car.categoryIds })).status).toBe(409);
    });
  });

  it('never reuses the id of a deleted cost, and links categories to the new one', async () => {
    await list();
    const shopping = category('Fun & Wants', 'Shopping');
    const first = (await (await api(env, 'POST', '/planned-costs', { name: 'A', monthlyCents: 100 })).json()) as { id: number };
    await api(env, 'DELETE', `/planned-costs/${first.id}`);
    const second = (await (await api(env, 'POST', '/planned-costs', { name: 'B', monthlyCents: 200, categoryIds: [shopping] })).json()) as { id: number };
    expect(second.id).not.toBe(first.id);
    expect(db.rows('SELECT planned_cost_id AS id, category_id AS cat FROM planned_cost_categories WHERE category_id = ?', shopping)).toEqual([
      { id: second.id, cat: shopping },
    ]);
    expect(db.rows('SELECT monthly_cents AS cents FROM planned_cost_amounts WHERE planned_cost_id = ?', second.id)).toEqual([{ cents: 200 }]);
  });

  it('does not seed defaults beside a cost added while seeding', async () => {
    // A POST lands after the GET read "no costs" but before its seeding batch runs.
    await api(env, 'POST', '/planned-costs', { name: 'Mine', monthlyCents: 100 });
    await seedDefaults(env.DB, await loadCategories(env.DB), new Map(), [], '2026-10', false);
    expect(db.rows<{ name: string }>('SELECT name FROM planned_costs').map((r) => r.name)).toEqual(['Mine']);
    expect(db.rows('SELECT COUNT(*) AS n FROM planned_cost_amounts')).toEqual([{ n: 1 }]);
    expect(db.rows('SELECT COUNT(*) AS n FROM planned_cost_categories')).toEqual([{ n: 0 }]);
    expect(db.rows('SELECT planned_costs_seeded_at AS at FROM household')[0]).toMatchObject({ at: expect.any(String) });
  });

  it('turns only unique-constraint failures into a conflict', () => {
    expect(isUniqueViolation(new Error('D1_ERROR: UNIQUE constraint failed: planned_cost_categories.category_id: SQLITE_CONSTRAINT'))).toBe(true);
    expect(isUniqueViolation(new Error('FOREIGN KEY constraint failed'))).toBe(false);
    expect(isUniqueViolation(new Error('NOT NULL constraint failed: planned_costs.name'))).toBe(false);
  });

  it('is in the JSON export', async () => {
    await list();
    const body = (await (await api(env, 'GET', '/export/json')).json()) as Record<string, unknown[]>;
    expect(body.plannedCosts).toHaveLength(3);
    expect(body.plannedCostAmounts).toHaveLength(3);
    expect(body.plannedCostCategories).toHaveLength(3);
  });

  it('counts spending since a start month older than a year (splits, refunds, ignored)', async () => {
    await list();
    const car = category('Everyday', 'Car Upkeep');
    const groceries = category('Everyday', 'Groceries');
    const carCost = db.rows<{ id: number }>("SELECT id FROM planned_costs WHERE name = 'Car'")[0]!.id;
    db.exec("UPDATE planned_costs SET start_month = '2025-06' WHERE id = ?", carCost);
    db.exec("UPDATE planned_cost_amounts SET month = '2025-06' WHERE planned_cost_id = ?", carCost);

    charge('2025-05-20', -99900, car); // before the start
    charge('2025-07-02', -30000, car);
    charge('2025-08-02', 5000, car); // refund
    charge('2025-08-03', -77700, car, { is_ignored: 1 });
    charge('2025-08-04', -66600, car, { deleted_at: '2025-08-05T00:00:00Z' });
    const split = charge('2025-09-01', -10000, null, { is_split: 1 });
    db.exec('INSERT INTO splits (transaction_id, category_id, amount_cents) VALUES (?, ?, ?), (?, ?, ?)', split, car, -6000, split, groceries, -4000);
    charge('2026-01-10', -20000, car); // inside the last 12 months

    const cost = byName(await list(), 'Car');
    // Jun 2025 .. Oct 2026 = 17 months at $50.
    expect(cost.balanceCents).toBe(17 * 5000 - 30000 + 5000 - 6000 - 20000);
  });

  describe('in the monthly plan', () => {
    const SAVINGS = () => category('Saving', 'Savings & Planned Costs');
    const savingsRow = async (month = '2026-10') => {
      const body = (await (await api(env, 'GET', `/budget?month=${month}`)).json()) as { rows: Row[] };
      return body.rows.find((r) => r.categoryId === SAVINGS())!;
    };
    const planner = async () =>
      (await (await api(env, 'GET', '/planner?month=2026-10')).json()) as {
        forecast: { totals: { endBalance: number } };
        safe: { cushionCents: number };
      };

    it('adds this month’s set-asides to the hand budget on Savings & Planned Costs', async () => {
      await api(env, 'PUT', '/budget/lines', { month: '2026-10', categoryId: SAVINGS(), budgetCents: 90000, timing: 'due_day', dueDay: 5 });
      const before = await planner();
      const handRow = await savingsRow();
      expect(handRow).toMatchObject({ budgetCents: 90000, plannedCostsCents: 0, computed: null });

      await list(); // creates the defaults: $165 a month
      const row = await savingsRow();
      expect(row).toMatchObject({
        budgetCents: 106500,
        plannedCostsCents: 16500,
        computed: 'planned_costs',
        lineId: handRow.lineId,
        timing: 'due_day',
        dueDay: 5,
      });
      const after = await planner();
      expect(after.forecast.totals.endBalance).toBe(before.forecast.totals.endBalance - 16500);
      expect(after.safe.cushionCents).toBeLessThan(before.safe.cushionCents);

      // Editing the hand part doesn't double count.
      await api(env, 'PUT', '/budget/lines', { month: '2026-10', categoryId: SAVINGS(), budgetCents: 95000, timing: 'due_day', dueDay: 5 });
      expect(await savingsRow()).toMatchObject({ budgetCents: 111500, plannedCostsCents: 16500 });

      // Months before any cost started don't get it; later months do.
      expect(await savingsRow('2026-09')).toMatchObject({ plannedCostsCents: 0, computed: null });
      expect(await savingsRow('2026-11')).toMatchObject({ plannedCostsCents: 16500, computed: 'planned_costs' });

      for (const c of (await list()).costs) await api(env, 'DELETE', `/planned-costs/${c.id}`);
      expect(await savingsRow()).toMatchObject({ budgetCents: 95000, plannedCostsCents: 0, computed: null });
    });

    it('works with no hand budget on the category', async () => {
      await list();
      expect(await savingsRow()).toMatchObject({ budgetCents: 16500, plannedCostsCents: 16500, computed: 'planned_costs', lineId: null, timing: 'even' });
    });

    it('keeps the savings bill in upcoming bills', async () => {
      vi.setSystemTime(new Date('2026-10-02T16:00:00Z'));
      await api(env, 'PUT', '/budget/lines', { month: '2026-10', categoryId: SAVINGS(), budgetCents: 90000, timing: 'due_day', dueDay: 5 });
      await list();
      const body = (await (await api(env, 'GET', '/planner?month=2026-10')).json()) as { bills: { name: string; amountCents: number }[] };
      expect(body.bills.find((b) => b.name === 'Savings & Planned Costs')?.amountCents).toBe(106500);
    });

    it('check-in carries only the hand budget forward', async () => {
      await api(env, 'PUT', '/budget/lines', { month: '2026-10', categoryId: SAVINGS(), budgetCents: 90000, timing: 'even' });
      await list();
      const decisions = { [SAVINGS()]: { kind: 'keep' } };
      expect((await api(env, 'PATCH', '/checkins/2026-10', { items: { decisions } })).status).toBe(200);
      await api(env, 'POST', '/checkins/2026-10/agree', {}, YOU);
      await api(env, 'POST', '/checkins/2026-10/agree', {}, PARTNER);
      expect((await api(env, 'POST', '/checkins/2026-10/complete', {})).status).toBe(200);
      expect(db.rows("SELECT budget_cents AS cents FROM budget_lines WHERE month = '2026-11' AND category_id = ?", SAVINGS())).toEqual([{ cents: 90000 }]);
      expect(await savingsRow('2026-11')).toMatchObject({ budgetCents: 106500 });
    });
  });
});
