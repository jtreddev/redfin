import { flowCents, type LedgerEntry } from './actuals';
import { GROUPS } from './categorySet';
import { addMonths, monthLength, monthOf, parseDate, type ISODate, type MonthKey } from './dates';
import type { Cents } from './money';

export type GroupKey = 'bills' | 'everyday' | 'habits' | 'fun' | 'saving';

/** The spending groups in their fixed order (charts color them by this order). */
export const GROUP_ORDER: readonly { key: GroupKey; section: string; name: string }[] = [
  { key: 'bills', section: GROUPS.bills, name: GROUPS.bills },
  { key: 'everyday', section: GROUPS.everyday, name: GROUPS.everyday },
  { key: 'habits', section: GROUPS.habits, name: GROUPS.habits },
  { key: 'fun', section: GROUPS.fun, name: GROUPS.fun },
  { key: 'saving', section: GROUPS.saving, name: GROUPS.saving },
];

export interface TrendsInput {
  entries: readonly LedgerEntry[];
  /** In display order; a sub-category (parentId set) comes after its parent. */
  categories: readonly { id: number; name: string; section: string; funMemberId: number | null; parentId?: number | null }[];
  /** Oldest → newest; the last is the current month. */
  months: readonly MonthKey[];
  today: ISODate;
}

export interface Trends {
  months: MonthKey[];
  /** The current month (incomplete). */
  partialMonth: MonthKey;
  /** Money out per group per month (positive = money out; refunds can make a month negative). */
  groups: { key: GroupKey; name: string; byMonth: Cents[] }[];
  incomeByMonth: Cents[];
  /** Money out with no category ("Needs a look"). */
  uncategorizedByMonth: Cents[];
  /**
   * Group categories with any activity in the range. A parent's byMonth includes its sub-categories'
   * (parentId set), which are listed after it.
   */
  categories: { id: number; name: string; group: GroupKey; parentId: number | null; byMonth: Cents[] }[];
  /**
   * Average of the last 3 full months, counting only months on or after `historyStart` (fewer when
   * history is shorter; 0 when there is no full month yet).
   */
  usual: Record<GroupKey, Cents>;
  /**
   * The first month with any ledger data among the entries given (it may be before `months[0]`); null when
   * there is none. "Usual" never averages months before it.
   */
  historyStart: MonthKey | null;
}

/** How many full months "usual" averages. */
const USUAL_MONTHS = 3;

/**
 * Where the "usual" window before `index` starts: 3 months back, but never before the household's
 * first month with data. The window is empty (start ≥ index) when there's no full month to average.
 */
function usualStart(trends: Pick<Trends, 'months' | 'historyStart'>, index: number): number {
  const { months, historyStart } = trends;
  if (historyStart === null) return index;
  const first = historyStart <= months[0]! ? 0 : months.indexOf(historyStart);
  return Math.max(index - USUAL_MONTHS, first < 0 ? index : first);
}

/** Average of byMonth[start..index); 0 when that's empty. */
function average(byMonth: readonly Cents[], start: number, index: number): Cents {
  const window = byMonth.slice(Math.max(0, start), Math.max(0, index));
  if (window.length === 0) return 0;
  return Math.round(window.reduce((sum, v) => sum + v, 0) / window.length);
}

export function buildTrends({ entries, categories, months, today }: TrendsInput): Trends {
  const partialMonth = monthOf(today);
  const monthIndex = new Map(months.map((m, i) => [m, i]));
  const zeros = () => months.map(() => 0);

  const groupOfSection = new Map(GROUP_ORDER.map((g) => [g.section, g.key]));
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const funCategoryOf = new Map<number, number>();
  for (const c of categories) if (c.funMemberId !== null) funCategoryOf.set(c.funMemberId, c.id);

  const groupTotals = new Map(GROUP_ORDER.map((g) => [g.key, zeros()]));
  const incomeByMonth = zeros();
  const uncategorizedByMonth = zeros();
  const byCategory = new Map<number, Cents[]>();

  const lastMonth = months[months.length - 1];
  let historyStart: MonthKey | null = null;
  for (const entry of entries) {
    const month = monthOf(entry.date);
    if (lastMonth !== undefined && month <= lastMonth && (historyStart === null || month < historyStart)) historyStart = month;
    const index = monthIndex.get(month);
    if (index === undefined) continue;

    let categoryId = entry.categoryId;
    let flow: Cents;
    if (entry.privateMemberId !== null && categoryById.get(categoryId ?? -1)?.funMemberId !== entry.privateMemberId) {
      // A private charge only ever counts as its owner's fun money, whatever it was filed under.
      const fun = funCategoryOf.get(entry.privateMemberId);
      if (fun === undefined) continue;
      categoryId = fun;
      flow = flowCents({ kind: 'expense', amountCents: entry.amountCents });
    } else if (categoryId === null) {
      // Uncategorized deposits are left out: they're as often refunds or transfers as income.
      if (entry.amountCents < 0) uncategorizedByMonth[index]! -= entry.amountCents;
      continue;
    } else {
      flow = flowCents(entry);
    }

    const category = categoryById.get(categoryId);
    if (!category) continue;
    if (category.section === GROUPS.income) {
      incomeByMonth[index]! += flow;
      continue;
    }
    const group = groupOfSection.get(category.section);
    if (!group) continue; // Transfers, or an old section left behind by the category migration.
    groupTotals.get(group)![index]! += flow;
    // A sub-category's money also counts toward its parent's row.
    for (const id of category.parentId != null ? [categoryId, category.parentId] : [categoryId]) {
      let row = byCategory.get(id);
      if (!row) byCategory.set(id, (row = zeros()));
      row[index]! += flow;
    }
  }

  const current = monthIndex.get(partialMonth) ?? months.length;
  const start = usualStart({ months: [...months], historyStart }, current);
  const groups = GROUP_ORDER.map((g) => ({ key: g.key, name: g.name, byMonth: groupTotals.get(g.key)! }));
  const groupRank = new Map(GROUP_ORDER.map((g, i) => [g.key, i]));
  const rows = categories
    .filter((c) => byCategory.has(c.id))
    .map((c) => ({ id: c.id, name: c.name, group: groupOfSection.get(c.section)!, parentId: c.parentId ?? null, byMonth: byCategory.get(c.id)! }))
    .sort((a, b) => groupRank.get(a.group)! - groupRank.get(b.group)!); // stable: keeps the categories' own order

  return {
    months: [...months],
    partialMonth,
    groups,
    incomeByMonth,
    uncategorizedByMonth,
    categories: rows,
    usual: Object.fromEntries(groups.map((g) => [g.key, average(g.byMonth, start, current)])) as Record<GroupKey, Cents>,
    historyStart,
  };
}

/**
 * The usual monthly amount of one row of `trends` (a category's or a group's byMonth): the average of the
 * last 3 full months before the current one, counting only months since the household's history began.
 */
export function usualOf(trends: Pick<Trends, 'months' | 'partialMonth' | 'historyStart'>, byMonth: readonly Cents[]): Cents {
  const index = trends.months.indexOf(trends.partialMonth);
  const current = index < 0 ? trends.months.length : index;
  return average(byMonth, usualStart(trends, current), current);
}

export interface Change {
  categoryId: number;
  name: string;
  soFar: Cents;
  usual: Cents;
  projected: Cents;
  diff: Cents;
}

/** Changes smaller than this are noise. */
const CHANGE_THRESHOLD_CENTS = 2000;
/**
 * Only everyday spending is compared. Bills and Saving (rent, loans, insurance, transfers to savings) land on
 * fixed days, so scaling them by days elapsed makes false spikes.
 */
const CHANGE_GROUPS: ReadonlySet<GroupKey> = new Set(['everyday', 'habits', 'fun']);
/** Before this day of the month there's too little to go on; compare last month instead. */
const FIRST_COMPARABLE_DAY = 7;

/**
 * Everyday, Habits and Fun & Wants categories whose month differs most from usual. From day 7 on, this month so far scaled to the full
 * month by days elapsed; before that, the last full month as it ended. Usual is the average of the 3
 * months before the month compared, from the household's first month with data on; with no such full
 * month there's nothing to compare, so no rows.
 */
export function whatChanged(
  trends: Trends,
  today: ISODate,
): { basis: 'this-month' | 'last-month'; up: Change[]; down: Change[] } {
  const day = parseDate(today).d;
  const basis = day < FIRST_COMPARABLE_DAY ? 'last-month' : 'this-month';
  const month = basis === 'this-month' ? monthOf(today) : addMonths(monthOf(today), -1);
  const index = trends.months.indexOf(month);
  const start = usualStart(trends, index);
  if (index < 0 || start >= index) return { basis, up: [], down: [] };

  // Top-level categories only: a parent already includes its sub-categories.
  const changes = trends.categories.filter((c) => c.parentId === null && CHANGE_GROUPS.has(c.group)).map((c): Change => {
    const soFar = c.byMonth[index]!;
    const usual = average(c.byMonth, start, index);
    const projected = basis === 'this-month' ? Math.round((soFar * monthLength(month)) / day) : soFar;
    return { categoryId: c.id, name: c.name, soFar, usual, projected, diff: projected - usual };
  });
  const notable = changes.filter((c) => Math.abs(c.diff) >= CHANGE_THRESHOLD_CENTS);
  return {
    basis,
    up: notable.filter((c) => c.diff > 0).sort((a, b) => b.diff - a.diff).slice(0, 5),
    down: notable.filter((c) => c.diff < 0).sort((a, b) => a.diff - b.diff).slice(0, 3),
  };
}
