import { addDays, addMonths, diffDays, monthEnd, monthLength, monthOf, monthStart, parseMonth, type ISODate, type MonthKey } from './dates';
import type { Cents } from './money';
import { monthlyFor, roundUpToFive, type AmountRow } from './plannedCosts';
import { payDatesBetween, REGULAR_PAYS_PER_MONTH } from './paySchedule';
import { usualLessBills, type PaydaySource } from './projection';
import type { Cadence } from './recurring';
import type { GroupKey } from './trends';

/**
 * "Months ahead": the rest of this month and the next 3, 6 or 12, month by month: money in, money out by
 * group, what's left over and the cash at each month's end. Pure, so the client can re-run it for the
 * 3/6/12 switch and for a what-if.
 */

export type Horizon = 3 | 6 | 12;
export const HORIZONS: readonly Horizon[] = [3, 6, 12];

/** Bills and planned-cost spends from this much up are "big items" (when they don't come every month). */
export const BIG_ITEM_CENTS = 10_000;

export interface MonthBill {
  name: string;
  date: ISODate;
  /** Positive = money out. */
  amountCents: Cents;
  /** A recurring bill's cadence, or null for a due-day budget line (monthly). */
  cadence: Cadence | null;
  /** The planned cost whose categories it's in: that cost's expected spending leaves it out. */
  plannedCostId: number | null;
  /** Bills, or fun for the viewer's own private bills (where Trends counts private charges). */
  group: GroupKey;
}

export interface PlannedCostInput {
  id: number;
  name: string;
  /** The spending group its money counts in (P6b-R4). */
  group: GroupKey;
  /** Today's balance: set-asides through this month, less spending so far. */
  balanceNowCents: Cents;
  startMonth: MonthKey;
  amounts: readonly AmountRow[];
  /** Shared spending in its categories by month (positive = out): the last 12 full months and this month so far. */
  spendByMonth: Readonly<Record<MonthKey, Cents>>;
  /** Its categories' usual month (less its own confirmed bills): taken out of its group's usual. */
  usualCents: Cents;
  /** Its own shared confirmed bills as a monthly amount: the set-aside's share that the bills themselves take. */
  ownBillsMonthlyCents: Cents;
}

export interface GoalAheadInput {
  name: string;
  remainingCents: Cents;
  /** Average of the last 3 full months' contributions. */
  recentAverageCents: Cents;
}

export interface MonthsAheadInput {
  today: ISODate;
  startBalanceCents: Cents;
  lowBalanceCents: Cents;
  income: readonly PaydaySource[];
  /** Bills and due-day lines from this month (overdue ones too) through 12 months ahead, at the usual amount. */
  bills: readonly MonthBill[];
  /** Usual money out per group (the last 3 full months). */
  usual: Record<GroupKey, Cents>;
  /** Confirmed bills by the group their charges count in: they come out as bills, so not in usual too. */
  billsInUsual: readonly { group: GroupKey | null; cadence: Cadence; amountCents: Cents }[];
  /** Each month's saving lines (hand part only; this month: what's left of them). */
  saving: Readonly<Record<MonthKey, Cents>>;
  plannedCosts: readonly PlannedCostInput[];
  /** The household's first month with any transaction. */
  historyStart: MonthKey | null;
  goals: readonly GoalAheadInput[];
  /**
   * Bills-section spending no confirmed bill or due-day line covers (utilities that vary, even-timing lines),
   * as a monthly amount: counted in Bills each month (P6b-R17).
   */
  otherBillsCents: Cents;
  /** Plan › Ahead's lines by month (debt payments, known items, surprises, set-aside changes, goal saving). */
  ahead?: Readonly<Record<MonthKey, AheadMonthLines>>;
}

export type AheadLineKind = 'debt' | 'item' | 'surprise' | 'setAside' | 'goal';

export interface AheadLine {
  kind: AheadLineKind;
  /** The debt, item, planned cost or goal; null for surprises. */
  id: number | null;
  name: string;
  /** Positive = money out, negative = money in (a known item coming in, a set-aside lowered). */
  amountCents: Cents;
}

export interface AheadMonthLines {
  /** Known items coming in. */
  inCents: Cents;
  /** Everything else, as money out. */
  outCents: Cents;
  lines: AheadLine[];
}

export interface MonthsWhatIf {
  /** 1 = usual, 0.75, 0.5, 0 = none. */
  habitsFactor?: number;
  /** 1 = usual, 0.9, 0.8. */
  everydayFactor?: number;
  /** An added cost each whole month (from next month). */
  monthlyCents?: Cents;
  /** A one-off cost in `oneOffMonth`. */
  oneOffCents?: Cents;
  oneOffMonth?: MonthKey;
  /** More (or, negative, less) on every paycheck. */
  payChangeCents?: Cents;
}

export type ByGroup = Record<GroupKey, Cents>;

export interface BigItem {
  name: string;
  amountCents: Cents;
  /** "like last Dec" for a planned cost's spending taken from last year. */
  note: string | null;
}

export interface MonthAhead {
  month: MonthKey;
  /** "Rest of Oct", "Nov 2026". */
  label: string;
  /** The current month, from tomorrow on. */
  partial: boolean;
  payDays: number;
  /** A whole month with more paydays than usual for a source (a 3rd biweekly check). */
  extraPay: boolean;
  inCents: Cents;
  byGroup: ByGroup;
  /** The part of byGroup.bills that is "other bills" (P6b-R17). */
  otherBillsCents: Cents;
  /** What-if costs. */
  addedCents: Cents;
  /** Plan › Ahead's lines (their money in is in inCents, their money out in outCents). */
  ahead: AheadMonthLines;
  /** byGroup + addedCents + ahead.outCents. */
  outCents: Cents;
  leftOverCents: Cents;
  endCents: Cents;
  bigItems: BigItem[];
}

export interface PlannedCostAhead {
  name: string;
  balanceNowCents: Cents;
  lowestCents: Cents;
  lowestMonth: MonthKey;
  endCents: Cents;
  /** More to set aside each month to keep it from going below 0 (rounded up to $5); 0 when it doesn't. */
  fixMonthlyCents: Cents;
  /** Its balance at the end of each month shown. */
  balances: Cents[];
  /** Its expected spending (bills included) in each month shown. */
  spends: Cents[];
}

export interface GoalAhead {
  name: string;
  /** The month it's reached at the recent pace; null when nothing is going in. */
  projectedMonth: MonthKey | null;
  done: boolean;
}

export interface MonthsAhead {
  horizon: Horizon;
  months: MonthAhead[];
  totals: { inCents: Cents; outCents: Cents; leftOverCents: Cents; byGroup: ByGroup };
  /** The month that ends with the least cash (the earliest of equals). */
  tightest: MonthAhead;
  /** Cash at the end of the last month. */
  endCents: Cents;
  /** Habits at the usual pace over the next 12 months, whatever the horizon. */
  habitsTotalCents: Cents;
  plannedCosts: PlannedCostAhead[];
  goals: GoalAhead[];
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (month: MonthKey) => MONTH_SHORT[parseMonth(month).m - 1]!;
const zeros = (): ByGroup => ({ bills: 0, everyday: 0, habits: 0, fun: 0, saving: 0 });
const NO_AHEAD: AheadMonthLines = { inCents: 0, outCents: 0, lines: [] };
const SPREAD_GROUPS = ['everyday', 'habits', 'fun'] as const;

/**
 * Expected spending for a planned cost in a month, before its own bills that month come off (like last year),
 * or with them already off as a monthly rate (from the set-aside: P6b-R18). The rest of this month is last
 * year's month less what's gone out so far, or the set-aside × the share of days left.
 */
function expectedSpend(
  cost: PlannedCostInput,
  month: MonthKey,
  current: MonthKey,
  hasYear: boolean,
  shareLeft: number,
): { cents: Cents; likeLast: boolean } {
  const lastYear = addMonths(month, -12);
  // This month isn't over, so a year from now falls back to the set-aside (P6b-R2).
  if (hasYear && lastYear < current) {
    const soFar = month === current ? (cost.spendByMonth[current] ?? 0) : 0;
    return { cents: Math.max(0, (cost.spendByMonth[lastYear] ?? 0) - soFar), likeLast: true };
  }
  const share = month === current ? shareLeft : 1;
  return { cents: Math.round(Math.max(0, monthlyFor(cost.amounts, month) - cost.ownBillsMonthlyCents) * share), likeLast: false };
}

export function projectMonths(input: MonthsAheadInput, horizon: Horizon = 12, whatIf: MonthsWhatIf = {}): MonthsAhead {
  const { today } = input;
  const current = monthOf(today);
  const tomorrow = addDays(today, 1);
  const shareLeft = diffDays(monthEnd(current), today) / monthLength(current);
  const hasYear = input.historyStart !== null && input.historyStart <= addMonths(current, -12);

  // Usual less the bills that come out on their own and less the planned costs' categories (P6b-R1).
  const usual = usualLessBills(input.usual, input.billsInUsual);
  for (const cost of input.plannedCosts) {
    if (cost.group === 'everyday' || cost.group === 'habits' || cost.group === 'fun') usual[cost.group] = Math.max(0, usual[cost.group] - cost.usualCents);
  }
  const factor = { everyday: whatIf.everydayFactor ?? 1, habits: whatIf.habitsFactor ?? 1, fun: 1 };

  const costBalances = input.plannedCosts.map((c) => ({ balance: c.balanceNowCents, lowest: Number.POSITIVE_INFINITY, lowestMonth: current, balances: [] as Cents[], spends: [] as Cents[] }));
  const months: MonthAhead[] = [];
  let cash = input.startBalanceCents;
  for (let i = 0; i <= horizon; i++) {
    const month = addMonths(current, i);
    const partial = i === 0;
    const start = partial ? tomorrow : monthStart(month);
    const end = monthEnd(month);
    const share = partial ? shareLeft : 1;

    let inCents = 0;
    let extraPay = false;
    const payDates = new Set<ISODate>();
    for (const source of input.income) {
      const received = new Set(source.receivedPayDates ?? []);
      const dates = payDatesBetween(source.schedule, start, end).filter((d) => !received.has(d));
      inCents += dates.length * (source.netPayCents + (whatIf.payChangeCents ?? 0));
      if (!partial && dates.length > REGULAR_PAYS_PER_MONTH[source.schedule.frequency]) extraPay = true;
      for (const d of dates) payDates.add(d);
    }

    const byGroup = zeros();
    const bigItems: BigItem[] = [];
    // Overdue bills come out in the rest of this month.
    const bills = input.bills.filter((b) => b.date <= end && (partial || b.date >= start));
    for (const b of bills) {
      byGroup[b.group] += b.amountCents;
      if (b.amountCents >= BIG_ITEM_CENTS && (b.cadence === 'quarterly' || b.cadence === 'yearly')) bigItems.push({ name: b.name, amountCents: b.amountCents, note: null });
    }
    for (const g of SPREAD_GROUPS) byGroup[g] += Math.round(usual[g] * share * factor[g]);
    const otherBillsCents = Math.round(input.otherBillsCents * share);
    byGroup.bills += otherBillsCents;
    byGroup.saving += input.saving[month] ?? 0;

    input.plannedCosts.forEach((cost, k) => {
      const expected = expectedSpend(cost, month, current, hasYear, shareLeft);
      const ownBills = bills.filter((b) => b.plannedCostId === cost.id).reduce((sum, b) => sum + b.amountCents, 0);
      const cents = expected.likeLast ? Math.max(0, expected.cents - ownBills) : expected.cents;
      byGroup[cost.group] += cents;
      if (expected.likeLast && cents >= BIG_ITEM_CENTS) bigItems.push({ name: cost.name, amountCents: cents, note: `like last ${short(month)}` });
      // This month's set-aside is already in today's balance. Its own bills are paid from it too.
      const tracked = costBalances[k]!;
      tracked.balance += (partial || cost.startMonth > month ? 0 : monthlyFor(cost.amounts, month)) - cents - ownBills;
      if (tracked.balance < tracked.lowest) {
        tracked.lowest = tracked.balance;
        tracked.lowestMonth = month;
      }
      tracked.balances.push(tracked.balance);
      tracked.spends.push(cents + ownBills);
    });

    const addedCents = (partial ? 0 : (whatIf.monthlyCents ?? 0)) + (whatIf.oneOffMonth === month ? (whatIf.oneOffCents ?? 0) : 0);
    const ahead = input.ahead?.[month] ?? NO_AHEAD;
    inCents += ahead.inCents;
    const outCents = byGroup.bills + byGroup.everyday + byGroup.habits + byGroup.fun + byGroup.saving + addedCents + ahead.outCents;
    cash += inCents - outCents;
    months.push({
      month,
      label: partial ? `Rest of ${short(month)}` : `${short(month)} ${parseMonth(month).y}`,
      partial,
      payDays: payDates.size,
      extraPay,
      inCents,
      byGroup,
      otherBillsCents,
      addedCents,
      ahead,
      outCents,
      leftOverCents: inCents - outCents,
      endCents: cash,
      bigItems: bigItems.sort((a, b) => b.amountCents - a.amountCents),
    });
  }

  const totals = { inCents: 0, outCents: 0, leftOverCents: 0, byGroup: zeros() };
  for (const m of months) {
    totals.inCents += m.inCents;
    totals.outCents += m.outCents;
    totals.leftOverCents += m.leftOverCents;
    for (const key of Object.keys(totals.byGroup) as GroupKey[]) totals.byGroup[key] += m.byGroup[key];
  }

  return {
    horizon,
    months,
    totals,
    tightest: months.reduce((low, m) => (m.endCents < low.endCents ? m : low), months[0]!),
    endCents: cash,
    habitsTotalCents: input.usual.habits * 12,
    plannedCosts: input.plannedCosts.map((cost, k) => {
      const { balance, lowest, lowestMonth, balances, spends } = costBalances[k]!;
      // Spread over the set-asides still to come before it's lowest (at least one).
      const monthsUntil = Math.max(1, parseMonthIndex(lowestMonth) - parseMonthIndex(current));
      return {
        name: cost.name,
        balanceNowCents: cost.balanceNowCents,
        lowestCents: lowest,
        lowestMonth,
        endCents: balance,
        fixMonthlyCents: lowest < 0 ? roundUpToFive(-lowest / monthsUntil) : 0,
        balances,
        spends,
      };
    }),
    goals: input.goals.map((g) => ({
      name: g.name,
      projectedMonth:
        g.remainingCents <= 0 ? current : g.recentAverageCents > 0 ? addMonths(current, Math.ceil(g.remainingCents / g.recentAverageCents)) : null,
      done: g.remainingCents <= 0,
    })),
  };
}

function parseMonthIndex(month: MonthKey): number {
  const { y, m } = parseMonth(month);
  return y * 12 + m;
}

/** Months that go short (spend more than comes in) or end under the cushion, in order. */
export function monthsToWatch(result: Pick<MonthsAhead, 'months'>, lowBalanceCents: Cents): MonthAhead[] {
  return result.months.filter((m) => m.leftOverCents < 0 || m.endCents < lowBalanceCents);
}
