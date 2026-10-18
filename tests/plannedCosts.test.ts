import { describe, expect, it } from 'vitest';
import type { LedgerEntry } from '../src/shared/actuals';
import {
  comingUp,
  costBalance,
  DEFAULT_PLANNED_COSTS,
  monthlyFor,
  plannedMonthTotal,
  roundUpToFive,
  spendByCategoryMonth,
  spendIn,
  suggestionMonths,
  suggestMonthly,
} from '../src/shared/plannedCosts';

const CAR = 1;
const GIFTS = 2;

function entry(date: string, amountCents: number, categoryId: number | null = CAR, kind: LedgerEntry['kind'] = 'expense'): LedgerEntry {
  return { txnId: 1, date, categoryId, kind, kidId: null, privateMemberId: null, amountCents };
}

describe('planned costs: monthly amounts', () => {
  const amounts = [
    { month: '2026-03', monthlyCents: 5000 },
    { month: '2026-06', monthlyCents: 8000 },
  ];

  it('uses the latest amount on or before the month, and the first amount before any row', () => {
    expect(monthlyFor(amounts, '2026-02')).toBe(5000);
    expect(monthlyFor(amounts, '2026-03')).toBe(5000);
    expect(monthlyFor(amounts, '2026-05')).toBe(5000);
    expect(monthlyFor(amounts, '2026-06')).toBe(8000);
    expect(monthlyFor(amounts, '2027-01')).toBe(8000);
    expect(monthlyFor([], '2026-06')).toBe(0);
  });

  it('totals the set-asides of costs that have started by the month', () => {
    const costs = [
      { startMonth: '2026-03', amounts },
      { startMonth: '2026-08', amounts: [{ month: '2026-08', monthlyCents: 4000 }] },
    ];
    expect(plannedMonthTotal(costs, '2026-02')).toBe(0);
    expect(plannedMonthTotal(costs, '2026-04')).toBe(5000);
    expect(plannedMonthTotal(costs, '2026-08')).toBe(12000);
  });
});

describe('planned costs: balance', () => {
  it('adds the set-aside for each month from the start through this month, less spending', () => {
    // Started August at $50, raised to $80 in October; $300 tire bill in September.
    const spend = spendByCategoryMonth([entry('2026-09-14', -30000), entry('2026-07-01', -99900)]);
    const cost = {
      startMonth: '2026-08',
      startBalanceCents: 10000,
      amounts: [
        { month: '2026-08', monthlyCents: 5000 },
        { month: '2026-10', monthlyCents: 8000 },
      ],
      categoryIds: [CAR],
    };
    // 100 + 50 (Aug) + 50 (Sep) + 80 (Oct) − 300; July is before the start and doesn't count.
    expect(costBalance(cost, spend, '2026-10')).toBe(10000 + 5000 + 5000 + 8000 - 30000);
  });

  it('adds refunds back and can go negative', () => {
    const spend = spendByCategoryMonth([entry('2026-10-02', -60000), entry('2026-10-09', 15000)]);
    const cost = { startMonth: '2026-10', startBalanceCents: 0, amounts: [{ month: '2026-10', monthlyCents: 5000 }], categoryIds: [CAR] };
    expect(costBalance(cost, spend, '2026-10')).toBe(5000 - 60000 + 15000);
  });

  it('only counts spending in its own categories', () => {
    const spend = spendByCategoryMonth([entry('2026-10-02', -2000, GIFTS), entry('2026-10-02', -3000, null)]);
    const cost = { startMonth: '2026-10', startBalanceCents: 0, amounts: [{ month: '2026-10', monthlyCents: 5000 }], categoryIds: [CAR] };
    expect(costBalance(cost, spend, '2026-10')).toBe(5000);
  });

  it('sums spending across categories and months', () => {
    const spend = spendByCategoryMonth([entry('2026-08-02', -2000, GIFTS), entry('2026-09-02', -3000), entry('2026-10-02', -500)]);
    expect(spendIn(spend, [CAR, GIFTS], '2026-08', '2026-09')).toBe(5000);
    expect(spendIn(spend, [CAR], '2026-01', '2026-12')).toBe(3500);
  });
});

describe('planned costs: suggestion', () => {
  it('rounds up to the next $5', () => {
    expect(roundUpToFive(0)).toBe(0);
    expect(roundUpToFive(1)).toBe(500);
    expect(roundUpToFive(5000)).toBe(5000);
    expect(roundUpToFive(5001)).toBe(5500);
    expect(roundUpToFive(-400)).toBe(0);
  });

  it('counts the last 12 full months, skipping months before history starts', () => {
    expect(suggestionMonths('2026-10', '2024-01')).toEqual([
      '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03',
      '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09',
    ]);
    expect(suggestionMonths('2026-10', '2026-07')).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(suggestionMonths('2026-10', '2026-10')).toEqual([]);
    expect(suggestionMonths('2026-10', null)).toEqual([]);
  });

  it('averages over the counted months and needs at least 3', () => {
    expect(suggestMonthly(66000, 12)).toBe(5500); // $55 a month
    expect(suggestMonthly(10000, 3)).toBe(3500); // 33.33 → 35
    expect(suggestMonthly(10000, 2)).toBeNull();
    expect(suggestMonthly(0, 12)).toBe(0);
  });

  it('has fallback amounts for the defaults when history is short', () => {
    expect(DEFAULT_PLANNED_COSTS.map((d) => [d.name, d.categories, d.fallbackMonthlyCents])).toEqual([
      ['Car', [['Everyday', 'Car Upkeep']], 5000],
      ['Health', [['Everyday', 'Medical']], 4000],
      ['Holidays & gifts', [['Fun & Wants', 'Gifts']], 7500],
    ]);
  });
});

describe('planned costs: coming up', () => {
  const bills = [
    { name: 'Amazon Prime', nextDate: '2027-03-03', amountCents: 13900, categoryId: GIFTS },
    { name: 'Registration', nextDate: '2026-11-20', amountCents: 8500, categoryId: CAR },
    // Stale date: rolls forward a year.
    { name: 'License', nextDate: '2026-02-01', amountCents: 4000, categoryId: CAR },
  ];

  it('lists linked yearly bills by date, rolling stale dates forward', () => {
    const items = comingUp({ categoryIds: [CAR], bills, spend: new Map(), today: '2026-10-18', historyStart: '2026-06' });
    expect(items).toEqual([
      { kind: 'bill', name: 'Registration', date: '2026-11-20', amountCents: 8500 },
      { kind: 'bill', name: 'License', date: '2027-02-01', amountCents: 4000 },
    ]);
  });

  it("adds last year's biggest month when it comes around within 3 months", () => {
    const spend = spendByCategoryMonth([
      entry('2025-12-10', -42000, GIFTS),
      entry('2026-03-10', -9000, GIFTS),
      entry('2025-10-01', -1000, GIFTS),
    ]);
    const items = comingUp({ categoryIds: [GIFTS], bills: [], spend, today: '2026-10-18', historyStart: '2025-01' });
    expect(items).toEqual([{ kind: 'usual', month: '2026-12', amountCents: 42000 }]);
  });

  it('skips the usual month when it is further out, or history is under 12 months', () => {
    const spend = spendByCategoryMonth([entry('2026-04-10', -42000, GIFTS)]);
    expect(comingUp({ categoryIds: [GIFTS], bills: [], spend, today: '2026-10-18', historyStart: '2025-01' })).toEqual([]);
    const december = spendByCategoryMonth([entry('2025-12-10', -42000, GIFTS)]);
    expect(comingUp({ categoryIds: [GIFTS], bills: [], spend: december, today: '2026-10-18', historyStart: '2025-11' })).toEqual([]);
  });
});
