import { addMonths, clampDay, monthOf, parseMonth, type ISODate, type MonthKey } from './dates';
import { payoffOrder, planPayoff, type DebtInput, type PayoffPlan } from './debt';
import type { Cents } from './money';
import {
  projectMonths,
  type AheadLine,
  type AheadMonthLines,
  type Horizon,
  type MonthsAhead,
  type MonthsAheadInput,
  type PlannedCostInput,
} from './monthsAhead';
import { monthlyFor, roundUpToFive } from './plannedCosts';
import type { ProjectionEvent } from './projection';
import type { GroupKey } from './trends';

/**
 * Plan › Ahead: where the extra money goes. Months ahead (Project 6b) plus debt payments, known items, a
 * surprises cushion, set-aside changes and goal saving, and the payoff of every debt. Pure, so the client
 * re-runs it on every slider move.
 */

export const DEBT_KINDS = ['credit_card', 'car', 'student', 'mortgage', 'medical', 'personal', 'bnpl', 'family', 'other'] as const;
export type DebtKind = (typeof DEBT_KINDS)[number];
export const DEBT_STRATEGIES = ['avalanche', 'snowball', 'custom'] as const;
export type DebtStrategy = (typeof DEBT_STRATEGIES)[number];

/** A debt with no due day is paid on the 15th. */
export const DEFAULT_DUE_DAY = 15;
/** Payoff runs at most 30 years ahead. */
export const PAYOFF_MONTHS = 360;
const SURPRISE_MONTHS = 6;
const SURPRISE_ROUND_CENTS = 2_500;
const STEP_CENTS = 500;

export interface AheadDebt {
  id: number;
  name: string;
  kind: DebtKind;
  balanceCents: Cents;
  aprPercent: number;
  minPaymentCents: Cents;
  dueDay: number | null;
  /** A fixed-term loan's last payment month. */
  endMonth: MonthKey | null;
  /** Left out of payoff, the sliders and the debt total (P7-R7). */
  paidInFull: boolean;
  /** "My order". */
  sort: number;
  /**
   * Its payment is a linked bill or budget line: this month that bill or line counts it, so it isn't paid
   * again here. From next month the gatherer takes those out of `bills`, and the plan counts min + extra (P7-R8).
   */
  covered: boolean;
}

export interface AheadGoal {
  id: number;
  name: string;
  remainingCents: Cents;
  targetDate: ISODate | null;
}

export type AheadRepeat = 'once' | 'monthly' | 'yearly';

export interface AheadItem {
  id: number;
  name: string;
  /** Positive = money in, negative = money out. */
  amountCents: Cents;
  month: MonthKey;
  repeat: AheadRepeat;
  endMonth: MonthKey | null;
}

export interface AheadInput extends MonthsAheadInput {
  debts: readonly AheadDebt[];
  aheadGoals: readonly AheadGoal[];
  items: readonly AheadItem[];
  /** The saved cushion, or the suggestion when none is saved. */
  surpriseCents: Cents;
  surpriseSuggestedCents: Cents;
  strategy: DebtStrategy;
}

/** What the sliders set. Keys are ids. */
export interface AheadPlan {
  /** On top of each debt's minimum. */
  debtExtra: Record<number, Cents>;
  /** Each planned cost's monthly set-aside from next month (missing: as it is). */
  costMonthly: Record<number, Cents>;
  goalMonthly: Record<number, Cents>;
  surpriseCents: Cents;
  strategy: DebtStrategy;
  /** Debt ids for 'custom'. */
  order: number[];
}

export interface DebtAhead {
  id: number;
  name: string;
  extraCents: Cents;
  /** Null: not paid off within 30 years at this rate. */
  payoffMonth: MonthKey | null;
  interestCents: Cents;
  /** Balance at the end of each month shown. */
  balances: Cents[];
  /** At the minimum alone (with paid-off debts' money still rolling on): for "4 months sooner · saves $310". */
  minimumOnly: { payoffMonth: MonthKey | null; interestCents: Cents };
  /** APR 0 with a balance: "no interest rate yet". */
  noRate: boolean;
}

export interface CostAhead {
  id: number;
  name: string;
  currentMonthlyCents: Cents;
  monthlyCents: Cents;
  /** Balance at the end of each month shown. */
  balances: Cents[];
  endCents: Cents;
  /** The first month it ends below 0. */
  runsShortMonth: MonthKey | null;
}

export interface GoalPlanAhead {
  id: number;
  name: string;
  monthlyCents: Cents;
  /** Null when nothing goes in. */
  reachedMonth: MonthKey | null;
}

export interface PlanAheadResult {
  projection: MonthsAhead;
  /** Average whole month's left-over after bills, everyday spending, minimums, set-asides, items and surprises, before any extra. */
  leftOverCents: Cents;
  /** Debt extras + set-aside changes + goal amounts. */
  allocatedCents: Cents;
  /** Left-over less allocated: below 0 is "over what's left". */
  unallocatedCents: Cents;
  debts: DebtAhead[];
  /** Total debt at the end of each month shown. */
  debtTotals: Cents[];
  /** Null when not within 30 years, or when there are no debts (see hasDebts). */
  debtFreeMonth: MonthKey | null;
  hasDebts: boolean;
  totalInterestCents: Cents;
  costs: CostAhead[];
  goals: GoalPlanAhead[];
}

const monthIndex = (month: MonthKey) => {
  const { y, m } = parseMonth(month);
  return y * 12 + m;
};
const floorStep = (cents: Cents) => (cents <= 0 ? 0 : Math.floor(cents / STEP_CENTS) * STEP_CENTS);

/** A cost's set-aside from next month on, as saved. */
export function currentMonthly(cost: Pick<PlannedCostInput, 'amounts' | 'startMonth'>, today: ISODate): Cents {
  const next = addMonths(monthOf(today), 1);
  return monthlyFor(cost.amounts, cost.startMonth > next ? cost.startMonth : next);
}

function itemInMonth(item: AheadItem, month: MonthKey): boolean {
  if (month < item.month || (item.endMonth !== null && month > item.endMonth)) return false;
  if (item.repeat === 'once') return month === item.month;
  return item.repeat === 'monthly' || parseMonth(month).m === parseMonth(item.month).m;
}

const dueThisMonth = (debt: Pick<AheadDebt, 'dueDay'>, today: ISODate) => clampDay(monthOf(today), debt.dueDay ?? DEFAULT_DUE_DAY) > today;

interface DebtRun {
  active: AheadDebt[];
  /** Paid in the rest of this month (minimums due after today). */
  now: Cents[];
  payoff: PayoffPlan;
}

/** This month: minimums still due, no interest yet. Then whole months through the 30-year tail. */
function runDebts(input: AheadInput, plan: AheadPlan, horizon: Horizon, withExtra: boolean): DebtRun {
  const current = monthOf(input.today);
  const active = input.debts.filter((d) => !d.paidInFull && d.balanceCents > 0);
  const now = active.map((d) => (dueThisMonth(d, input.today) ? Math.min(d.minPaymentCents, d.balanceCents) : 0));
  const debts: DebtInput[] = active.map((d, i) => ({
    id: d.id,
    name: d.name,
    balanceCents: d.balanceCents - now[i]!,
    aprPercent: d.aprPercent,
    minPaymentCents: d.minPaymentCents,
    extraCents: withExtra ? Math.max(0, plan.debtExtra[d.id] ?? 0) : 0,
    termMonths: d.endMonth === null ? null : Math.max(1, monthIndex(d.endMonth) - monthIndex(current)),
  }));
  return { active, now, payoff: planPayoff(debts, plan.strategy, { order: plan.order, maxMonths: PAYOFF_MONTHS, seriesMonths: horizon }) };
}

function linesByMonth(input: AheadInput, plan: AheadPlan, horizon: Horizon, debtRun: DebtRun, planned: boolean): Record<MonthKey, AheadMonthLines> {
  const current = monthOf(input.today);
  const byId = new Map(debtRun.payoff.debts.map((d) => [d.id, d]));
  const out: Record<MonthKey, AheadMonthLines> = {};
  const goalLeft = input.aheadGoals.map((g) => Math.max(0, g.remainingCents));
  for (let i = 0; i <= horizon; i++) {
    const month = addMonths(current, i);
    const lines: AheadLine[] = [];
    debtRun.active.forEach((d, k) => {
      // A covered debt's payment this month is its bill or line.
      const cents = i === 0 ? (d.covered ? 0 : debtRun.now[k]!) : (byId.get(d.id)?.payments[i - 1] ?? 0);
      if (cents > 0) lines.push({ kind: 'debt', id: d.id, name: d.name, amountCents: cents });
    });
    for (const item of input.items) {
      if (itemInMonth(item, month)) lines.push({ kind: 'item', id: item.id, name: item.name, amountCents: -item.amountCents });
    }
    if (i > 0) {
      if (plan.surpriseCents > 0) lines.push({ kind: 'surprise', id: null, name: 'Surprises', amountCents: plan.surpriseCents });
      if (planned) {
        for (const cost of input.plannedCosts) {
          const change = (plan.costMonthly[cost.id] ?? currentMonthly(cost, input.today)) - currentMonthly(cost, input.today);
          if (change !== 0 && cost.startMonth <= month) lines.push({ kind: 'setAside', id: cost.id, name: cost.name, amountCents: change });
        }
        input.aheadGoals.forEach((g, k) => {
          const cents = Math.min(Math.max(0, plan.goalMonthly[g.id] ?? 0), goalLeft[k]!);
          goalLeft[k] = goalLeft[k]! - cents;
          if (cents > 0) lines.push({ kind: 'goal', id: g.id, name: g.name, amountCents: cents });
        });
      }
    }
    const inCents = lines.reduce((sum, l) => sum + (l.kind === 'item' && l.amountCents < 0 ? -l.amountCents : 0), 0);
    const outCents = lines.reduce((sum, l) => sum + (l.kind === 'item' && l.amountCents < 0 ? 0 : l.amountCents), 0);
    if (lines.length) out[month] = { inCents, outCents, lines };
  }
  return out;
}

/** Just the plan's lines by month, for Months ahead to show the saved plan (MonthsAheadInput.ahead). */
export function aheadLines(input: AheadInput, plan: AheadPlan, horizon: Horizon = 12): Record<MonthKey, AheadMonthLines> {
  return linesByMonth(input, plan, horizon, runDebts(input, plan, horizon, true), true);
}

/** The plan's months: Project 6b's projection with the plan's lines, plus payoff, set-asides and goals. */
export function planAhead(input: AheadInput, plan: AheadPlan, horizon: Horizon = 12): PlanAheadResult {
  const current = monthOf(input.today);
  const withPlan = runDebts(input, plan, horizon, true);
  const minimumOnly = runDebts(input, plan, horizon, false);
  const ahead = linesByMonth(input, plan, horizon, withPlan, true);
  const base = linesByMonth(input, plan, horizon, minimumOnly, false);
  const projection = projectMonths({ ...input, ahead }, horizon);

  // Left over before any extra: with minimums only, and current set-asides in place of the costs' lumpy spending.
  let leftOverTotal = 0;
  for (let i = 1; i <= horizon; i++) {
    const m = projection.months[i]!;
    const own = ahead[m.month] ?? { inCents: 0, outCents: 0 };
    const minimums = base[m.month] ?? { inCents: 0, outCents: 0 };
    let costs = 0;
    input.plannedCosts.forEach((cost, k) => {
      costs += projection.plannedCosts[k]!.spends[i]! - (cost.startMonth <= m.month ? currentMonthly(cost, input.today) : 0);
    });
    leftOverTotal += m.leftOverCents + own.outCents - own.inCents - minimums.outCents + minimums.inCents + costs;
  }
  const leftOverCents = Math.round(leftOverTotal / horizon);

  const minimumById = new Map(minimumOnly.payoff.debts.map((d) => [d.id, d]));
  const at = (k: number | null) => (k === null ? null : addMonths(current, k));
  const debts: DebtAhead[] = withPlan.active.map((d, k) => {
    const run = withPlan.payoff.debts.find((p) => p.id === d.id);
    const min = minimumById.get(d.id);
    const series = (p: typeof run) => [d.balanceCents - withPlan.now[k]!, ...(p?.balances ?? Array<Cents>(horizon).fill(0))];
    return {
      id: d.id,
      name: d.name,
      extraCents: Math.max(0, plan.debtExtra[d.id] ?? 0),
      // Cleared by this month's payment: paid off now.
      payoffMonth: run ? at(run.payoffMonth) : current,
      interestCents: run?.interestCents ?? 0,
      balances: series(run),
      minimumOnly: { payoffMonth: min ? at(min.payoffMonth) : current, interestCents: min?.interestCents ?? 0 },
      noRate: d.aprPercent === 0 && d.endMonth === null,
    };
  });
  const debtTotals = Array.from({ length: horizon + 1 }, (_, i) => debts.reduce((sum, d) => sum + d.balances[i]!, 0));

  const costs: CostAhead[] = input.plannedCosts.map((cost, k) => {
    const now = currentMonthly(cost, input.today);
    const monthlyCents = plan.costMonthly[cost.id] ?? now;
    let started = 0;
    const balances = projection.plannedCosts[k]!.balances.map((b, i) => {
      if (i > 0 && cost.startMonth <= addMonths(current, i)) started++;
      return b + (monthlyCents - now) * started;
    });
    const short = balances.findIndex((b) => b < 0);
    return {
      id: cost.id,
      name: cost.name,
      currentMonthlyCents: now,
      monthlyCents,
      balances,
      endCents: balances.at(-1) ?? cost.balanceNowCents,
      runsShortMonth: short < 0 ? null : addMonths(current, short),
    };
  });

  const goals: GoalPlanAhead[] = input.aheadGoals.map((g) => {
    const monthlyCents = Math.max(0, plan.goalMonthly[g.id] ?? 0);
    return {
      id: g.id,
      name: g.name,
      monthlyCents,
      reachedMonth: g.remainingCents <= 0 ? current : monthlyCents > 0 ? addMonths(current, Math.ceil(g.remainingCents / monthlyCents)) : null,
    };
  });

  const allocatedCents =
    debts.reduce((sum, d) => sum + d.extraCents, 0) +
    costs.reduce((sum, c) => sum + c.monthlyCents - c.currentMonthlyCents, 0) +
    goals.reduce((sum, g, k) => sum + (input.aheadGoals[k]!.remainingCents > 0 ? g.monthlyCents : 0), 0);

  return {
    projection,
    leftOverCents,
    allocatedCents,
    unallocatedCents: leftOverCents - allocatedCents,
    debts,
    debtTotals,
    debtFreeMonth: debts.length === 0 ? null : withPlan.payoff.months === null ? null : at(withPlan.payoff.months),
    hasDebts: debts.length > 0,
    totalInterestCents: withPlan.payoff.totalInterestCents,
    costs,
    goals,
  };
}

/** The plan as the household has it now: no extras, set-asides as they are, the saved cushion and order. */
export function emptyPlan(input: AheadInput): AheadPlan {
  return {
    debtExtra: Object.fromEntries(input.debts.map((d) => [d.id, 0])),
    costMonthly: Object.fromEntries(input.plannedCosts.map((c) => [c.id, currentMonthly(c, input.today)])),
    goalMonthly: Object.fromEntries(input.aheadGoals.map((g) => [g.id, 0])),
    surpriseCents: input.surpriseCents,
    strategy: input.strategy,
    order: [...input.debts].sort((a, b) => a.sort - b.sort || a.id - b.id).map((d) => d.id),
  };
}

/**
 * Fill automatically (P7-R3): the left-over goes, in $5 steps, to (1) each set-aside, raised to what keeps it
 * from running short within the horizon; (2) each goal with a target date, what reaches it on time; (3) the
 * rest to debts in the chosen order (by default highest APR, ties: smallest balance), each up to its balance; (4) with no debts, the rest to
 * goals evenly. A step that can't be paid in full gets what's left, and later steps nothing.
 */
export function autoFill(input: AheadInput, horizon: Horizon = 12, order?: readonly number[]): AheadPlan {
  const current = monthOf(input.today);
  const plan = emptyPlan(input);
  if (order) plan.order = [...order];
  const start = planAhead(input, plan, horizon);
  let left = start.leftOverCents;
  const give = (want: Cents) => {
    const cents = Math.min(roundUpToFive(want), floorStep(left));
    left -= cents;
    return cents;
  };

  start.costs.forEach((cost, k) => {
    // Short by −b at month i, after n more set-asides (whole months from its start): each needs −b / n more.
    const startMonth = input.plannedCosts[k]!.startMonth;
    let need = 0;
    let made = 0;
    cost.balances.forEach((b, i) => {
      if (i > 0 && startMonth <= addMonths(current, i)) made++;
      if (made > 0 && b < 0) need = Math.max(need, -b / made);
    });
    plan.costMonthly[cost.id] = cost.currentMonthlyCents + give(need);
  });

  for (const g of input.aheadGoals) {
    if (g.targetDate === null || g.remainingCents <= 0) continue;
    const months = Math.max(1, monthIndex(monthOf(g.targetDate)) - monthIndex(current));
    plan.goalMonthly[g.id] = give(g.remainingCents / months);
  }

  // The debt order the household chose (highest interest first unless changed).
  const open = input.debts.filter((d) => !d.paidInFull && d.balanceCents > 0).map((d) => ({ ...d, balance: d.balanceCents }));
  const debts = payoffOrder(open, input.strategy, plan.order);
  for (const d of debts) plan.debtExtra[d.id] = give(Math.min(left, d.balanceCents));

  if (!debts.length) {
    const goals = input.aheadGoals.filter((g) => g.remainingCents > 0);
    const each = floorStep(left / goals.length);
    for (const g of goals) plan.goalMonthly[g.id] = (plan.goalMonthly[g.id] ?? 0) + give(each);
  }
  return plan;
}

export interface SurpriseCategory {
  id: number;
  parentId: number | null;
  group: GroupKey;
  /** Money out by month, aligned with `months` (a parent's includes its sub-categories'). */
  byMonth: readonly Cents[];
}

/** The groups whose usual (or other bills) the forecast already counts; surprises are their overshoot. */
const SURPRISE_GROUPS: ReadonlySet<GroupKey> = new Set(['everyday', 'habits', 'fun', 'bills']);
const TRAILING_MONTHS = 3;

/**
 * The suggested surprises cushion (P7-R2): how far spending ran over what "usual" would have said. For each of
 * the last 6 full months and each top-level Everyday, Habits, Fun or Bills category, the month's spending less
 * the average of the 3 full months before it, floored at 0 (so a quiet month elsewhere doesn't cancel it);
 * summed, averaged over the months, rounded to $25. Planned-cost and debt-linked categories (`excluded`, a
 * sub-category taken out of its parent) are counted elsewhere. A month whose trailing window starts before the
 * household's history doesn't count; with under 4 full months of history the suggestion is $0.
 */
export function suggestSurprise(
  trends: { months: readonly MonthKey[]; categories: readonly SurpriseCategory[] },
  today: ISODate,
  excluded: ReadonlySet<number>,
  historyStart: MonthKey | null,
): Cents {
  if (historyStart === null) return 0;
  const current = monthOf(today);
  const index = new Map(trends.months.map((m, i) => [m, i]));
  const series = trends.categories
    .filter((c) => c.parentId === null && SURPRISE_GROUPS.has(c.group) && !excluded.has(c.id))
    .map((c) => {
      const out = [...c.byMonth];
      for (const child of trends.categories) {
        if (child.parentId !== c.id || !excluded.has(child.id)) continue;
        child.byMonth.forEach((v, i) => (out[i] = (out[i] ?? 0) - v));
      }
      return out;
    });

  let total = 0;
  let counted = 0;
  for (let k = SURPRISE_MONTHS; k >= 1; k--) {
    const month = addMonths(current, -k);
    const i = index.get(month);
    if (i === undefined || i < TRAILING_MONTHS || addMonths(month, -TRAILING_MONTHS) < historyStart) continue;
    counted++;
    for (const s of series) {
      let usual = 0;
      for (let t = i - TRAILING_MONTHS; t < i; t++) usual += s[t] ?? 0;
      total += Math.max(0, (s[i] ?? 0) - usual / TRAILING_MONTHS);
    }
  }
  return counted ? Math.round(total / counted / SURPRISE_ROUND_CENTS) * SURPRISE_ROUND_CENTS : 0;
}

/**
 * "Paid in full each month" (P7-R7), with calendar months for statement cycles: in each of the last 3 full
 * months a payment came in and it was at least the charges of the month before (to the dollar), and the balance
 * is no more than the last 2 full months' charges and this month's so far (to the dollar): a statement not yet
 * paid, never a carried balance. When unsure it says no: a hidden debt is the worse mistake.
 */
export function cardPaidInFull(
  byMonth: Readonly<Record<MonthKey, { paidCents: Cents; chargedCents: Cents }>>,
  today: ISODate,
  balanceCents: Cents,
): boolean {
  const current = monthOf(today);
  const charged = (n: number) => byMonth[addMonths(current, -n)]?.chargedCents ?? 0;
  for (let i = 1; i <= 3; i++) {
    const paid = byMonth[addMonths(current, -i)]?.paidCents ?? 0;
    if (paid <= 0 || paid + 100 < charged(i + 1)) return false;
  }
  return Math.max(0, balanceCents) <= charged(0) + charged(1) + charged(2) + 100;
}

/**
 * The saved plan as Until payday's events, today to `until`: each debt's payment on its due day (this month:
 * the minimum, unless its bill or line already counts it; later months: minimum + extra, those bills and lines
 * having been taken out), and each goal's monthly amount on the 1st of each later month.
 */
export function aheadEvents(
  saved: { debts: readonly AheadDebt[]; goals: readonly { id: number; name: string; monthlyCents: Cents }[]; debtExtra: Record<number, Cents> },
  today: ISODate,
  until: ISODate,
): ProjectionEvent[] {
  const current = monthOf(today);
  const events: ProjectionEvent[] = [];
  for (let month = current; month <= monthOf(until); month = addMonths(month, 1)) {
    const later = month > current;
    for (const d of saved.debts) {
      if (d.paidInFull || d.balanceCents <= 0 || (!later && d.covered)) continue;
      const date = clampDay(month, d.dueDay ?? DEFAULT_DUE_DAY);
      if (date <= today || date > until) continue;
      const cents = Math.min(d.balanceCents, d.minPaymentCents + (later ? Math.max(0, saved.debtExtra[d.id] ?? 0) : 0));
      if (cents > 0) events.push({ id: `debt-${d.id}-${date}`, date, name: d.name, amountCents: cents, kind: 'bill' });
    }
    if (!later) continue;
    for (const g of saved.goals) {
      const date = clampDay(month, 1);
      if (g.monthlyCents > 0 && date <= until) events.push({ id: `goal-${g.id}-${date}`, date, name: g.name, amountCents: g.monthlyCents, kind: 'budget' });
    }
  }
  return events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
