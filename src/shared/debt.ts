import type { Cents } from './money';

export interface DebtInput {
  id: string | number;
  name: string;
  balanceCents: Cents;
  /** Annual percentage rate, e.g. 24.99. */
  aprPercent: number;
  minPaymentCents: Cents;
  /** Its own extra each month on top of the minimum; once it's paid off, this rolls on with the rest. */
  extraCents?: Cents;
  /** A fixed-term loan: payments left. Each payment is at least what clears it by the last one. */
  termMonths?: number | null;
  /** A card paid in full each month: left out of payoff. */
  paidInFull?: boolean;
}

/** 'custom': the order given (debts left out of it follow by highest rate). */
export type PayoffStrategy = 'snowball' | 'avalanche' | 'custom';

export interface PayoffOptions {
  /** Extra aimed at the first debt in order (not tied to one debt). */
  extraCents?: Cents;
  maxMonths?: number;
  /** For 'custom': debt ids, first to be paid off first. */
  order?: readonly (string | number)[];
  /** Keep each debt's balance and payment for this many months (from month 1). */
  seriesMonths?: number;
}

export interface DebtPayoff {
  id: string | number;
  name: string;
  /** Month number (1 = next payment) when the balance hits zero; null if not within the horizon. */
  payoffMonth: number | null;
  interestCents: Cents;
  /** Balance at the end of months 1…seriesMonths. */
  balances: Cents[];
  /** Paid in months 1…seriesMonths. */
  payments: Cents[];
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

/** A minimum when the bank gives none: the larger of $25 and 1% of the balance plus a month's interest, at most the balance. */
export function estimatedMinimum(balanceCents: Cents, aprPercent: number): Cents {
  if (balanceCents <= 0) return 0;
  return Math.min(balanceCents, Math.max(2_500, Math.round(balanceCents * 0.01) + monthlyInterest(balanceCents, aprPercent)));
}

type Ordered = { id: string | number; balance: number; aprPercent: number };

function payoffOrder<T extends Ordered>(state: readonly T[], strategy: PayoffStrategy, custom: readonly (string | number)[] = []): T[] {
  const byRate = (a: T, b: T) => b.aprPercent - a.aprPercent || a.balance - b.balance;
  if (strategy === 'snowball') return [...state].sort((a, b) => a.balance - b.balance || b.aprPercent - a.aprPercent);
  if (strategy === 'avalanche') return [...state].sort(byRate);
  const rank = new Map(custom.map((id, i) => [id, i]));
  return [...state].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || byRate(a, b));
}

/**
 * Month-by-month payoff simulation. Each month: interest accrues, every debt gets its minimum (a fixed-term loan
 * at least what clears it on time) and its own extra, and the rest of the money (the shared extra, plus whatever
 * paid-off debts no longer take) goes to the target: smallest balance first (snowball), highest APR first
 * (avalanche) or the order given (custom).
 */
export function planPayoff(
  debts: readonly DebtInput[],
  strategy: PayoffStrategy,
  extra: Cents | PayoffOptions = 0,
  maxMonths = 600,
): PayoffPlan {
  const opts: PayoffOptions = typeof extra === 'number' ? { extraCents: extra, maxMonths } : extra;
  const limit = opts.maxMonths ?? maxMonths;
  const seriesMonths = Math.min(opts.seriesMonths ?? 0, limit);
  const sharedExtra = Math.max(0, opts.extraCents ?? 0);
  const state = debts
    .filter((d) => d.balanceCents > 0 && !d.paidInFull)
    .map((d) => ({
      id: d.id,
      name: d.name,
      aprPercent: d.aprPercent,
      min: d.minPaymentCents,
      own: Math.max(0, d.extraCents ?? 0),
      term: d.termMonths ?? null,
      balance: d.balanceCents,
      interest: 0,
      payoffMonth: null as number | null,
      balances: [] as Cents[],
      payments: [] as Cents[],
    }));

  const order = payoffOrder(state, strategy, opts.order);
  const minimumBelowInterest = state.filter((d) => d.min <= monthlyInterest(d.balance, d.aprPercent)).map((d) => d.id);

  // What each debt takes a month: its minimum (a fixed-term loan: its actual payment) plus its own extra. Once
  // it's paid off, that money rolls on to the next in order.
  const committed = state.map((d) => d.min + d.own);
  let totalPaid = 0;
  let months: number | null = state.length === 0 ? 0 : null;
  const paid = new Array<number>(state.length).fill(0);
  const due = new Array<number>(state.length).fill(0);

  for (let month = 1; month <= limit && months === null; month++) {
    for (let i = 0; i < state.length; i++) {
      const d = state[i]!;
      paid[i] = 0;
      due[i] = 0;
      if (d.balance <= 0) continue;
      const interest = monthlyInterest(d.balance, d.aprPercent);
      d.balance += interest;
      d.interest += interest;
      // A term loan's payment clears what's left over the payments left.
      due[i] = d.term === null ? d.min : Math.max(d.min, Math.ceil(d.balance / Math.max(1, d.term - month + 1)));
      // Its money this month (a paid-off debt keeps its last, to roll on).
      committed[i] = due[i]! + d.own;
    }
    let pool = committed.reduce((total, c) => total + c, 0) + sharedExtra;
    for (let i = 0; i < state.length; i++) {
      const d = state[i]!;
      if (d.balance <= 0) continue;
      const pay = Math.min(due[i]!, d.balance);
      d.balance -= pay;
      pool -= pay;
      paid[i] = pay;
    }
    for (let i = 0; i < state.length; i++) {
      const d = state[i]!;
      if (d.balance <= 0 || pool <= 0) continue;
      const pay = Math.min(d.own, d.balance, pool);
      d.balance -= pay;
      pool -= pay;
      paid[i] = paid[i]! + pay;
    }
    for (const d of order) {
      if (pool <= 0) break;
      if (d.balance <= 0) continue;
      const pay = Math.min(pool, d.balance);
      d.balance -= pay;
      pool -= pay;
      paid[state.indexOf(d)] += pay;
    }

    let done = true;
    for (let i = 0; i < state.length; i++) {
      const d = state[i]!;
      totalPaid += paid[i]!;
      if (month <= seriesMonths) {
        d.balances.push(d.balance);
        d.payments.push(paid[i]!);
      }
      if (d.balance <= 0 && d.payoffMonth === null) d.payoffMonth = month;
      if (d.balance > 0) done = false;
    }
    if (done) months = month;
  }
  // Paid off early: the rest of the series is zeros.
  for (const d of state) {
    while (d.balances.length < seriesMonths) {
      d.balances.push(Math.max(0, d.balance));
      d.payments.push(0);
    }
  }

  return {
    strategy,
    extraCents: sharedExtra,
    months,
    totalInterestCents: state.reduce((total, d) => total + d.interest, 0),
    totalPaidCents: totalPaid,
    order: order.map((d) => d.id),
    debts: state.map((d) => ({ id: d.id, name: d.name, payoffMonth: d.payoffMonth, interestCents: d.interest, balances: d.balances, payments: d.payments })),
    minimumBelowInterest,
  };
}
