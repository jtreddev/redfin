// A sub-category's money counts toward its parent wherever totals are shown, and never twice.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ledgerEntries, type LedgerTxn } from '../src/shared/actuals';
import { buildTrends, whatChanged } from '../src/shared/trends';
import type { Env } from '../src/worker/env';
import { api } from './helpers/api';
import { TestD1 } from './helpers/d1';
import { testEnv } from './helpers/plaid';

interface Row {
  categoryId: number;
  parentId: number | null;
  budgetCents: number;
  actualCents: number;
  ownActualCents: number;
  computed: string | null;
  lineId: number | null;
}
interface Budget {
  rows: Row[];
  totals: { incomeBudgetCents: number; incomeActualCents: number; outBudgetCents: number; outActualCents: number };
}
interface Planner {
  forecast: { totals: { endBalance: number }; remainingByLine: Record<string, number[]> };
  safe: unknown;
  lines: { categoryId: number }[];
}

describe('sub-category roll-ups (API)', () => {
  let db: TestD1;
  let env: Env;
  let habits: number;
  let snacks: number;
  let cigs: number;

  const category = (section: string, name: string) =>
    db.rows<{ id: number }>(
      'SELECT c.id FROM categories c JOIN sections s ON s.id = c.section_id WHERE s.name = ? AND c.name = ?',
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
      'manual',
      categoryId,
      ...Object.values(extra),
    );
  }
  const line = (categoryId: number, cents: number, timing = 'even', dueDay: number | null = null) =>
    db.exec("INSERT INTO budget_lines (month, category_id, budget_cents, timing, due_day) VALUES ('2026-10', ?, ?, ?, ?)", categoryId, cents, timing, dueDay);
  const budget = async () => (await (await api(env, 'GET', '/budget?month=2026-10')).json()) as Budget;
  const planner = async () => (await (await api(env, 'GET', '/planner?month=2026-10')).json()) as Planner;
  const rowOf = (b: Budget, id: number) => b.rows.find((r) => r.categoryId === id)!;
  /** Puts Snacks and Cigarettes under Habits. */
  const nest = () => db.exec('UPDATE categories SET parent_id = ? WHERE id IN (?, ?)', habits, snacks, cigs);

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T16:00:00Z'));
    db = new TestD1();
    env = testEnv(db);
    await api(env, 'GET', '/me');
    db.exec(`INSERT INTO accounts (id, name, type, is_cash, current_balance_cents) VALUES (1, 'Checking', 'checking', 1, 500000)`);
    habits = category('Habits', 'Habits');
    // Made as plain categories first so totals can be compared before and after nesting.
    const habitsSection = db.rows<{ id: number }>("SELECT id FROM sections WHERE name = 'Habits'")[0]!.id;
    db.exec("INSERT INTO categories (section_id, name, kind, sort) VALUES (?, 'Snacks', 'expense', 100), (?, 'Cigarettes', 'expense', 110)", habitsSection, habitsSection);
    snacks = category('Habits', 'Snacks');
    cigs = category('Habits', 'Cigarettes');
    charge('2026-10-02', -1000, habits);
    charge('2026-10-03', -500, snacks);
    charge('2026-10-12', -300, cigs);
    charge('2026-10-04', -2000, category('Everyday', 'Groceries'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('no budget lines: the parent shows its own plus its children; totals unchanged', async () => {
    const before = await budget();
    const plannedBefore = await planner();
    nest();
    const after = await budget();
    expect(rowOf(after, habits)).toMatchObject({ actualCents: 1800, ownActualCents: 1000, parentId: null });
    expect(rowOf(after, snacks)).toMatchObject({ actualCents: 500, ownActualCents: 500, parentId: habits });
    expect(after.totals).toEqual(before.totals);
    expect((await planner()).forecast.totals.endBalance).toBe(plannedBefore.forecast.totals.endBalance);
  });

  it('a budget line on the parent: children’s charges count against it, once', async () => {
    line(habits, 3000);
    const before = await budget();
    const plannedBefore = await planner();
    nest();
    const after = await budget();
    expect(rowOf(after, habits)).toMatchObject({ budgetCents: 3000, actualCents: 1800 });
    expect(after.totals).toEqual(before.totals);
    const p = await planner();
    expect(p.forecast.remainingByLine[String(habits)]!.reduce((a, b) => a + b, 0)).toBe(1200);
    expect(p.lines.map((l) => l.categoryId)).not.toContain(snacks);
    // Before nesting the children were unplanned spending; now they're inside the parent's line,
    // so the forecast holds back only what's left of $30 (not $30 on top of what they spent).
    expect(p.forecast.totals.endBalance).toBe(plannedBefore.forecast.totals.endBalance + 800);
  });

  it('budget lines on children only: the parent shows their sum', async () => {
    line(snacks, 800);
    line(cigs, 1200, 'due_day', 25);
    const before = await budget();
    const plannedBefore = await planner();
    nest();
    const after = await budget();
    expect(rowOf(after, habits)).toMatchObject({ budgetCents: 2000, actualCents: 1800, computed: 'children', lineId: null });
    expect(rowOf(after, snacks)).toMatchObject({ budgetCents: 800, actualCents: 500 });
    expect(after.totals).toEqual(before.totals);
    const p = await planner();
    expect(p.forecast.totals.endBalance).toBe(plannedBefore.forecast.totals.endBalance);
    expect(p.lines.map((l) => l.categoryId).sort()).toEqual([snacks, cigs].sort());
  });

  it('lines on both: the parent’s line is the budget; children’s lines don’t add to totals', async () => {
    line(habits, 3000);
    line(snacks, 800);
    nest();
    const after = await budget();
    expect(rowOf(after, habits)).toMatchObject({ budgetCents: 3000, actualCents: 1800 });
    expect(after.totals.outBudgetCents).toBe(3000);
    const p = await planner();
    expect(p.lines.map((l) => l.categoryId)).toEqual([habits]);
  });

  it('check-in lines count a parent with its children, and the children not again', async () => {
    line(habits, 3000);
    nest();
    const body = (await (await api(env, 'GET', '/checkins/2026-10')).json()) as {
      lines: { categoryId: number; actualCents: number }[];
      summary: unknown;
    };
    expect(body.lines.find((l) => l.categoryId === habits)?.actualCents).toBe(1800);
    expect(body.lines.find((l) => l.categoryId === snacks)).toBeUndefined();
  });

  it('Trends: the parent row includes its children, children listed after it, group totals unchanged', async () => {
    const before = (await (await api(env, 'GET', '/trends?months=3')).json()) as { groups: { key: string; byMonth: number[] }[] };
    nest();
    const after = (await (await api(env, 'GET', '/trends?months=3')).json()) as {
      groups: { key: string; byMonth: number[] }[];
      categories: { id: number; parentId: number | null; byMonth: number[] }[];
    };
    expect(after.groups).toEqual(before.groups);
    const habitRows = after.categories.filter((c) => c.id === habits || c.parentId === habits);
    expect(habitRows.map((c) => [c.id, c.byMonth.at(-1)])).toEqual([
      [habits, 1800],
      [snacks, 500],
      [cigs, 300],
    ]);
  });
});

describe('sub-category roll-ups in Trends (pure)', () => {
  const cats = [
    { id: 1, name: 'Habits', section: 'Habits', funMemberId: null, parentId: null },
    { id: 2, name: 'Snacks', section: 'Habits', funMemberId: null, parentId: 1 },
    { id: 3, name: 'Groceries', section: 'Everyday', funMemberId: null, parentId: null },
  ];
  let n = 1;
  const txn = (date: string, amountCents: number, categoryId: number): LedgerTxn => ({
    id: n++,
    date,
    amountCents,
    categoryId,
    categoryKind: 'expense',
    kidId: null,
    privateMemberId: null,
    transferPairId: null,
    isIgnored: false,
  });

  it('what changed compares top-level categories only (a parent already includes its children)', () => {
    const txns = [
      ...['2026-06', '2026-07', '2026-08'].map((m) => txn(`${m}-10`, -1000, 2)),
      txn('2026-09-10', -20000, 2),
    ];
    const trends = buildTrends({ entries: ledgerEntries(txns), categories: cats, months: ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10'], today: '2026-10-03' });
    expect(trends.categories.map((c) => [c.id, c.parentId])).toEqual([
      [1, null],
      [2, 1],
    ]);
    const changed = whatChanged(trends, '2026-10-03');
    expect(changed.up.map((c) => c.categoryId)).toEqual([1]);
  });
});

describe('sub-category roll-ups in planned costs', () => {
  let db: TestD1;
  let env: Env;
  const category = (section: string, name: string) =>
    db.rows<{ id: number }>(
      'SELECT c.id FROM categories c JOIN sections s ON s.id = c.section_id WHERE s.name = ? AND c.name = ?',
      section,
      name,
    )[0]!.id;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T16:00:00Z'));
    db = new TestD1();
    env = testEnv(db);
    await api(env, 'GET', '/me');
    db.exec("UPDATE household SET planned_costs_seeded_at = '2026-01-01'");
    db.exec(`INSERT INTO accounts (id, name, type) VALUES (1, 'Card', 'credit')`);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const create = async (name: string, categoryIds: number[]) => {
    const res = await api(env, 'POST', '/planned-costs', { name, monthlyCents: 5000, startMonth: '2026-09', categoryIds });
    return { status: res.status, body: (await res.json()) as { id: number } };
  };

  it('linking a parent covers its children: their spending comes out of the balance', async () => {
    const car = category('Everyday', 'Car Upkeep');
    const tires = ((await (await api(env, 'POST', '/categories', { parentId: car, name: 'Tires' })).json()) as { id: number }).id;
    db.exec("INSERT INTO transactions (account_id, date, amount_cents, name, source, category_id) VALUES (1, '2026-09-20', -12000, 'TIRES', 'manual', ?)", tires);
    db.exec("INSERT INTO transactions (account_id, date, amount_cents, name, source, category_id) VALUES (1, '2026-09-21', -3000, 'OIL', 'manual', ?)", car);
    // An older charge (before the loaded year) is summed in SQL; it must include children too.
    db.exec("INSERT INTO transactions (account_id, date, amount_cents, name, source, category_id) VALUES (1, '2025-08-02', -700, 'OLD', 'manual', ?)", tires);
    const created = await create('Car', [car]);
    expect(created.status).toBe(201);
    db.exec("UPDATE planned_costs SET start_month = '2025-08' WHERE id = ?", created.body.id);
    const body = (await (await api(env, 'GET', '/planned-costs')).json()) as {
      costs: { id: number; categoryIds: number[]; balanceCents: number; spent12Cents: number }[];
      categories: { id: number; parentId: number | null; plannedCostId: number | null; spent12Cents: number }[];
    };
    const cost = body.costs.find((c) => c.id === created.body.id)!;
    expect(cost.categoryIds).toEqual([car]);
    expect(cost.spent12Cents).toBe(15000);
    // 15 months of $50 − (120 + 30 + 7).
    expect(cost.balanceCents).toBe(15 * 5000 - 15700);
    expect(body.categories.find((c) => c.id === tires)).toMatchObject({ parentId: car, plannedCostId: created.body.id, spent12Cents: 12000 });
    expect(body.categories.find((c) => c.id === car)).toMatchObject({ spent12Cents: 15000 });
  });

  it('refuses splitting a parent and its child across two costs', async () => {
    const car = category('Everyday', 'Car Upkeep');
    const tires = ((await (await api(env, 'POST', '/categories', { parentId: car, name: 'Tires' })).json()) as { id: number }).id;
    const medical = category('Everyday', 'Medical');
    const pills = ((await (await api(env, 'POST', '/categories', { parentId: medical, name: 'Pills' })).json()) as { id: number }).id;
    expect((await create('Car', [car])).status).toBe(201);
    expect((await create('Tires', [tires])).status).toBe(409);
    expect((await create('Pills', [pills])).status).toBe(201);
    expect((await create('Health', [medical])).status).toBe(409);
    // Parent and child in the same cost is fine (counted once).
    const gifts = category('Fun & Wants', 'Gifts');
    const cards = ((await (await api(env, 'POST', '/categories', { parentId: gifts, name: 'Cards' })).json()) as { id: number }).id;
    expect((await create('Gifts', [gifts, cards])).status).toBe(201);
  });
});
