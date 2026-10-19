/**
 * Plan › Ahead on the client: API shapes, the working plan (compare, rebase, the Save body and the confirm
 * sheet's list of changes), the readouts' wording and the month sheet. No React, so it's testable.
 */
import { addDays, addMonths, monthEnd, monthOf, monthStart, type ISODate, type MonthKey } from '../shared/dates';
import type { GoalProgress } from '../shared/goals';
import type { Cents } from '../shared/money';
import type { MonthsAhead } from '../shared/monthsAhead';
import { payDatesBetween } from '../shared/paySchedule';
import {
  currentMonthly,
  type AheadInput,
  type AheadItem,
  type AheadPlan,
  type CostAhead,
  type DebtAhead,
  type DebtKind,
  type DebtStrategy,
  type GoalPlanAhead,
  type PlanAheadResult,
} from '../shared/planAhead';
import { GROUP_ORDER, type GroupKey } from '../shared/trends';
import { money, monthShortLabel, shortDate } from './format';

/** As GET /api/debts returns them (and GET /api/ahead's `debts`). */
export interface DebtRow {
  id: number;
  name: string;
  kind: DebtKind;
  accountId: number | null;
  accountName: string | null;
  source: 'manual' | 'plaid';
  balanceCents: Cents;
  aprPercent: number;
  minPaymentCents: Cents;
  minEstimated: boolean;
  dueDay: number | null;
  extraCents: Cents;
  sort: number;
  paidInFull: boolean;
  endMonth: MonthKey | null;
  billId: number | null;
  billName: string | null;
  billConfirmed: boolean;
  categoryId: number | null;
  categoryName: string | null;
  balanceAsOf: ISODate | null;
  suggestedBillId: number | null;
  suggestedBillName: string | null;
  updatedAt: string;
}

export interface AheadGoalRow {
  id: number;
  name: string;
  targetCents: Cents;
  targetDate: ISODate | null;
  categoryId: number | null;
  categoryName: string | null;
  startingSavedCents: Cents;
  savedCents: Cents;
  monthlyCents: Cents | null;
  progress: GoalProgress;
}

/** GET /api/ahead. */
export interface AheadResponse {
  today: ISODate;
  input: AheadInput;
  saved: AheadPlan;
  surprise: { suggestedCents: Cents; savedCents: Cents | null };
  debts: DebtRow[];
  goals: AheadGoalRow[];
  items: AheadItem[];
  hasBalance: boolean;
  hasIncome: boolean;
}

/** The sliders' state: the plan, and whether the cushion is the household's own amount or the suggestion. */
export interface Working {
  plan: AheadPlan;
  ownSurprise: boolean;
}

export const STEP_CENTS = 500;
/** A slider always has some room, even when nothing is left over (P7 UI ruling). */
export const SLIDER_FLOOR_CENTS = 50_000;

export const KIND_LABEL: Record<DebtKind, string> = {
  credit_card: 'Credit card',
  car: 'Car loan',
  student: 'Student loan',
  mortgage: 'Mortgage',
  medical: 'Medical bill',
  personal: 'Personal loan',
  bnpl: 'Buy now, pay later',
  family: 'Owed to family',
  other: 'Something else',
};

export const STRATEGY_LABEL: Record<DebtStrategy, string> = {
  avalanche: 'Highest interest first',
  snowball: 'Smallest balance first',
  custom: 'My order',
};

/** Whole dollars when the amount is round, cents otherwise. */
const amount = (cents: number) => money(cents, { whole: cents % 100 === 0 });
/** Whole dollars, for estimates (left-over, interest): their cents would be false precision. */
const dollars = (cents: number) => money(cents, { whole: true });
const month = (key: MonthKey) => monthShortLabel(key);

/** 0 to the larger of 2 × the left-over and the current value, in $5 steps, never less than $500. */
export function sliderMax(leftOverCents: Cents, currentCents: Cents): Cents {
  const max = Math.max(2 * leftOverCents, currentCents, SLIDER_FLOOR_CENTS);
  return Math.ceil(max / STEP_CENTS) * STEP_CENTS;
}

/** Debts that get a slider: not paid in full, with a balance. */
export const activeDebts = (input: Pick<AheadInput, 'debts'>) => input.debts.filter((d) => !d.paidInFull && d.balanceCents > 0);

/**
 * `plan` with an entry for every debt, cost and goal in `input` and nothing else: missing ones come from
 * `fallback` (the saved plan), then the defaults (no extra, the set-aside as it is, no goal amount). The order
 * lists every debt: the plan's first, then the rest in `fallback`'s order.
 */
export function fillPlan(plan: AheadPlan, input: AheadInput, fallback?: AheadPlan): AheadPlan {
  const pick = (own: Record<number, Cents>, saved: Record<number, Cents> | undefined, id: number, otherwise: Cents) =>
    own[id] ?? saved?.[id] ?? otherwise;
  const ids = input.debts.map((d) => d.id);
  const order = [...plan.order, ...(fallback?.order ?? []), ...[...input.debts].sort((a, b) => a.sort - b.sort || a.id - b.id).map((d) => d.id)];
  return {
    debtExtra: Object.fromEntries(input.debts.map((d) => [d.id, pick(plan.debtExtra, fallback?.debtExtra, d.id, 0)])),
    costMonthly: Object.fromEntries(
      input.plannedCosts.map((c) => [c.id, pick(plan.costMonthly, fallback?.costMonthly, c.id, currentMonthly(c, input.today))]),
    ),
    goalMonthly: Object.fromEntries(input.aheadGoals.map((g) => [g.id, pick(plan.goalMonthly, fallback?.goalMonthly, g.id, 0)])),
    surpriseCents: plan.surpriseCents,
    strategy: plan.strategy,
    order: [...new Set(order)].filter((id) => ids.includes(id)),
  };
}

/** The working copy as loaded: the saved plan, filled in. */
export function startWorking(data: Pick<AheadResponse, 'input' | 'saved' | 'surprise'>): Working {
  return { plan: fillPlan(data.saved, data.input), ownSurprise: data.surprise.savedCents !== null };
}

/**
 * After a reload that isn't a Save (an item or a debt added): unsaved moves stay, new debts, costs and goals
 * start where they're saved, removed ones go. The cushion follows a new suggestion unless it's your own.
 */
export function rebase(working: Working, data: Pick<AheadResponse, 'input' | 'saved' | 'surprise'>): Working {
  const plan = fillPlan(working.plan, data.input, data.saved);
  if (!working.ownSurprise) plan.surpriseCents = data.surprise.suggestedCents;
  return { plan, ownSurprise: working.ownSurprise };
}

/** Debt ids in the order payoff uses for "My order": the plan's, active debts only. */
export const orderedDebts = (input: Pick<AheadInput, 'debts'>, plan: AheadPlan) => {
  const active = activeDebts(input);
  return plan.order.flatMap((id) => active.filter((d) => d.id === id));
};

const sameOrder = (input: AheadInput, a: AheadPlan, b: AheadPlan) =>
  orderedDebts(input, a).map((d) => d.id).join() === orderedDebts(input, b).map((d) => d.id).join();

export interface PlanChange {
  key: string;
  text: string;
}

/**
 * What Save would change, in words, for the confirm sheet (P7-R6). Only what differs from the saved plan; the
 * order only matters under "My order".
 */
export function planChanges(input: AheadInput, data: Pick<AheadResponse, 'saved' | 'surprise'>, working: Working): PlanChange[] {
  const saved = fillPlan(data.saved, input);
  const { plan } = working;
  const next = month(addMonths(monthOf(input.today), 1));
  const changes: PlanChange[] = [];
  for (const d of input.debts) {
    const was = saved.debtExtra[d.id] ?? 0;
    const now = plan.debtExtra[d.id] ?? 0;
    if (was !== now) changes.push({ key: `debt-${d.id}`, text: `${d.name}: ${amount(now)} extra a month (was ${amount(was)})` });
  }
  for (const c of input.plannedCosts) {
    const was = saved.costMonthly[c.id] ?? 0;
    const now = plan.costMonthly[c.id] ?? was;
    if (was !== now) changes.push({ key: `cost-${c.id}`, text: `${c.name} set-aside: ${amount(now)} a month from ${next} (was ${amount(was)})` });
  }
  for (const g of input.aheadGoals) {
    const was = saved.goalMonthly[g.id] ?? 0;
    const now = plan.goalMonthly[g.id] ?? 0;
    if (was !== now) changes.push({ key: `goal-${g.id}`, text: `${g.name}: ${amount(now)} a month (was ${amount(was)})` });
  }
  const savedOwn = data.surprise.savedCents !== null;
  if (working.ownSurprise !== savedOwn || plan.surpriseCents !== saved.surpriseCents) {
    changes.push({
      key: 'surprise',
      text: working.ownSurprise
        ? `Surprises: ${amount(plan.surpriseCents)} a month (was ${amount(saved.surpriseCents)}${savedOwn ? '' : ', suggested'})`
        : `Surprises: back to the suggestion, ${amount(plan.surpriseCents)} a month`,
    });
  }
  if (plan.strategy !== saved.strategy) {
    changes.push({ key: 'strategy', text: `Debt order: ${STRATEGY_LABEL[plan.strategy].toLowerCase()} (was ${STRATEGY_LABEL[saved.strategy].toLowerCase()})` });
  }
  if (plan.strategy === 'custom' && !sameOrder(input, plan, saved)) {
    changes.push({ key: 'order', text: `My order: ${orderedDebts(input, plan).map((d) => d.name).join(', ')}` });
  }
  return changes;
}

/** True when Save has something to do. */
export const isChanged = (input: AheadInput, data: Pick<AheadResponse, 'saved' | 'surprise'>, working: Working) =>
  planChanges(input, data, working).length > 0;

/** Budget lines Save also touches (goal and debt-linked lines from next month on): worth saying in the sheet. */
export function touchesBudget(input: AheadInput, data: Pick<AheadResponse, 'saved' | 'debts' | 'goals'>, working: Working): boolean {
  const saved = fillPlan(data.saved, input);
  const goal = data.goals.some((g) => g.categoryId !== null && (saved.goalMonthly[g.id] ?? 0) !== (working.plan.goalMonthly[g.id] ?? 0));
  const debt = data.debts.some((d) => d.categoryId !== null && (saved.debtExtra[d.id] ?? 0) !== (working.plan.debtExtra[d.id] ?? 0));
  return goal || debt;
}

/** POST /api/ahead/plan: only what changed (a field left out is kept); `surpriseCents: null` is the suggestion. */
export function saveBody(input: AheadInput, data: Pick<AheadResponse, 'saved' | 'surprise'>, working: Working): Partial<Omit<AheadPlan, 'surpriseCents'>> & { surpriseCents?: Cents | null } {
  const saved = fillPlan(data.saved, input);
  const { plan } = working;
  const diff = (now: Record<number, Cents>, was: Record<number, Cents>) => {
    const out = Object.fromEntries(Object.entries(now).filter(([id, cents]) => was[Number(id)] !== cents));
    return Object.keys(out).length ? out : undefined;
  };
  const body: ReturnType<typeof saveBody> = {};
  const debtExtra = diff(plan.debtExtra, saved.debtExtra);
  const costMonthly = diff(plan.costMonthly, saved.costMonthly);
  const goalMonthly = diff(plan.goalMonthly, saved.goalMonthly);
  if (debtExtra) body.debtExtra = debtExtra;
  if (costMonthly) body.costMonthly = costMonthly;
  if (goalMonthly) body.goalMonthly = goalMonthly;
  const savedOwn = data.surprise.savedCents !== null;
  if (working.ownSurprise !== savedOwn || plan.surpriseCents !== saved.surpriseCents) body.surpriseCents = working.ownSurprise ? plan.surpriseCents : null;
  if (plan.strategy !== saved.strategy) body.strategy = plan.strategy;
  if (plan.strategy === 'custom' && !sameOrder(input, plan, saved)) body.order = plan.order;
  return body;
}

// ───────────────────────── Readouts ─────────────────────────

/** "About $450 a month left over after bills, everyday spending, minimums and set-asides." */
export const headlineText = (leftOverCents: Cents) =>
  leftOverCents < 0
    ? `About ${dollars(-leftOverCents)} a month short after bills, everyday spending, minimums and set-asides.`
    : `About ${dollars(leftOverCents)} a month left over after bills, everyday spending, minimums and set-asides.`;

/** Under the allocation bar. */
export function allocationText(result: Pick<PlanAheadResult, 'allocatedCents' | 'unallocatedCents'>): { text: string; over: boolean } {
  if (result.unallocatedCents < 0) return { text: `${dollars(-result.unallocatedCents)} over what’s left`, over: true };
  if (result.allocatedCents === 0) return { text: `Nothing given a job yet`, over: false };
  return { text: `${dollars(result.allocatedCents)} given a job, ${dollars(result.unallocatedCents)} not yet`, over: false };
}

/** A debt row's readout: when it's paid off and what it costs, and with an extra, what that changes. */
export function debtReadout(d: DebtAhead): { text: string; change: string | null } {
  if (d.payoffMonth === null) return { text: 'Not paid off at this rate', change: null };
  const interest = d.noRate ? 'no interest rate yet' : `${dollars(d.interestCents)} interest`;
  const text = `Paid off ${month(d.payoffMonth)} · ${interest}`;
  if (d.extraCents <= 0) return { text, change: null };
  const base = d.minimumOnly;
  const saves = Math.max(0, base.interestCents - d.interestCents);
  const savesText = d.noRate || saves === 0 ? '' : ` · saves ${dollars(saves)}`;
  if (base.payoffMonth === null) return { text, change: `Paid off, where the minimum alone never does${savesText}` };
  const sooner = monthsBetween(d.payoffMonth, base.payoffMonth);
  if (sooner <= 0) return { text, change: savesText ? `Saves ${dollars(saves)}` : null };
  return { text, change: `${sooner} ${sooner === 1 ? 'month' : 'months'} sooner${savesText}` };
}

/** A set-aside row: its balance at the end of the months shown, or when it runs short. */
export function costReadout(c: Pick<CostAhead, 'endCents' | 'runsShortMonth'>, lastMonth: MonthKey): { text: string; short: boolean } {
  if (c.runsShortMonth !== null) return { text: `Runs short in ${month(c.runsShortMonth)}`, short: true };
  return { text: `${amount(c.endCents)} by the end of ${month(lastMonth)}`, short: false };
}

export const goalReadout = (g: Pick<GoalPlanAhead, 'reachedMonth'>, today: ISODate) =>
  g.reachedMonth === null ? 'Not reached' : g.reachedMonth <= monthOf(today) ? 'Reached' : `Reached ${month(g.reachedMonth)}`;

/** The debt-free headline, and how it compares with the saved plan. */
export function debtFreeText(
  now: Pick<PlanAheadResult, 'hasDebts' | 'debtFreeMonth' | 'totalInterestCents'>,
  saved: Pick<PlanAheadResult, 'debtFreeMonth' | 'totalInterestCents'>,
  today: ISODate,
): { title: string; interest: string | null; change: string | null } {
  if (!now.hasDebts) return { title: 'No debts to pay down', interest: null, change: null };
  const title =
    now.debtFreeMonth === null ? 'Not debt-free within 30 years at this rate' : now.debtFreeMonth <= monthOf(today) ? 'Debt-free this month' : `Debt-free by ${month(now.debtFreeMonth)}`;
  const interest = `${dollars(now.totalInterestCents)} interest from now`;
  let change: string | null = null;
  if (now.debtFreeMonth !== saved.debtFreeMonth || now.totalInterestCents !== saved.totalInterestCents) {
    const parts: string[] = [];
    if (now.debtFreeMonth !== null && saved.debtFreeMonth !== null && now.debtFreeMonth !== saved.debtFreeMonth) {
      const diff = monthsBetween(now.debtFreeMonth, saved.debtFreeMonth);
      parts.push(`${Math.abs(diff)} ${Math.abs(diff) === 1 ? 'month' : 'months'} ${diff > 0 ? 'sooner' : 'later'}`);
    } else if (now.debtFreeMonth !== saved.debtFreeMonth) {
      parts.push(saved.debtFreeMonth === null ? `paid off, where the saved plan never is` : `saved plan: ${month(saved.debtFreeMonth)}`);
    }
    const interestDiff = saved.totalInterestCents - now.totalInterestCents;
    if (interestDiff !== 0) parts.push(interestDiff > 0 ? `${dollars(interestDiff)} less interest` : `${dollars(-interestDiff)} more interest`);
    if (parts.length) change = `Against your saved plan: ${parts.join(', ')}`;
  }
  return { title, interest, change };
}

/** Months from `a` to `b` (positive when b is later). */
function monthsBetween(a: MonthKey, b: MonthKey): number {
  const [ay, am] = a.split('-').map(Number) as [number, number];
  const [by, bm] = b.split('-').map(Number) as [number, number];
  return (by - ay) * 12 + (bm - am);
}

/** "Every month until Mar 2027", "Once", "Every year". */
export function itemRepeatText(item: Pick<AheadItem, 'repeat' | 'endMonth' | 'month'>): string {
  if (item.repeat === 'once') return `${month(item.month)}`;
  const every = item.repeat === 'monthly' ? 'Every month' : 'Every year';
  return `${every} from ${month(item.month)}${item.endMonth ? ` to ${month(item.endMonth)}` : ''}`;
}

// ───────────────────────── The month sheet ─────────────────────────

export interface SheetLine {
  key: string;
  name: string;
  /** Where it came from: "Confirmed bill", "Your budget", "Usual (last 3 months)", "Like last Dec"… */
  source: string;
  date: ISODate | null;
  /** Positive: money out (or, in the Paydays section, money in). */
  amountCents: Cents;
}

export interface SheetSection {
  key: 'paydays' | 'itemsIn' | 'bills' | 'usual' | 'costs' | 'debts' | 'items' | 'surprises' | 'plan';
  title: string;
  /** Money in (paydays, items coming in) rather than out. */
  isIn: boolean;
  totalCents: Cents;
  lines: SheetLine[];
}

const GROUP_NAME = Object.fromEntries(GROUP_ORDER.map((g) => [g.key, g.name])) as Record<GroupKey, string>;
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * What's in one month of the projection, grouped, each line saying where it came from. The lines add up to the
 * month's money in and out: bills and planned-cost spending are taken out of their group's total, and what's
 * left of it is the usual spending (or, for Saving, the budget's saving lines).
 */
export function monthSheet(input: AheadInput, projection: MonthsAhead, index: number): SheetSection[] {
  const m = projection.months[index]!;
  const current = monthOf(input.today);
  const start = m.partial ? addDays(input.today, 1) : monthStart(m.month);
  const end = monthEnd(m.month);

  const paydays: SheetLine[] = [];
  for (const source of input.income) {
    const received = new Set(source.receivedPayDates ?? []);
    for (const date of payDatesBetween(source.schedule, start, end)) {
      if (!received.has(date)) paydays.push({ key: `pay-${source.name}-${date}`, name: source.name, source: 'Your paydays', date, amountCents: source.netPayCents });
    }
  }
  paydays.sort((a, b) => (a.date! < b.date! ? -1 : 1));

  // The projection's own filter: overdue bills come out in the rest of this month.
  const monthBills = input.bills.filter((b) => b.date <= end && (m.partial || b.date >= start));
  const bills: SheetLine[] = monthBills.map((b, i) => ({
    key: `bill-${i}-${b.date}`,
    name: b.name,
    source: b.cadence === null ? 'Your budget' : 'Confirmed bill',
    date: b.date,
    amountCents: b.amountCents,
  }));
  const taken: Record<GroupKey, Cents> = { bills: 0, everyday: 0, habits: 0, fun: 0, saving: 0 };
  for (const b of monthBills) taken[b.group] += b.amountCents;
  if (m.otherBillsCents) {
    bills.push({ key: 'other-bills', name: 'Other bills', source: 'Usual (last 3 months)', date: null, amountCents: m.otherBillsCents });
    taken.bills += m.otherBillsCents;
  }

  const hasYear = input.historyStart !== null && input.historyStart <= addMonths(current, -12);
  const likeLast = hasYear && addMonths(m.month, -12) < current;
  const costs: SheetLine[] = [];
  input.plannedCosts.forEach((cost, k) => {
    const ownBills = monthBills.filter((b) => b.plannedCostId === cost.id).reduce((sum, b) => sum + b.amountCents, 0);
    const cents = (projection.plannedCosts[k]?.spends[index] ?? 0) - ownBills;
    taken[cost.group] += cents;
    if (cents !== 0) {
      costs.push({
        key: `cost-${cost.id}`,
        name: cost.name,
        source: likeLast ? `Like last ${SHORT_MONTHS[Number(m.month.slice(5)) - 1]}` : 'Your set-aside',
        date: null,
        amountCents: cents,
      });
    }
  });

  const usual: SheetLine[] = [];
  for (const g of GROUP_ORDER) {
    const rest = m.byGroup[g.key] - taken[g.key];
    if (rest !== 0) {
      usual.push({ key: `usual-${g.key}`, name: GROUP_NAME[g.key], source: g.key === 'saving' ? 'Your budget' : 'Usual (last 3 months)', date: null, amountCents: rest });
    }
  }

  const debts: SheetLine[] = [];
  const items: SheetLine[] = [];
  const itemsIn: SheetLine[] = [];
  const surprises: SheetLine[] = [];
  const plan: SheetLine[] = [];
  for (const line of m.ahead.lines) {
    const key = `${line.kind}-${line.id ?? 0}`;
    if (line.kind === 'debt') {
      const debt = input.debts.find((d) => d.id === line.id);
      const source = debt && line.amountCents > Math.min(debt.minPaymentCents, debt.balanceCents) ? 'Minimum + extra' : 'Minimum';
      debts.push({ key, name: line.name, source, date: null, amountCents: line.amountCents });
    } else if (line.kind === 'item') {
      (line.amountCents < 0 ? itemsIn : items).push({ key, name: line.name, source: 'You added', date: null, amountCents: Math.abs(line.amountCents) });
    } else if (line.kind === 'surprise') {
      surprises.push({ key, name: 'Surprises', source: 'Cushion for the unexpected', date: null, amountCents: line.amountCents });
    } else {
      plan.push({ key, name: line.kind === 'setAside' ? `${line.name} set-aside change` : line.name, source: 'Your plan', date: null, amountCents: line.amountCents });
    }
  }
  if (m.addedCents) plan.push({ key: 'added', name: 'Added costs', source: 'What if', date: null, amountCents: m.addedCents });

  const section = (key: SheetSection['key'], title: string, lines: SheetLine[], isIn = false): SheetSection => ({
    key,
    title,
    isIn,
    totalCents: lines.reduce((sum, l) => sum + l.amountCents, 0),
    lines,
  });
  return [
    section('paydays', 'Paydays', paydays, true),
    section('itemsIn', 'Coming in', itemsIn, true),
    section('bills', 'Bills', bills),
    section('usual', 'Usual spending', usual),
    section('costs', 'Planned costs', costs),
    section('debts', 'Debt payments', debts),
    section('items', 'Known items', items),
    section('surprises', 'Surprises', surprises),
    section('plan', 'Set-asides and goals', plan),
  ].filter((s) => s.lines.length > 0);
}

/** A sheet line's date, when it has one. */
export const lineDate = (line: SheetLine) => (line.date ? shortDate(line.date) : null);

// ───────────────────────── Debts ─────────────────────────

/**
 * A confirmed bill to suggest linking a debt to (P7-R23, mirrored for a debt not saved yet): its name contains
 * the debt's or the reverse, or its merchant (3+ letters) appears in the debt's name.
 */
export function suggestBill<B extends { id: number; name: string; merchant: string }>(name: string, bills: readonly B[]): B | null {
  const n = name.trim().toLowerCase();
  if (n.length < 3) return null;
  return (
    bills.find((b) => {
      const bill = b.name.toLowerCase();
      const merchant = b.merchant.toLowerCase();
      return bill.includes(n) || n.includes(bill) || (merchant.length >= 3 && n.includes(merchant));
    }) ?? null
  );
}

/** A debt's flags: "Add the interest rate" with a balance and no rate; "estimated" minimum. */
export function debtFlags(d: Pick<DebtRow, 'aprPercent' | 'balanceCents' | 'minEstimated' | 'endMonth' | 'paidInFull'>): { noRate: boolean; estimated: boolean } {
  // A card paid in full each month pays no interest and no minimum that matters.
  if (d.paidInFull) return { noRate: false, estimated: false };
  return { noRate: d.aprPercent === 0 && d.balanceCents > 0 && d.endMonth === null, estimated: d.minEstimated };
}

/** Months to pick from: this one and the next `count - 1`. */
export function monthChoices(today: ISODate, count: number, from = 0): { value: MonthKey; label: string }[] {
  return Array.from({ length: count }, (_, i) => {
    const key = addMonths(monthOf(today), from + i);
    return { value: key, label: month(key) };
  });
}
