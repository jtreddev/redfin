/**
 * Planned costs (sinking funds): a steady monthly set-aside for lumpy costs like car repairs,
 * with a running balance. The money stays in savings; this is tracking only.
 */
import { flowCents, type LedgerEntry } from './actuals';
import { addMonths, monthOf, type ISODate, type MonthKey } from './dates';
import type { Cents } from './money';
import { nextOccurrence } from './recurring';

export interface AmountRow {
  month: MonthKey;
  monthlyCents: Cents;
}

/** The set-aside in effect for a month: the latest change on or before it (the first one before any). */
export function monthlyFor(amounts: readonly AmountRow[], month: MonthKey): Cents {
  let found: AmountRow | null = null;
  let earliest: AmountRow | null = null;
  for (const a of amounts) {
    if (!earliest || a.month < earliest.month) earliest = a;
    if (a.month <= month && (!found || a.month > found.month)) found = a;
  }
  return (found ?? earliest)?.monthlyCents ?? 0;
}

/** This month's set-asides across costs that have started by then. */
export function plannedMonthTotal(costs: readonly { startMonth: MonthKey; amounts: readonly AmountRow[] }[], month: MonthKey): Cents {
  return costs.reduce((total, c) => (c.startMonth <= month ? total + monthlyFor(c.amounts, month) : total), 0);
}

/** Spending per category per month (positive = money out; refunds subtract). */
export type SpendMap = Map<number, Map<MonthKey, Cents>>;

export function addSpend(spend: SpendMap, categoryId: number, month: MonthKey, cents: Cents): void {
  const byMonth = spend.get(categoryId) ?? new Map<MonthKey, Cents>();
  byMonth.set(month, (byMonth.get(month) ?? 0) + cents);
  spend.set(categoryId, byMonth);
}

/** Budget counting rules (ledgerEntries + flowCents), grouped by category and month. */
export function spendByCategoryMonth(entries: readonly LedgerEntry[], into: SpendMap = new Map()): SpendMap {
  for (const e of entries) {
    if (e.categoryId === null) continue;
    addSpend(into, e.categoryId, monthOf(e.date), flowCents(e));
  }
  return into;
}

/**
 * These categories plus their sub-categories, each once: linking a parent covers its children,
 * except a child linked to a cost of its own (`linkedAnywhere`), which its own cost keeps.
 */
export function withSubcategories(
  categoryIds: readonly number[],
  categories: readonly { id: number; parentId: number | null }[],
  linkedAnywhere: ReadonlySet<number> = new Set(),
): number[] {
  const linked = new Set(categoryIds);
  const out = new Set(categoryIds);
  for (const c of categories) {
    if (c.parentId !== null && linked.has(c.parentId) && !linkedAnywhere.has(c.id)) out.add(c.id);
  }
  return [...out];
}

/** Spending in these categories from `from` through `to` (months, inclusive). */
export function spendIn(spend: SpendMap, categoryIds: readonly number[], from: MonthKey, to: MonthKey): Cents {
  let total = 0;
  for (const id of categoryIds) {
    for (const [month, cents] of spend.get(id) ?? []) if (month >= from && month <= to) total += cents;
  }
  return total;
}

export interface CostForBalance {
  startMonth: MonthKey;
  startBalanceCents: Cents;
  amounts: readonly AmountRow[];
  categoryIds: readonly number[];
}

/** Starting balance + each month's set-aside from the start through this month − spending since the start. */
export function costBalance(cost: CostForBalance, spend: SpendMap, currentMonth: MonthKey): Cents {
  let saved = cost.startBalanceCents;
  for (let m = cost.startMonth; m <= currentMonth; m = addMonths(m, 1)) saved += monthlyFor(cost.amounts, m);
  return saved - spendIn(spend, cost.categoryIds, cost.startMonth, currentMonth);
}

export function roundUpToFive(cents: Cents): Cents {
  return cents <= 0 ? 0 : Math.ceil(cents / 500) * 500;
}

/** The last 12 full months, minus any before the household's first transaction. */
export function suggestionMonths(currentMonth: MonthKey, historyStart: MonthKey | null): MonthKey[] {
  if (!historyStart) return [];
  const months: MonthKey[] = [];
  for (let i = 12; i >= 1; i--) {
    const m = addMonths(currentMonth, -i);
    if (m >= historyStart) months.push(m);
  }
  return months;
}

export const MIN_SUGGESTION_MONTHS = 3;

/** Average monthly spend rounded up to $5, or null with under 3 months of history. */
export function suggestMonthly(spentCents: Cents, countedMonths: number): Cents | null {
  if (countedMonths < MIN_SUGGESTION_MONTHS) return null;
  return roundUpToFive(spentCents / countedMonths);
}

/** Created once, the first time planned costs load. Categories are (group, name). */
export const DEFAULT_PLANNED_COSTS: { name: string; categories: [string, string][]; fallbackMonthlyCents: Cents }[] = [
  { name: 'Car', categories: [['Everyday', 'Car Upkeep']], fallbackMonthlyCents: 5000 },
  { name: 'Health', categories: [['Everyday', 'Medical']], fallbackMonthlyCents: 4000 },
  // Shopping is too broad to count as gifts; people can add it.
  { name: 'Holidays & gifts', categories: [['Fun & Wants', 'Gifts']], fallbackMonthlyCents: 7500 },
];

/**
 * A default cost whose history suggests $0 (enough months, nothing spent) gets its starter amount
 * instead, so Health doesn't start at $0 just because no dentist bill came this year.
 * `fallbackCents` is null for costs that aren't one of the defaults.
 */
export function withStarter(suggested: Cents | null, fallbackCents: Cents | null): Cents | null {
  return suggested === 0 && fallbackCents != null ? fallbackCents : suggested;
}

/** The default whose categories are exactly these (renaming a default keeps its starter amount). */
export function starterFor(categoryIds: readonly number[], defaults: readonly { categoryIds: readonly number[]; fallbackMonthlyCents: Cents }[]): Cents | null {
  const key = [...categoryIds].sort((a, b) => a - b).join(',');
  return defaults.find((d) => d.categoryIds.length && [...d.categoryIds].sort((a, b) => a - b).join(',') === key)?.fallbackMonthlyCents ?? null;
}

export interface YearlyBill {
  name: string;
  nextDate: ISODate;
  amountCents: Cents;
  categoryId: number | null;
}

export type ComingUpItem =
  | { kind: 'bill'; name: string; date: ISODate; amountCents: Cents }
  | { kind: 'usual'; month: MonthKey; amountCents: Cents };

/** How far ahead "December usually costs about $420" looks. */
const USUAL_LOOKAHEAD_MONTHS = 3;

/**
 * What's likely next: linked confirmed yearly bills (stale dates rolled forward a year at a time),
 * then last year's biggest month when it comes around again within 3 months (needs 12 months of history).
 */
export function comingUp(input: {
  categoryIds: readonly number[];
  bills: readonly YearlyBill[];
  spend: SpendMap;
  today: ISODate;
  historyStart: MonthKey | null;
}): ComingUpItem[] {
  const { categoryIds, today, historyStart } = input;
  const linked = new Set(categoryIds);
  const items: ComingUpItem[] = [];

  const bills = input.bills
    .filter((b) => b.categoryId !== null && linked.has(b.categoryId))
    .map((b) => {
      let date = b.nextDate;
      for (let guard = 0; date < today && guard < 20; guard++) date = nextOccurrence(date, 'yearly');
      return { kind: 'bill' as const, name: b.name, date, amountCents: Math.abs(b.amountCents) };
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.amountCents - a.amountCents));
  items.push(...bills);

  const current = monthOf(today);
  if (historyStart && historyStart <= addMonths(current, -12)) {
    let best: { month: MonthKey; cents: Cents } | null = null;
    for (const month of suggestionMonths(current, historyStart)) {
      const cents = spendIn(input.spend, categoryIds, month, month);
      if (cents > 0 && (!best || cents > best.cents)) best = { month, cents };
    }
    if (best) {
      const next = addMonths(best.month, 12);
      if (next <= addMonths(current, USUAL_LOOKAHEAD_MONTHS)) items.push({ kind: 'usual', month: next, amountCents: best.cents });
    }
  }
  return items;
}
