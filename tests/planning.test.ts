import { describe, expect, it } from 'vitest';
import { draftNextBudget, summarizeMonth, type CheckinLine } from '../src/shared/checkin';
import { planPayoff } from '../src/shared/debt';
import { goalProgress, monthsLeftInclusive } from '../src/shared/goals';

describe('debt payoff', () => {
  it('matches the amortization formula for a single card', () => {
    // $5,000 at 24% APR paying $200/month: n = ln(2)/ln(1.02) ≈ 35.003 payments,
    // so a tiny final payment lands in month 36 and total interest ≈ $2,000.56.
    const plan = planPayoff(
      [{ id: 'card', name: 'Card', balanceCents: 500000, aprPercent: 24, minPaymentCents: 20000 }],
      'avalanche',
    );
    expect(plan.months).toBe(36);
    expect(Math.abs(plan.totalInterestCents - 200056)).toBeLessThanOrEqual(100);
    expect(plan.totalPaidCents).toBe(500000 + plan.totalInterestCents);
  });

  it('orders snowball by balance and avalanche by APR, and extra money speeds things up', () => {
    const debts = [
      { id: 'big', name: 'Big 29%', balanceCents: 800000, aprPercent: 29, minPaymentCents: 24000 },
      { id: 'small', name: 'Small 9%', balanceCents: 90000, aprPercent: 9, minPaymentCents: 3500 },
    ];
    const snowball = planPayoff(debts, 'snowball', 20000);
    const avalanche = planPayoff(debts, 'avalanche', 20000);
    expect(snowball.order).toEqual(['small', 'big']);
    expect(avalanche.order).toEqual(['big', 'small']);
    expect(avalanche.totalInterestCents).toBeLessThanOrEqual(snowball.totalInterestCents);
    expect((planPayoff(debts, 'avalanche', 0).months ?? 0)).toBeGreaterThan(avalanche.months ?? 0);
  });

  it('flags minimum payments that never cover interest', () => {
    const plan = planPayoff(
      [{ id: 'x', name: 'X', balanceCents: 1000000, aprPercent: 30, minPaymentCents: 20000 }],
      'snowball',
      0,
      120,
    );
    expect(plan.minimumBelowInterest).toEqual(['x']);
    expect(plan.months).toBeNull();
  });
});

describe('goals', () => {
  it('counts months left including this one', () => {
    expect(monthsLeftInclusive('2026-09-13', '2026-12-31')).toBe(4);
    expect(monthsLeftInclusive('2026-09-13', '2026-08-01')).toBe(1);
  });

  it('computes monthly amount needed and on-track status', () => {
    const behind = goalProgress(
      { targetCents: 500000, savedCents: 100000, targetDate: '2026-12-31', contributionsByMonth: [20000, 30000, 25000, 5000] },
      '2026-09-13',
    );
    expect(behind.monthlyNeededCents).toBe(100000);
    expect(behind.recentAverageCents).toBe(25000);
    expect(behind.status).toBe('behind');
    expect(goalProgress({ targetCents: 1000, savedCents: 1500 }, '2026-09-13').status).toBe('done');
    expect(goalProgress({ targetCents: 1000, savedCents: 0 }, '2026-09-13').status).toBe('no_date');
  });
});

describe('monthly check-in', () => {
  const lines: CheckinLine[] = [
    { categoryId: 1, name: 'Paychecks', section: 'Income', kind: 'income', budgetCents: 774000, actualCents: 774000 },
    { categoryId: 2, name: 'Groceries', section: 'Food', kind: 'expense', budgetCents: 120000, actualCents: 131000 },
    { categoryId: 3, name: 'Dining Out', section: 'Food', kind: 'expense', budgetCents: 20000, actualCents: 9000 },
    { categoryId: 4, name: 'Pets', section: 'Personal', kind: 'expense', budgetCents: 9000, actualCents: 16000 },
    { categoryId: 5, name: 'Gifts', section: 'Personal', kind: 'expense', budgetCents: 0, actualCents: 4000 },
  ];

  it('summarizes wins, overspending and unbudgeted spending', () => {
    const summary = summarizeMonth(lines);
    expect(summary.spendActualCents).toBe(160000);
    expect(summary.netActualCents).toBe(614000);
    expect(summary.wins.map((l) => l.name)).toEqual(['Dining Out']);
    expect(summary.overspent.map((l) => [l.name, l.overCents])).toEqual([
      ['Groceries', 11000],
      ['Pets', 7000],
    ]);
    expect(summary.unbudgeted.map((l) => l.name)).toEqual(['Gifts']);
  });

  it('drafts next month from decisions', () => {
    const draft = draftNextBudget(lines, { 2: { kind: 'raise' }, 4: { kind: 'set', newBudgetCents: 12000 } });
    expect(draft.find((d) => d.categoryId === 2)?.budgetCents).toBe(131000);
    expect(draft.find((d) => d.categoryId === 4)?.budgetCents).toBe(12000);
    expect(draft.find((d) => d.categoryId === 3)?.budgetCents).toBe(20000);
  });
});
