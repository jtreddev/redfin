import type { Cents } from './money';

export interface DebtInput {
  id: string | number;
  name: string;
  balanceCents: Cents;
  /** Annual percentage rate, e.g. 24.99. */
  aprPercent: number;
  minPaymentCents: Cents;
}

export type PayoffStrategy = 'snowball' | 'avalanche';

export interface DebtPayoff {
  id: string | number;
  name: string;
  /** Month number (1 = next payment) when the balance hits zero; null if not within the horizon. */
  payoffMonth: number | null;
  interestCents: Cents;
}

export interface PayoffPlan {
  strategy: PayoffStrategy;
  extraCents: Cents;
  /** Months until everything is paid off; null if it never finishes within the horizon. */
  months: number | null;
  totalInterestCents: Cents;
  totalPaidCents: Cents;
  /** Order extra money is aimed at. */
  order: (string | number)[];
  debts: DebtPayoff[];
  /** Debts whose minimum payment doesn't cover the first month's interest. */
  minimumBelowInterest: (string | number)[];
}

export function monthlyInterest(balanceCents: Cents, aprPercent: number): Cents {
  return Math.round((balanceCents * aprPercent) / 100 / 12);
}

/**
 * Month-by-month payoff simulation. Each month: interest accrues, every debt gets its
 * minimum, and the extra (plus minimums freed up by paid-off debts) goes to the target:
 * smallest balance first (snowball) or highest APR first (avalanche).
 */
export function planPayoff(
  debts: readonly DebtInput[],
  strategy: PayoffStrategy,
  extraCents = 0,
  maxMonths = 600,
): PayoffPlan {
  const state = debts
    .filter((d) => d.balanceCents > 0)
    .map((d) => ({ ...d, balance: d.balanceCents, interest: 0, payoffMonth: null as number | null }));

  const order = [...state].sort((a, b) =>
    strategy === 'snowball'
      ? a.balance - b.balance || b.aprPercent - a.aprPercent
      : b.aprPercent - a.aprPercent || a.balance - b.balance,
  );
  const minimumBelowInterest = state
    .filter((d) => d.minPaymentCents <= monthlyInterest(d.balance, d.aprPercent))
    .map((d) => d.id);

  const monthlyBudget = state.reduce((total, d) => total + d.minPaymentCents, 0) + Math.max(0, extraCents);
  let totalPaid = 0;
  let months: number | null = state.length === 0 ? 0 : null;

  for (let month = 1; month <= maxMonths && months === null; month++) {
    const active = state.filter((d) => d.balance > 0);
    for (const d of active) {
      const interest = monthlyInterest(d.balance, d.aprPercent);
      d.balance += interest;
      d.interest += interest;
    }

    let pool = monthlyBudget;
    for (const d of active) {
      const pay = Math.min(d.minPaymentCents, d.balance, pool);
      d.balance -= pay;
      pool -= pay;
      totalPaid += pay;
    }
    for (const d of order) {
      if (pool <= 0) break;
      if (d.balance <= 0) continue;
      const pay = Math.min(pool, d.balance);
      d.balance -= pay;
      pool -= pay;
      totalPaid += pay;
    }

    for (const d of active) {
      if (d.balance <= 0 && d.payoffMonth === null) d.payoffMonth = month;
    }
    if (state.every((d) => d.balance <= 0)) months = month;
  }

  return {
    strategy,
    extraCents: Math.max(0, extraCents),
    months,
    totalInterestCents: state.reduce((total, d) => total + d.interest, 0),
    totalPaidCents: totalPaid,
    order: order.map((d) => d.id),
    debts: state.map((d) => ({ id: d.id, name: d.name, payoffMonth: d.payoffMonth, interestCents: d.interest })),
    minimumBelowInterest,
  };
}
