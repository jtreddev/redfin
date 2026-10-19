import { describe, expect, it } from 'vitest';
import { estimatedMinimum, planPayoff } from '../src/shared/debt';
import type { MonthsAheadInput, PlannedCostInput } from '../src/shared/monthsAhead';
import {
  aheadEvents,
  autoFill,
  cardPaidInFull,
  planAhead,
  suggestSurprise,
  type AheadDebt,
  type AheadInput,
  type AheadPlan,
} from '../src/shared/planAhead';

const TODAY = '2026-10-18'; // 13 days left in October
const ZERO = { bills: 0, everyday: 0, habits: 0, fun: 0, saving: 0 };
const monthly = { name: 'Paycheck', netPayCents: 300_000, schedule: { frequency: 'monthly' as const, anchorDate: '2026-09-25' } };

function months(overrides: Partial<MonthsAheadInput> = {}): MonthsAheadInput {
  return {
    today: TODAY,
    startBalanceCents: 200_000,
    lowBalanceCents: 50_000,
    income: [],
    bills: [],
    usual: { ...ZERO },
    billsInUsual: [],
    saving: {},
    plannedCosts: [],
    historyStart: '2026-01',
    goals: [],
    otherBillsCents: 0,
    ...overrides,
  };
}

function input(overrides: Partial<AheadInput> = {}): AheadInput {
  return { ...months(), debts: [], aheadGoals: [], items: [], surpriseCents: 0, surpriseSuggestedCents: 0, strategy: 'avalanche', ...overrides };
}

function debt(overrides: Partial<AheadDebt> = {}): AheadDebt {
  return {
    id: 1,
    name: 'Card',
    kind: 'credit_card',
    balanceCents: 100_000,
    aprPercent: 0,
    minPaymentCents: 10_000,
    // Due before today: this month's is paid.
    dueDay: 5,
    endMonth: null,
    paidInFull: false,
    sort: 0,
    covered: false,
    ...overrides,
  };
}

function cost(overrides: Partial<PlannedCostInput> = {}): PlannedCostInput {
  return {
    id: 7,
    name: 'Holidays & gifts',
    group: 'fun',
    balanceNowCents: 31_000,
    startMonth: '2026-01',
    amounts: [{ month: '2026-01', monthlyCents: 5_000 }],
    spendByMonth: {},
    usualCents: 0,
    ownBillsMonthlyCents: 0,
    ...overrides,
  };
}

const plan = (overrides: Partial<AheadPlan> = {}): AheadPlan => ({
  debtExtra: {},
  costMonthly: {},
  goalMonthly: {},
  surpriseCents: 0,
  strategy: 'avalanche',
  order: [],
  ...overrides,
});

const lines = (r: ReturnType<typeof planAhead>, i: number, kind?: string) =>
  r.projection.months[i]!.ahead.lines.filter((l) => kind === undefined || l.kind === kind).map((l) => [l.name, l.amountCents]);

describe('planPayoff, extended', () => {
  it('pays each debt its own extra, keeps a balance series and rolls a paid-off debt’s money on', () => {
    const r = planPayoff(
      [
        { id: 'a', name: 'A', balanceCents: 30_000, aprPercent: 0, minPaymentCents: 10_000, extraCents: 10_000 },
        { id: 'b', name: 'B', balanceCents: 60_000, aprPercent: 0, minPaymentCents: 10_000 },
      ],
      'avalanche',
      { seriesMonths: 4 },
    );
    // Month 1: A 20,000, B 10,000. Month 2: A's last 10,000, its unused extra to B (20,000). Month 3: B takes all 40,000.
    expect(r.debts.map((d) => [d.id, d.payoffMonth, d.balances, d.payments])).toEqual([
      ['a', 2, [10_000, 0, 0, 0], [20_000, 10_000, 0, 0]],
      ['b', 3, [50_000, 30_000, 0, 0], [10_000, 20_000, 30_000, 0]],
    ]);
    expect(r.months).toBe(3);
  });

  it('aims the extra by rate, by balance or in my order, rolling over under each', () => {
    const debts = [
      { id: 'big', name: 'Big', balanceCents: 300_000, aprPercent: 20, minPaymentCents: 10_000 },
      { id: 'small', name: 'Small', balanceCents: 50_000, aprPercent: 10, minPaymentCents: 5_000 },
      { id: 'mid', name: 'Mid', balanceCents: 100_000, aprPercent: 15, minPaymentCents: 5_000 },
    ];
    const run = (strategy: 'avalanche' | 'snowball' | 'custom', order?: string[]) => planPayoff(debts, strategy, { extraCents: 20_000, order, maxMonths: 360 });
    expect(run('avalanche').order).toEqual(['big', 'mid', 'small']);
    expect(run('snowball').order).toEqual(['small', 'mid', 'big']);
    // Debts left out of my order follow by rate.
    expect(run('custom', ['mid']).order).toEqual(['mid', 'big', 'small']);
    for (const r of [run('avalanche'), run('snowball'), run('custom', ['mid', 'small', 'big'])]) {
      const first = r.debts.find((d) => d.id === r.order[0])!;
      // The target is paid off first, and everything is paid: balances + interest.
      expect(Math.min(...r.debts.map((d) => d.payoffMonth!))).toBe(first.payoffMonth);
      expect(r.totalPaidCents).toBe(450_000 + r.totalInterestCents);
    }
    expect(run('avalanche').totalInterestCents).toBeLessThan(run('snowball').totalInterestCents);
  });

  it('pays a fixed-term loan off by its last payment', () => {
    const r = planPayoff([{ id: 'bnpl', name: 'Pay in 3', balanceCents: 40_000, aprPercent: 0, minPaymentCents: 0, termMonths: 3 }], 'avalanche', { seriesMonths: 3 });
    expect(r.debts[0]!.payments).toEqual([13_334, 13_333, 13_333]);
    expect(r.debts[0]!.payoffMonth).toBe(3);
  });

  it('leaves out a card paid in full', () => {
    const r = planPayoff([{ id: 'x', name: 'X', balanceCents: 40_000, aprPercent: 20, minPaymentCents: 2_500, paidInFull: true }], 'avalanche');
    expect(r.debts).toEqual([]);
    expect(r.months).toBe(0);
  });

  it('estimates a minimum: $25, or 1% plus a month’s interest, never more than the balance', () => {
    // 1,000 + 2,000 interest.
    expect(estimatedMinimum(100_000, 24)).toBe(3_000);
    expect(estimatedMinimum(50_000, 0)).toBe(2_500);
    expect(estimatedMinimum(1_000, 0)).toBe(1_000);
    expect(estimatedMinimum(0, 20)).toBe(0);
  });
});

describe('planAhead', () => {
  it('matches debt.ts’s interest and payoff for one card', () => {
    const card = debt({ balanceCents: 500_000, aprPercent: 24, minPaymentCents: 20_000 });
    const r = planAhead(input({ debts: [card] }), plan());
    const reference = planPayoff([{ id: 1, name: 'Card', balanceCents: 500_000, aprPercent: 24, minPaymentCents: 20_000 }], 'avalanche');
    expect(r.debts[0]!.interestCents).toBe(reference.totalInterestCents);
    // 36 payments from November.
    expect(r.debts[0]!.payoffMonth).toBe('2029-10');
    expect(r.debtFreeMonth).toBe('2029-10');
    expect(r.totalInterestCents).toBe(reference.totalInterestCents);
  });

  it('pays a debt due later this month its minimum now, and counts the extra from next month', () => {
    const r = planAhead(input({ debts: [debt({ dueDay: 25 })] }), plan({ debtExtra: { 1: 5_000 } }), 3);
    expect(lines(r, 0, 'debt')).toEqual([['Card', 10_000]]);
    expect(lines(r, 1, 'debt')).toEqual([['Card', 15_000]]);
    // 100,000 − 10,000 − 15,000 a month.
    expect(r.debts[0]!.balances).toEqual([90_000, 75_000, 60_000, 45_000]);
    expect(r.debtTotals).toEqual([90_000, 75_000, 60_000, 45_000]);
    // 90,000 / 15,000 = 6 more months; at the minimum alone, 9.
    expect(r.debts[0]!.payoffMonth).toBe('2027-04');
    expect(r.debts[0]!.minimumOnly.payoffMonth).toBe('2027-07');
  });

  it('counts a debt whose bill or budget line pays it only once: not again this month', () => {
    const r = planAhead(input({ debts: [debt({ dueDay: 25, covered: true })] }), plan(), 3);
    expect(lines(r, 0, 'debt')).toEqual([]);
    // Later months' bill was taken out of the bills (the gatherer's job), so the plan counts it.
    expect(lines(r, 1, 'debt')).toEqual([['Card', 10_000]]);
  });

  it('pays a fixed-term loan off by its end month', () => {
    const bnpl = debt({ name: 'Pay in 3', kind: 'bnpl', balanceCents: 40_000, minPaymentCents: 0, endMonth: '2027-01' });
    const r = planAhead(input({ debts: [bnpl] }), plan(), 6);
    expect([1, 2, 3, 4].map((i) => lines(r, i, 'debt'))).toEqual([[['Pay in 3', 13_334]], [['Pay in 3', 13_333]], [['Pay in 3', 13_333]], []]);
    expect(r.debts[0]!.payoffMonth).toBe('2027-01');
  });

  it('leaves cards paid in full out of payoff, the debt total and the cash', () => {
    const r = planAhead(input({ debts: [debt(), debt({ id: 2, name: 'Clear card', paidInFull: true, balanceCents: 80_000 })] }), plan(), 3);
    expect(r.debts.map((d) => d.name)).toEqual(['Card']);
    expect(r.debtTotals[0]).toBe(100_000);
    expect(lines(r, 1, 'debt')).toEqual([['Card', 10_000]]);
  });

  it('rolls a paid-off debt’s payment to the next in order', () => {
    const r = planAhead(
      input({ debts: [debt({ id: 1, name: 'A', balanceCents: 20_000, aprPercent: 20 }), debt({ id: 2, name: 'B', balanceCents: 90_000, aprPercent: 10 })] }),
      plan({ debtExtra: { 1: 10_000 } }),
      6,
    );
    // A takes 20,000 a month (+ interest) and is gone in month 2; B then gets its 10,000 plus A's 20,000.
    expect(r.debts.find((d) => d.name === 'A')!.payoffMonth).toBe('2026-12');
    expect(lines(r, 3, 'debt')).toEqual([['B', 30_000]]);
    // Custom order doesn't move an extra tied to a debt, only freed money: same here.
    const custom = planAhead(input({ debts: r.debts.map((_, i) => debt({ id: i + 1, name: i ? 'B' : 'A', balanceCents: i ? 90_000 : 20_000 })) }), plan({ strategy: 'custom', order: [2, 1] }), 6);
    expect(custom.debts.map((d) => d.name)).toEqual(['A', 'B']);
  });

  it('says when a debt is not paid off within 30 years', () => {
    const r = planAhead(input({ debts: [debt({ balanceCents: 1_000_000, aprPercent: 30, minPaymentCents: 20_000 })] }), plan());
    expect(r.debts[0]!.payoffMonth).toBeNull();
    expect(r.debtFreeMonth).toBeNull();
  });

  it('counts known items once, every month or every year, up to an end month', () => {
    const r = planAhead(
      input({
        items: [
          { id: 1, name: 'Tax refund', amountCents: 50_000, month: '2026-12', repeat: 'once', endMonth: null },
          { id: 2, name: 'Savings transfer', amountCents: -10_000, month: '2026-11', repeat: 'monthly', endMonth: '2027-01' },
          { id: 3, name: 'Registration', amountCents: -20_000, month: '2026-03', repeat: 'yearly', endMonth: null },
          { id: 4, name: 'Old party', amountCents: -5_000, month: '2026-09', repeat: 'once', endMonth: null },
        ],
      }),
      plan(),
      12,
    );
    const by = (i: number) => lines(r, i, 'item');
    expect(by(0)).toEqual([]);
    expect(by(1)).toEqual([['Savings transfer', 10_000]]);
    expect(by(2)).toEqual([['Tax refund', -50_000], ['Savings transfer', 10_000]]);
    expect(by(3)).toEqual([['Savings transfer', 10_000]]);
    expect(by(4)).toEqual([]);
    expect(by(5)).toEqual([['Registration', 20_000]]);
    expect(r.projection.months[2]!.inCents).toBe(50_000);
    expect(r.projection.months[2]!.ahead).toMatchObject({ inCents: 50_000, outCents: 10_000 });
    expect(r.projection.months[2]!.outCents).toBe(10_000);
  });

  it('counts surprises in whole months only, and set-aside changes and goal saving from next month', () => {
    const r = planAhead(
      input({ plannedCosts: [cost()], aheadGoals: [{ id: 3, name: 'Trip', remainingCents: 25_000, targetDate: null }] }),
      plan({ surpriseCents: 15_000, costMonthly: { 7: 8_000 }, goalMonthly: { 3: 10_000 } }),
      6,
    );
    expect(lines(r, 0)).toEqual([]);
    expect(lines(r, 1)).toEqual([['Surprises', 15_000], ['Holidays & gifts', 3_000], ['Trip', 10_000]]);
    // The goal's last 5,000 lands in January, then it's reached.
    expect(lines(r, 3, 'goal')).toEqual([['Trip', 5_000]]);
    expect(lines(r, 4, 'goal')).toEqual([]);
    expect(r.goals).toEqual([{ id: 3, name: 'Trip', monthlyCents: 10_000, reachedMonth: '2027-01' }]);
    // The set-aside is 3,000 more each whole month: its balance follows. (October spends 13/31 of 5,000.)
    expect(r.costs[0]).toMatchObject({ currentMonthlyCents: 5_000, monthlyCents: 8_000 });
    expect(r.costs[0]!.balances.slice(0, 3)).toEqual([28_903, 28_903 + 3_000, 28_903 + 6_000]);
  });

  it('works out the left-over before any extra, and what the sliders take from it', () => {
    const base = input({ income: [monthly], usual: { ...ZERO, everyday: 200_000 }, debts: [debt({ minPaymentCents: 20_000, balanceCents: 1_000_000 })] });
    const r = planAhead(base, plan({ surpriseCents: 10_000, debtExtra: { 1: 30_000 }, goalMonthly: {} }), 3);
    // 300,000 in − 200,000 usual − 20,000 minimum − 10,000 surprises.
    expect(r.leftOverCents).toBe(70_000);
    expect(r.allocatedCents).toBe(30_000);
    expect(r.unallocatedCents).toBe(40_000);
    // Over-allocated: allowed, flagged by a negative unallocated amount.
    const over = planAhead(base, plan({ surpriseCents: 10_000, debtExtra: { 1: 100_000 } }), 3);
    expect(over.leftOverCents).toBe(70_000);
    expect(over.unallocatedCents).toBe(-30_000);
    expect(over.projection.months[1]!.leftOverCents).toBe(70_000 - 100_000);
  });

  it('flags a set-aside that runs short', () => {
    const holidays = cost({ balanceNowCents: 31_000, spendByMonth: { '2025-12': 54_000 } });
    const r = planAhead(input({ historyStart: '2025-01', plannedCosts: [holidays] }), plan(), 6);
    expect(r.costs[0]!.runsShortMonth).toBe('2026-12');
    const fixed = planAhead(input({ historyStart: '2025-01', plannedCosts: [holidays] }), plan({ costMonthly: { 7: 11_500 } }), 6);
    expect(fixed.costs[0]!.runsShortMonth).toBeNull();
  });
});

describe('autoFill', () => {
  it('fills set-asides, then goals with a date, then debts by highest rate', () => {
    const holidays = cost({ balanceNowCents: 31_000, spendByMonth: { '2025-12': 54_000 } });
    const r = autoFill(
      input({
        historyStart: '2025-01',
        income: [monthly],
        usual: { ...ZERO, everyday: 200_000 },
        plannedCosts: [holidays],
        aheadGoals: [
          { id: 3, name: 'Trip', remainingCents: 60_000, targetDate: '2027-03-15' },
          { id: 4, name: 'Someday', remainingCents: 60_000, targetDate: null },
        ],
        debts: [
          debt({ id: 1, name: 'Low', balanceCents: 500_000, aprPercent: 9, minPaymentCents: 10_000 }),
          debt({ id: 2, name: 'High', balanceCents: 500_000, aprPercent: 25, minPaymentCents: 10_000 }),
        ],
      }),
    );
    // Left over: 300,000 − 200,000 − 20,000 minimums − 5,000 Holidays set-aside = 75,000.
    // Holidays runs 13,000 short in December after 2 set-asides: +6,500. Trip: 60,000 over Nov–Mar = 12,000.
    expect(r.costMonthly).toEqual({ 7: 5_000 + 6_500 });
    expect(r.goalMonthly).toEqual({ 3: 12_000, 4: 0 });
    expect(r.debtExtra).toEqual({ 2: 75_000 - 6_500 - 12_000, 1: 0 });
  });

  it('gives what’s left to goals evenly when there are no debts, and stops when the money runs out', () => {
    const goals = [
      { id: 3, name: 'Trip', remainingCents: 600_000, targetDate: null },
      { id: 4, name: 'Fund', remainingCents: 600_000, targetDate: null },
    ];
    expect(autoFill(input({ income: [monthly], usual: { ...ZERO, everyday: 200_000 }, aheadGoals: goals })).goalMonthly).toEqual({ 3: 50_000, 4: 50_000 });
    // Nothing left over: nothing is handed out.
    const none = autoFill(input({ income: [monthly], usual: { ...ZERO, everyday: 400_000 }, aheadGoals: goals, debts: [debt()] }));
    expect(none.goalMonthly).toEqual({ 3: 0, 4: 0 });
    expect(none.debtExtra).toEqual({ 1: 0 });
  });
});

describe('suggestSurprise', () => {
  const charge = (date: string, dollars: number, extra: { categoryId?: number | null; isBill?: boolean } = {}) => ({
    date,
    amountCents: -dollars * 100,
    categoryId: extra.categoryId ?? null,
    isBill: extra.isBill ?? false,
  });

  it('takes the median month of the last 6 full months, rounded to $25', () => {
    const charges = [
      charge('2026-04-02', 100), // April: 100
      charge('2026-05-03', 120), // May: 120 + 160 = 280
      charge('2026-05-20', 160),
      charge('2026-06-09', 140), // June: 140
      charge('2026-07-01', 101), // July: 101
      // August: nothing.
      charge('2026-09-30', 400), // September: 400
      charge('2026-03-31', 9_999), // March: too old
      charge('2026-10-02', 9_999), // October: not a full month yet
    ];
    // 0, 100, 101, 140, 280, 400: median (101 + 140) / 2 = 120.50, to the nearest $25: 125.
    expect(suggestSurprise(charges, TODAY, new Set())).toBe(12_500);
  });

  it('leaves out bills, due-day and planned-cost categories, and anything under $100', () => {
    const months = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
    const charges = months.flatMap((m) => [
      charge(`${m}-10`, 200),
      charge(`${m}-11`, 99.99),
      charge(`${m}-12`, 500, { isBill: true }),
      charge(`${m}-13`, 700, { categoryId: 5 }),
      charge(`${m}-14`, 150, { categoryId: 6 }),
    ]);
    expect(suggestSurprise(charges, TODAY, new Set([5]))).toBe(35_000);
  });
});

describe('cardPaidInFull', () => {
  it('needs each of the last 3 months’ payments to clear the month before’s charges', () => {
    const months = {
      '2026-06': { paidCents: 0, chargedCents: 40_000 },
      '2026-07': { paidCents: 40_000, chargedCents: 30_000 },
      '2026-08': { paidCents: 30_000, chargedCents: 50_000 },
      '2026-09': { paidCents: 49_950, chargedCents: 20_000 },
    };
    expect(cardPaidInFull(months, TODAY)).toBe(true);
    expect(cardPaidInFull({ ...months, '2026-08': { paidCents: 20_000, chargedCents: 50_000 } }, TODAY)).toBe(false);
    // A card not used and not paid isn't "paid in full".
    expect(cardPaidInFull({}, TODAY)).toBe(false);
  });
});

describe('aheadEvents', () => {
  it('makes the saved plan’s debt payments and goal saving into dated events', () => {
    const events = aheadEvents(
      {
        debts: [debt({ dueDay: 25 }), debt({ id: 2, name: 'Loan', dueDay: 3, covered: true }), debt({ id: 3, name: 'Clear', paidInFull: true })],
        goals: [{ id: 3, name: 'Trip', monthlyCents: 10_000 }],
        debtExtra: { 1: 5_000, 2: 2_000 },
      },
      TODAY,
      '2026-11-30',
    );
    expect(events.map((e) => [e.date, e.name, e.amountCents])).toEqual([
      ['2026-10-25', 'Card', 10_000],
      ['2026-11-01', 'Trip', 10_000],
      ['2026-11-03', 'Loan', 12_000],
      ['2026-11-25', 'Card', 15_000],
    ]);
  });
});

describe('speed', () => {
  it('runs a year with 10 debts and a 30-year tail in under 16 ms', () => {
    const debts = Array.from({ length: 10 }, (_, i) =>
      debt({ id: i + 1, name: `Debt ${i}`, balanceCents: 2_000_000 + i * 10_000, aprPercent: 10 + i, minPaymentCents: 18_000 + i * 500, dueDay: 1 + i * 2 }),
    );
    const big = input({
      income: [monthly],
      usual: { ...ZERO, everyday: 150_000 },
      plannedCosts: [cost(), cost({ id: 8, name: 'Car' }), cost({ id: 9, name: 'Health' })],
      aheadGoals: [{ id: 1, name: 'Fund', remainingCents: 500_000, targetDate: '2027-12-01' }],
      items: [{ id: 1, name: 'Refund', amountCents: 40_000, month: '2027-03', repeat: 'yearly', endMonth: null }],
      debts,
    });
    const p = plan({ debtExtra: { 1: 1_000 }, surpriseCents: 10_000 });
    planAhead(big, p);
    // Warm, then the slowest of several runs.
    let slowest = 0;
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      planAhead(big, p);
      slowest = Math.max(slowest, performance.now() - start);
    }
    // The whole 30-year tail was run.
    expect(planAhead(big, p).debts.some((d) => d.payoffMonth === null)).toBe(true);
    expect(slowest).toBeLessThan(16);
    const start = performance.now();
    autoFill(big);
    expect(performance.now() - start).toBeLessThan(16);
  });
});
