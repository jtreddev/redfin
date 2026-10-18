import { describe, expect, it } from 'vitest';
import { ledgerEntries, type CategoryKind, type LedgerSplit, type LedgerTxn } from '../src/shared/actuals';
import type { ISODate, MonthKey } from '../src/shared/dates';
import { buildTrends, GROUP_ORDER, whatChanged, type GroupKey, type Trends } from '../src/shared/trends';

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
    expect(category(t, 2)).toEqual({ id: 2, name: 'Loans', group: 'bills', byMonth: [0, 0, 32000, 0, 0] });
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
      [1, [0, 10000, 10000, 10000], 13000],
      [2, [0, 10000, 10000, 10000], 15000],
      [3, [0, 10000, 10000, 10000], 14000],
      [4, [0, 10000, 10000, 10000], 16000],
      [5, [0, 10000, 10000, 10000], 12500],
      [6, [0, 10000, 10000, 10000], 17000],
      [7, [0, 10000, 10000, 10000], 5000],
      [8, [0, 10000, 10000, 10000], 2000],
      [9, [0, 10000, 10000, 10000], 7000],
      [12, [0, 10000, 10000, 10000], 0], // not a group category: never listed
    ];
    const changed = whatChanged(history(rows), '2026-10-31');
    expect(changed.up.map((c) => c.categoryId)).toEqual([6, 4, 2, 3, 1]);
    expect(changed.down.map((c) => c.categoryId)).toEqual([8, 7, 9]);
  });

  it('a category with no spending this month shows as down', () => {
    const changed = whatChanged(history([[1, [0, 50000, 50000, 50000], 0]]), '2026-10-31');
    expect(changed.down).toEqual([{ categoryId: 1, name: 'Housing', soFar: 0, usual: 50000, projected: 0, diff: -50000 }]);
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
