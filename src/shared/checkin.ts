import type { Cents } from './money';

/** A budget category's month result, as the check-in wizard reviews it. */
export interface CheckinLine {
  categoryId: number;
  name: string;
  section: string;
  kind: 'income' | 'expense';
  budgetCents: Cents;
  /** Positive. */
  actualCents: Cents;
}

export interface MonthSummary {
  incomeBudgetCents: Cents;
  incomeActualCents: Cents;
  spendBudgetCents: Cents;
  spendActualCents: Cents;
  netActualCents: Cents;
  /** Came in at least 5% under a budget of $20+. */
  wins: (CheckinLine & { underCents: Cents })[];
  /** Over budget, biggest overage first. */
  overspent: (CheckinLine & { overCents: Cents })[];
  /** Spending in categories with no budget. */
  unbudgeted: CheckinLine[];
}

export function summarizeMonth(lines: readonly CheckinLine[]): MonthSummary {
  const income = lines.filter((l) => l.kind === 'income');
  const expenses = lines.filter((l) => l.kind === 'expense');
  const total = (xs: readonly CheckinLine[], key: 'budgetCents' | 'actualCents') =>
    xs.reduce((sum, l) => sum + l[key], 0);

  const incomeActualCents = total(income, 'actualCents');
  const spendActualCents = total(expenses, 'actualCents');
  return {
    incomeBudgetCents: total(income, 'budgetCents'),
    incomeActualCents,
    spendBudgetCents: total(expenses, 'budgetCents'),
    spendActualCents,
    netActualCents: incomeActualCents - spendActualCents,
    wins: expenses
      .filter((l) => l.budgetCents >= 2000 && l.actualCents <= l.budgetCents * 0.95)
      .map((l) => ({ ...l, underCents: l.budgetCents - l.actualCents }))
      .sort((a, b) => b.underCents - a.underCents),
    overspent: expenses
      .filter((l) => l.budgetCents > 0 && l.actualCents > l.budgetCents)
      .map((l) => ({ ...l, overCents: l.actualCents - l.budgetCents }))
      .sort((a, b) => b.overCents - a.overCents),
    unbudgeted: expenses.filter((l) => l.budgetCents === 0 && l.actualCents > 0),
  };
}

/** What the couple decided for an overspent category. */
export type OverspendDecision =
  | { kind: 'keep' }
  | { kind: 'raise'; newBudgetCents?: Cents }
  | { kind: 'set'; newBudgetCents: Cents };

/** Next month's budget: same as this month unless a decision changes a category. */
export function draftNextBudget(
  lines: readonly CheckinLine[],
  decisions: Readonly<Record<number, OverspendDecision>>,
): { categoryId: number; budgetCents: Cents }[] {
  return lines.map((line) => {
    const decision = decisions[line.categoryId];
    let budgetCents = line.budgetCents;
    if (decision?.kind === 'raise') budgetCents = decision.newBudgetCents ?? line.actualCents;
    if (decision?.kind === 'set') budgetCents = decision.newBudgetCents;
    return { categoryId: line.categoryId, budgetCents: Math.max(0, budgetCents) };
  });
}
