import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ledgerEntries, type CategoryKind, type LedgerSplit, type LedgerTxn } from '../src/shared/actuals';
import type { ISODate, MonthKey } from '../src/shared/dates';
import { buildTrends, GROUP_ORDER, usualOf, whatChanged, type GroupKey, type Trends } from '../src/shared/trends';
import type { Env } from '../src/worker/env';
import { loadCategories } from '../src/worker/services/context';
import { loadLedger } from '../src/worker/services/ledger';
import { api } from './helpers/api';
import { TestD1 } from './helpers/d1';
import { testEnv } from './helpers/plaid';

// ---------------------------------------------------------------------------
// Pure aggregation
// ---------------------------------------------------------------------------

const SAM = 1;
const ALEX = 2;

/** A small made-up category set: [id, section, name, kind, funMemberId]. */
const CATS: [number, string, string, CategoryKind, number | null][] = [
  [1, 'Bills', 'Housing', 'expense', null],
  [2, 'Bills', 'Loans', 'debt', null],
  [3, 'Everyday', 'Groceries', 'expense', null],
  [4, 'Everyday', 'Gas', 'expense', null],
  [5, 'Habits', 'Habits', 'expense', null],
  [6, 'Fun & Wants', 'Eating Out', 'expense', null],
  [7, 'Fun & Wants', "Sam's Fun Money", 'expense', SAM],
  [8, 'Fun & Wants', "Alex's Fun Money", 'expense', ALEX],
  [9, 'Saving', 'Savings & Planned Costs', 'savings', null],
  [10, 'Income', 'Paychecks', 'income', null],
  [11, 'Transfers', 'Transfers', 'transfer', null],
  [12, 'Food', 'Misc', 'expense', null], // an old section left behind by the category migration
  [13, 'Everyday', 'Medical', 'expense', null],
  [14, 'Habits', 'Coffee & Fast Food', 'expense', null],
  [15, 'Fun & Wants', 'Shopping', 'expense', null],
];
const categories = CATS.map(([id, section, name, , funMemberId]) => ({ id, section, name, funMemberId }));
const kindOf = (id: number | null): CategoryKind | null => (id === null ? null : (CATS.find((c) => c[0] === id)?.[3] ?? null));

let nextId = 1;
function txn(date: ISODate, amountCents: number, categoryId: number | null, extra: Partial<LedgerTxn> = {}): LedgerTxn {
  return {
    id: nextId++,
    date,
    amountCents,
    categoryId,
    categoryKind: kindOf(categoryId),
    kidId: null,
    privateMemberId: null,
    transferPairId: null,
    isIgnored: false,
    ...extra,
  };
}
const split = (categoryId: number | null, amountCents: number): LedgerSplit => ({
  categoryId,
  categoryKind: kindOf(categoryId),
  kidId: null,
  amountCents,
});

const MONTHS: MonthKey[] = ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
const TODAY = '2026-10-18';

function trendsOf(txns: LedgerTxn[], today: ISODate = TODAY, months: MonthKey[] = MONTHS): Trends {
  return buildTrends({ entries: ledgerEntries(txns), categories, months, today });
}
const group = (t: Trends, key: GroupKey) => t.groups.find((g) => g.key === key)!.byMonth;
const category = (t: Trends, id: number) => t.categories.find((c) => c.id === id);

describe('trends: monthly totals by group', () => {
  it('lists the five groups in a fixed order', () => {
    expect(GROUP_ORDER.map((g) => [g.key, g.section, g.name])).toEqual([
      ['bills', 'Bills', 'Bills'],
      ['everyday', 'Everyday', 'Everyday'],
      ['habits', 'Habits', 'Habits'],
      ['fun', 'Fun & Wants', 'Fun & Wants'],
      ['saving', 'Saving', 'Saving'],
    ]);
    const t = trendsOf([]);
    expect(t.groups.map((g) => g.key)).toEqual(['bills', 'everyday', 'habits', 'fun', 'saving']);
    expect(t.months).toEqual(MONTHS);
    expect(t.partialMonth).toBe('2026-10');
    expect(t.groups.every((g) => g.byMonth.length === 5 && g.byMonth.every((v) => v === 0))).toBe(true);
    expect(t.usual).toEqual({ bills: 0, everyday: 0, habits: 0, fun: 0, saving: 0 });
    expect(t.categories).toEqual([]);
  });

  it('adds money out per group per month (positive = money out)', () => {
    const t = trendsOf([
      txn('2026-07-01', -150000, 1),
      txn('2026-07-12', -8000, 3),
      txn('2026-07-20', -4500, 4),
      txn('2026-08-03', -9000, 3),
      txn('2026-08-04', -1200, 5),
      txn('2026-09-05', -3000, 6),
      txn('2026-09-06', -2500, 7),
      txn('2026-10-01', -40000, 9),
      txn('2026-10-02', 300000, 10),
      txn('2026-05-31', -99999, 3), // before the range
    ]);
    expect(group(t, 'bills')).toEqual([0, 150000, 0, 0, 0]);
    expect(group(t, 'everyday')).toEqual([0, 12500, 9000, 0, 0]);
    expect(group(t, 'habits')).toEqual([0, 0, 1200, 0, 0]);
    expect(group(t, 'fun')).toEqual([0, 0, 0, 5500, 0]);
    expect(group(t, 'saving')).toEqual([0, 0, 0, 0, 40000]);
    expect(t.incomeByMonth).toEqual([0, 0, 0, 0, 300000]);
  });

  it('Loans (debt kind) count as money out in Bills', () => {
    const t = trendsOf([txn('2026-08-15', -32000, 2)]);
    expect(group(t, 'bills')).toEqual([0, 0, 32000, 0, 0]);
    expect(category(t, 2)).toEqual({ id: 2, name: 'Loans', group: 'bills', parentId: null, byMonth: [0, 0, 32000, 0, 0] });
  });

  it('counts uncategorized money out separately, never in a group', () => {
    const t = trendsOf([txn('2026-09-10', -6100, null), txn('2026-09-11', 2500, null), txn('2026-10-01', -900, null)]);
    expect(t.uncategorizedByMonth).toEqual([0, 0, 0, 6100, 900]);
    expect(t.groups.every((g) => g.byMonth.every((v) => v === 0))).toBe(true);
    expect(t.incomeByMonth).toEqual([0, 0, 0, 0, 0]);
  });

  it('leaves out transfers, uncategorized transfer halves and ignored transactions', () => {
    const t = trendsOf([
      txn('2026-09-01', -50000, 11),
      txn('2026-09-01', -20000, null, { transferPairId: 77 }),
      txn('2026-09-02', -7000, 3, { isIgnored: true }),
    ]);
    expect(t.groups.every((g) => g.byMonth.every((v) => v === 0))).toBe(true);
    expect(t.uncategorizedByMonth).toEqual([0, 0, 0, 0, 0]);
    expect(t.categories).toEqual([]);
  });

  it('a transfer filed as savings still counts in Saving', () => {
    const t = trendsOf([txn('2026-09-01', -25000, 9, { transferPairId: 77 })]);
    expect(group(t, 'saving')).toEqual([0, 0, 0, 25000, 0]);
  });

  it('split parts land in their own groups', () => {
    const t = trendsOf([
      txn('2026-08-09', -10000, null, { splits: [split(3, -6000), split(5, -2500), split(11, -1500)] }),
    ]);
    expect(group(t, 'everyday')).toEqual([0, 0, 6000, 0, 0]);
    expect(group(t, 'habits')).toEqual([0, 0, 2500, 0, 0]);
    expect(t.categories.map((c) => c.id)).toEqual([3, 5]);
  });

  it('refund month: refunds reduce the total and it can go negative', () => {
    const t = trendsOf([txn('2026-08-02', -3000, 6), txn('2026-08-20', 9000, 6), txn('2026-09-02', -4000, 6)]);
    expect(group(t, 'fun')).toEqual([0, 0, -6000, 4000, 0]);
    expect(category(t, 6)?.byMonth).toEqual([0, 0, -6000, 4000, 0]);
  });

  it('category rows: only ones with activity, in group order, none for income, transfers or old sections', () => {
    const t = trendsOf([
      txn('2026-09-01', -500, 6),
      txn('2026-09-01', -500, 1),
      txn('2026-09-01', 900, 10),
      txn('2026-09-01', -500, 12),
      txn('2026-09-01', -500, 999), // a category the list doesn't know
    ]);
    expect(t.categories.map((c) => [c.id, c.group])).toEqual([
      [1, 'bills'],
      [6, 'fun'],
    ]);
    // A refund that nets a month to zero is still activity.
    const zero = trendsOf([txn('2026-09-01', -500, 3), txn('2026-09-02', 500, 3)]);
    expect(category(zero, 3)?.byMonth).toEqual([0, 0, 0, 0, 0]);
  });

  it('usual ignores the current month: average of the last 3 full months', () => {
    const t = trendsOf([
      txn('2026-06-10', -99900, 3), // four months back: not in usual
      txn('2026-07-10', -10000, 3),
      txn('2026-08-10', -20000, 3),
      txn('2026-09-10', -30001, 3),
      txn('2026-10-10', -500000, 3), // partial month: not in usual
      txn('2026-09-10', -1000, 5),
    ]);
    expect(t.usual.everyday).toBe(20000); // (10000 + 20000 + 30001) / 3, rounded
    expect(t.usual.habits).toBe(333);
    expect(t.usual.bills).toBe(0);
  });

  it('usual counts only full months since the household’s history began', () => {
    // One full month of history (September): usual is that month, not a third of it.
    const one = trendsOf([txn('2026-09-10', -30000, 3), txn('2026-10-02', -100, 3)]);
    expect(one.historyStart).toBe('2026-09');
    expect(one.usual.everyday).toBe(30000);
    // Two full months: their average.
    const two = trendsOf([txn('2026-08-10', -20000, 3), txn('2026-09-10', -40000, 3)]);
    expect(two.historyStart).toBe('2026-08');
    expect(two.usual.everyday).toBe(30000);
    // History begins with an income deposit: that month still counts (as zero for spending).
    const paid = trendsOf([txn('2026-08-01', 300000, 10), txn('2026-09-10', -30000, 3)]);
    expect(paid.usual.everyday).toBe(15000);
    // Only the current month: nothing to average.
    const none = trendsOf([txn('2026-10-02', -5000, 3)]);
    expect(none.historyStart).toBe('2026-10');
    expect(none.usual.everyday).toBe(0);
    expect(trendsOf([]).historyStart).toBeNull();
  });

  it('usualOf: one category\u2019s usual, by the same rule as the groups\u2019', () => {
    const t = trendsOf([
      txn('2026-06-10', -99900, 3),
      txn('2026-07-10', -10000, 3),
      txn('2026-08-10', -20000, 3),
      txn('2026-09-10', -30001, 3),
      txn('2026-10-10', -500000, 3),
      txn('2026-09-10', -1000, 5),
    ]);
    expect(usualOf(t, category(t, 3)!.byMonth)).toBe(20000);
    expect(usualOf(t, category(t, 5)!.byMonth)).toBe(333);
    for (const g of t.groups) expect(usualOf(t, g.byMonth)).toBe(t.usual[g.key]);
    // Short history: only the full months since it began.
    const one = trendsOf([txn('2026-09-10', -30000, 4), txn('2026-10-02', -100, 4)]);
    expect(usualOf(one, category(one, 4)!.byMonth)).toBe(30000);
    expect(usualOf(trendsOf([txn('2026-10-02', -5000, 4)]), [0, 0, 0, 0, 5000])).toBe(0);
  });

  it('privacy: a partner’s private charges only count in their own Fun Money', () => {
    const t = trendsOf([
      txn('2026-09-03', -4000, 8, { privateMemberId: ALEX }),
      txn('2026-09-04', -2500, 3, { privateMemberId: ALEX }), // misfiled under Groceries
      txn('2026-09-05', -1500, null, { privateMemberId: ALEX }), // private and uncategorized
      txn('2026-09-06', 1000, 10, { privateMemberId: ALEX }), // private deposit under income
      txn('2026-09-07', -700, 7, { privateMemberId: ALEX }), // private, but filed under Sam's fun money
      txn('2026-09-08', -900, 3, { privateMemberId: 42 }), // private to someone with no Fun Money: dropped
    ]);
    expect(t.categories.map((c) => [c.id, c.byMonth[3]])).toEqual([[8, 4000 + 2500 + 1500 - 1000 + 700]]);
    expect(group(t, 'everyday')).toEqual([0, 0, 0, 0, 0]);
    expect(group(t, 'fun')).toEqual([0, 0, 0, 7700, 0]);
    expect(t.uncategorizedByMonth).toEqual([0, 0, 0, 0, 0]);
    expect(t.incomeByMonth).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('trends: what changed', () => {
  /** Months Jun–Sep: one charge per month per category; October so far as given. */
  function history(rows: [number, number[], number][]): Trends {
    const txns: LedgerTxn[] = [];
    for (const [categoryId, full, current] of rows) {
      full.forEach((cents, i) => cents && txns.push(txn(`${MONTHS[i]}-05`, -cents, categoryId)));
      if (current) txns.push(txn('2026-10-02', -current, categoryId));
    }
    return trendsOf(txns);
  }

  it('scales month-so-far by days elapsed and compares with usual', () => {
    // Day 16 of 31: 16000 so far projects to 31000.
    const t = history([[3, [0, 30000, 30000, 30000], 16000]]);
    const changed = whatChanged(t, '2026-10-16');
    expect(changed.basis).toBe('this-month');
    expect(changed.up).toEqual([]);
    expect(changed.down).toEqual([]);

    const more = whatChanged(history([[3, [0, 30000, 30000, 30000], 20000]]), '2026-10-16');
    // 20000 * 31 / 16 = 38750
    expect(more.up).toEqual([{ categoryId: 3, name: 'Groceries', soFar: 20000, usual: 30000, projected: 38750, diff: 8750 }]);
  });

  it('ignores differences under $20; exactly $20 counts', () => {
    // Day 31: projected = so far.
    const t = history([
      [3, [0, 10000, 10000, 10000], 11999],
      [4, [0, 10000, 10000, 10000], 12000],
      [5, [0, 10000, 10000, 10000], 8001],
      [6, [0, 10000, 10000, 10000], 8000],
    ]);
    const changed = whatChanged(t, '2026-10-31');
    expect(changed.up.map((c) => [c.categoryId, c.diff])).toEqual([[4, 2000]]);
    expect(changed.down.map((c) => [c.categoryId, c.diff])).toEqual([[6, -2000]]);
  });

  it('top 5 up (biggest first) and top 3 down (biggest drop first)', () => {
    const rows: [number, number[], number][] = [
      [13, [0, 10000, 10000, 10000], 13000],
      [14, [0, 10000, 10000, 10000], 15000],
      [3, [0, 10000, 10000, 10000], 14000],
      [4, [0, 10000, 10000, 10000], 16000],
      [5, [0, 10000, 10000, 10000], 12500],
      [6, [0, 10000, 10000, 10000], 17000],
      [7, [0, 10000, 10000, 10000], 5000],
      [8, [0, 10000, 10000, 10000], 2000],
      [15, [0, 10000, 10000, 10000], 7000],
      [12, [0, 10000, 10000, 10000], 0], // not a group category: never listed
    ];
    const changed = whatChanged(history(rows), '2026-10-31');
    expect(changed.up.map((c) => c.categoryId)).toEqual([6, 4, 14, 3, 13]);
    expect(changed.down.map((c) => c.categoryId)).toEqual([8, 7, 15]);
  });

  it('a category with no spending this month shows as down', () => {
    const changed = whatChanged(history([[3, [0, 50000, 50000, 50000], 0]]), '2026-10-31');
    expect(changed.down).toEqual([{ categoryId: 3, name: 'Groceries', soFar: 0, usual: 50000, projected: 0, diff: -50000 }]);
  });

  it('only everyday spending: Bills and Saving never listed (fixed-day payments would spike)', () => {
    // Rent and savings land on the 1st; on day 10 they'd project to 3× usual. Groceries really did jump.
    const txns: LedgerTxn[] = [];
    for (const m of ['2026-07', '2026-08', '2026-09']) {
      txns.push(txn(`${m}-01`, -150000, 1), txn(`${m}-01`, -32000, 2), txn(`${m}-01`, -30000, 9), txn(`${m}-12`, -40000, 3));
    }
    txns.push(txn('2026-10-01', -150000, 1), txn('2026-10-01', -32000, 2), txn('2026-10-01', -30000, 9), txn('2026-10-05', -30000, 3));
    const t = trendsOf(txns);
    const changed = whatChanged(t, '2026-10-10');
    expect(changed.basis).toBe('this-month');
    // Groceries: 30000 * 31 / 10 = 93000 vs 40000 usual.
    expect(changed.up).toEqual([{ categoryId: 3, name: 'Groceries', soFar: 30000, usual: 40000, projected: 93000, diff: 53000 }]);
    expect(changed.down).toEqual([]);
    // A bill that really changed is still not listed: Trends' group chart shows Bills instead.
    const skipped = whatChanged(trendsOf([...txns, txn('2026-10-02', -90000, 1)]), '2026-10-31');
    expect([...skipped.up, ...skipped.down].map((c) => c.categoryId)).toEqual([3]);
  });

  it('the last-month basis (before day 7) leaves out Bills and Saving too', () => {
    // September: rent up, savings down, habits up; usual from Jun–Aug.
    const t = history([
      [1, [150000, 150000, 150000, 200000], 0],
      [9, [30000, 30000, 30000, 0], 0],
      [5, [10000, 10000, 10000, 16000], 0],
      [7, [20000, 20000, 20000, 10000], 0],
    ]);
    const early = whatChanged(t, '2026-10-03');
    expect(early.basis).toBe('last-month');
    expect(early.up.map((c) => [c.categoryId, c.diff])).toEqual([[5, 6000]]);
    expect(early.down.map((c) => [c.categoryId, c.diff])).toEqual([[7, -10000]]);
  });

  it('usual counts from the household’s first month; a new category still averages with zeros', () => {
    // One full month of history: $300 usual, so $600 by the 31st is up $300.
    const one = whatChanged(trendsOf([txn('2026-09-10', -30000, 3), txn('2026-10-02', -60000, 3)]), '2026-10-31');
    expect(one.up).toEqual([{ categoryId: 3, name: 'Groceries', soFar: 60000, usual: 30000, projected: 60000, diff: 30000 }]);
    // Two full months: their average.
    const two = whatChanged(
      trendsOf([txn('2026-08-10', -20000, 3), txn('2026-09-10', -40000, 3), txn('2026-10-02', -60000, 3)]),
      '2026-10-31',
    );
    expect(two.up.map((c) => [c.categoryId, c.usual])).toEqual([[3, 30000]]);
    // Household history from July; Gas first appears in September, so its usual is (0 + 0 + 30000) / 3.
    const established = whatChanged(
      trendsOf([txn('2026-07-10', -10000, 3), txn('2026-09-10', -30000, 4), txn('2026-10-02', -30000, 4)]),
      '2026-10-31',
    );
    expect(established.up.map((c) => [c.categoryId, c.usual, c.diff])).toEqual([[4, 10000, 20000]]);
    expect(established.down.map((c) => [c.categoryId, c.usual])).toEqual([[3, 3333]]);
  });

  it('no rows when there is no full month of history to compare with', () => {
    const t = trendsOf([txn('2026-10-02', -50000, 3)]);
    expect(whatChanged(t, '2026-10-20')).toEqual({ basis: 'this-month', up: [], down: [] });
    // Before day 7 the compared month is September, and nothing came before it.
    const sep = trendsOf([txn('2026-09-10', -50000, 3)]);
    expect(whatChanged(sep, '2026-10-03')).toEqual({ basis: 'last-month', up: [], down: [] });
  });

  it('before day 7, compares the last full month with the 3 months before it', () => {
    // Usual for September = average of Jun–Aug.
    const t = history([[3, [9000, 12000, 15000, 30000], 100]]);
    const early = whatChanged(t, '2026-10-06');
    expect(early.basis).toBe('last-month');
    expect(early.up).toEqual([{ categoryId: 3, name: 'Groceries', soFar: 30000, usual: 12000, projected: 30000, diff: 18000 }]);

    const day7 = whatChanged(t, '2026-10-07');
    expect(day7.basis).toBe('this-month');
    // Usual for October = average of Jul–Sep = 19000; 100 * 31 / 7 = 443.
    expect(day7.down).toEqual([{ categoryId: 3, name: 'Groceries', soFar: 100, usual: 19000, projected: 443, diff: -18557 }]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/trends
// ---------------------------------------------------------------------------

describe('GET /api/trends', () => {
  const YOU = 'you@example.com';
  const PARTNER = 'partner@example.com';
  let db: TestD1;
  let env: Env;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T17:00:00Z')); // the 18th in the household's time zone
    db = new TestD1();
    env = testEnv(db);
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Checking')");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  type Body = Trends & { changed: ReturnType<typeof whatChanged> };
  async function trends(query = '', email?: string): Promise<Body> {
    const res = await api(env, 'GET', `/trends${query}`, undefined, email);
    expect(res.status).toBe(200);
    return (await res.json()) as Body;
  }

  function categoryId(section: string, name: string): number {
    return db.rows<{ id: number }>(
      'SELECT c.id FROM categories c JOIN sections s ON s.id = c.section_id WHERE s.name = ? AND c.name = ?',
      section,
      name,
    )[0]!.id;
  }

  function charge(date: ISODate, cents: number, category: number | null, privateMemberId: number | null = null, name = 'SHOP') {
    db.exec(
      `INSERT INTO transactions (account_id, date, amount_cents, name, source, category_id, private_member_id)
       VALUES (1, ?, ?, ?, 'manual', ?, ?)`,
      date,
      cents,
      name,
      category,
      privateMemberId,
    );
  }

  async function twoPeople() {
    await api(env, 'GET', '/me', undefined, YOU);
    await api(env, 'GET', '/me', undefined, PARTNER);
    const id = (email: string) => db.rows<{ id: number }>('SELECT id FROM members WHERE email = ?', email)[0]!.id;
    const fun = (memberId: number) => db.rows<{ id: number }>('SELECT id FROM categories WHERE fun_member_id = ?', memberId)[0]!.id;
    const you = id(YOU);
    const partner = id(PARTNER);
    return { you, partner, yourFun: fun(you), partnerFun: fun(partner) };
  }

  it('defaults to 12 months ending with the current one, and checks the months asked for', async () => {
    const body = await trends();
    expect(body.months).toHaveLength(12);
    expect(body.months[0]).toBe('2025-11');
    expect(body.partialMonth).toBe('2026-10');
    expect(body.months.at(-1)).toBe('2026-10');
    expect((await trends('?months=3')).months).toEqual(['2026-08', '2026-09', '2026-10']);
    expect((await trends('?months=24')).months).toHaveLength(24);
    for (const bad of ['2', '25', 'abc', '3.5']) {
      expect((await api(env, 'GET', `/trends?months=${bad}`)).status).toBe(400);
    }
  });

  it('partner privacy: a partner’s private charges only show inside their Fun Money total', async () => {
    const { partner, yourFun, partnerFun } = await twoPeople();
    const groceries = categoryId('Everyday', 'Groceries');
    charge('2026-09-10', -5000, groceries);
    charge('2026-09-11', -1000, yourFun);
    charge('2026-09-12', -4000, partnerFun, partner, 'PRIVATE SPA');
    charge('2026-09-13', -2500, groceries, partner, 'PRIVATE BOUTIQUE'); // private, misfiled
    charge('2026-09-14', -700, null, partner, 'PRIVATE KIOSK'); // private, uncategorized

    const body = await trends('', YOU);
    const sep = body.months.indexOf('2026-09');
    const row = (id: number) => body.categories.find((c) => c.id === id);
    expect(row(groceries)?.byMonth[sep]).toBe(5000);
    expect(row(partnerFun)?.byMonth[sep]).toBe(7200);
    expect(row(yourFun)?.byMonth[sep]).toBe(1000);
    expect(body.categories.map((c) => c.id).sort()).toEqual([groceries, yourFun, partnerFun].sort());
    expect(body.groups.find((g) => g.key === 'everyday')!.byMonth[sep]).toBe(5000);
    expect(body.groups.find((g) => g.key === 'fun')!.byMonth[sep]).toBe(8200);
    expect(body.uncategorizedByMonth[sep]).toBe(0);
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE/);
    // Both partners see the same numbers.
    expect(await trends('', PARTNER)).toEqual(body);
  });

  it('usual and what changed don’t depend on how many months are shown', async () => {
    await twoPeople();
    const groceries = categoryId('Everyday', 'Groceries');
    const habits = categoryId('Habits', 'Habits');
    const history: [string, number][] = [
      ['2026-05', 90000],
      ['2026-06', 40000],
      ['2026-07', 30000],
      ['2026-08', 20000],
      ['2026-09', 10000],
    ];
    for (const [month, cents] of history) {
      charge(`${month}-05`, -cents, groceries);
      charge(`${month}-06`, -cents / 10, habits);
    }
    charge('2026-10-02', -60000, groceries);
    const short = await trends('?months=3');
    const long = await trends('?months=12');
    expect(short.usual).toEqual(long.usual);
    expect(short.usual.everyday).toBe(20000);
    expect(short.changed).toEqual(long.changed);
    expect(short.changed.up.map((c) => [c.categoryId, c.usual])).toEqual([[groceries, 20000]]);
    // Every byMonth matches the months shown.
    expect(short.groups.every((g) => g.byMonth.length === 3)).toBe(true);
    expect(short.categories.every((c) => c.byMonth.length === 3)).toBe(true);
    expect(short.incomeByMonth).toHaveLength(3);
    expect(short.uncategorizedByMonth).toHaveLength(3);

    // Before day 7: last month against the 3 months before it, even with 3 months shown.
    vi.setSystemTime(new Date('2026-10-03T17:00:00Z'));
    const early = await trends('?months=3');
    expect(early.changed.basis).toBe('last-month');
    expect(early.changed).toEqual((await trends('?months=12')).changed);
    expect(early.changed.down.map((c) => [c.categoryId, c.soFar, c.usual])).toEqual([
      [groceries, 10000, 30000],
      [habits, 1000, 3000],
    ]);
  });

  it('a new household’s usual is its one full month, not a third of it', async () => {
    await twoPeople();
    const groceries = categoryId('Everyday', 'Groceries');
    charge('2026-09-10', -30000, groceries);
    charge('2026-10-02', -60000, groceries);
    for (const query of ['?months=3', '?months=12']) {
      const body = await trends(query);
      expect(body.historyStart).toBe('2026-09');
      expect(body.usual.everyday).toBe(30000);
      expect(body.changed.up.map((c) => [c.categoryId, c.usual])).toEqual([[groceries, 30000]]);
    }
  });

  it('lists only categories with activity in the months shown', async () => {
    await twoPeople();
    const gas = categoryId('Everyday', 'Gas');
    charge('2026-06-05', -5000, gas); // outside a 3-month view
    expect((await trends('?months=3')).categories).toEqual([]);
    expect((await trends('?months=12')).categories.map((c) => c.id)).toEqual([gas]);
  });

  it('history from before the new category set shows under the new categories', async () => {
    db = new TestD1({ upTo: '0002' });
    env = testEnv(db);
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Checking')");
    charge('2026-04-10', -4200, categoryId('Transportation', 'Fuel'));
    charge('2026-05-01', -150000, categoryId('Housing', 'Mortgage / Rent'));
    charge('2026-05-02', -3300, categoryId('Food', 'Groceries'));
    const dir = join(import.meta.dirname, '../migrations');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql') && f > '0003').sort()) db.migrate(file);

    const body = await trends('?months=12');
    const archived = new Set(db.rows<{ id: number }>('SELECT id FROM categories WHERE archived = 1').map((r) => r.id));
    expect(body.categories.map((c) => [c.name, c.group, c.byMonth.reduce((a, b) => a + b, 0)])).toEqual([
      ['Housing', 'bills', 150000],
      ['Groceries', 'everyday', 3300],
      ['Gas', 'everyday', 4200],
    ]);
    expect(body.categories.some((c) => archived.has(c.id))).toBe(false);
  });

  it('Activity group filter: a group\u2019s transactions in a month, private ones only as your own fun money', async () => {
    const { you, partner, partnerFun } = await twoPeople();
    const groceries = categoryId('Everyday', 'Groceries');
    const gas = categoryId('Everyday', 'Gas');
    const housing = categoryId('Bills', 'Housing');
    charge('2026-09-10', -5000, groceries, null, 'MARKET');
    charge('2026-09-11', -3000, gas, null, 'FUEL STOP');
    charge('2026-08-11', -3000, gas, null, 'AUGUST FUEL'); // another month
    charge('2026-09-12', -90000, housing, null, 'RENT');
    charge('2026-09-13', -2500, groceries, you, 'MY TREAT'); // private: counts as your fun money
    charge('2026-09-14', -4000, partnerFun, partner, 'PARTNER SPA');
    charge('2026-09-15', -6000, null, null, 'SPLIT SHOP');
    const splitId = db.rows<{ id: number }>("SELECT id FROM transactions WHERE name = 'SPLIT SHOP'")[0]!.id;
    db.exec('UPDATE transactions SET is_split = 1 WHERE id = ?', splitId);
    db.exec('INSERT INTO splits (transaction_id, category_id, amount_cents) VALUES (?, ?, ?), (?, ?, ?)', splitId, groceries, -4000, splitId, housing, -2000);

    const names = async (query: string, email?: string) => {
      const res = await api(env, 'GET', `/transactions?${query}`, undefined, email);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { transactions: { name: string }[] };
      return body.transactions.map((t) => t.name).sort();
    };
    expect(await names('month=2026-09&group=everyday')).toEqual(['FUEL STOP', 'MARKET', 'SPLIT SHOP']);
    expect(await names('month=2026-09&group=bills')).toEqual(['RENT', 'SPLIT SHOP']);
    expect(await names('month=2026-09&group=fun')).toEqual(['MY TREAT']);
    expect(await names('month=2026-09&group=fun', PARTNER)).toEqual(['PARTNER SPA']);
    expect(await names('group=everyday')).toEqual(['AUGUST FUEL', 'FUEL STOP', 'MARKET', 'SPLIT SHOP']);
    for (const bad of ['food', 'constructor']) expect((await api(env, 'GET', `/transactions?group=${bad}`)).status).toBe(400);
  });

  it('3,000 rows stay fast', async () => {
    await twoPeople();
    const ids = db.rows<{ id: number }>("SELECT id FROM categories WHERE archived = 0 AND kind != 'transfer'").map((r) => r.id);
    const months = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
    const insert = db.sqlite.prepare(
      `INSERT INTO transactions (account_id, date, amount_cents, name, source, category_id)
       VALUES (1, ?, ?, 'SHOP', 'manual', ?)`,
    );
    db.sqlite.exec('BEGIN');
    for (let i = 0; i < 3000; i++) {
      const day = String((i % 18) + 1).padStart(2, '0');
      insert.run(`${months[i % 12]}-${day}`, -((i * 37) % 20000) - 100, i % 10 === 0 ? null : ids[i % ids.length]!);
    }
    db.sqlite.exec('COMMIT');

    const ledger = await loadLedger(db.d1, '2025-11-01', '2026-10-31');
    const categories = (await loadCategories(db.d1)).map((c) => ({ id: c.id, name: c.name, section: c.sectionName, funMemberId: c.funMemberId }));
    const compute = () =>
      whatChanged(buildTrends({ entries: ledgerEntries(ledger), categories, months, today: '2026-10-18' }), '2026-10-18');
    // Best of several runs: the code's own cost, not a scheduler stall while the suite runs in parallel.
    compute(); // warm up
    let cpuMs = Infinity;
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      compute();
      cpuMs = Math.min(cpuMs, performance.now() - start);
    }

    let body = await trends(); // warm up
    let requestMs = Infinity;
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      body = await trends();
      requestMs = Math.min(requestMs, performance.now() - start);
    }
    console.log(`trends timing (3,000 rows): aggregation ${cpuMs.toFixed(2)} ms, whole request on node:sqlite ${requestMs.toFixed(2)} ms`);

    expect(ledger).toHaveLength(3000);
    expect(body.uncategorizedByMonth.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(cpuMs).toBeLessThan(50);
    expect(requestMs).toBeLessThan(50);
  });
});
