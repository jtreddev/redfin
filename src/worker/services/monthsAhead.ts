import { addMonths, monthEnd, monthOf, monthStart, type ISODate, type MonthKey } from '../../shared/dates';
import type { Cents } from '../../shared/money';
import type { MonthBill, PlannedCostInput } from '../../shared/monthsAhead';
import { currentMonthly, suggestSurprise, type AheadInput, type AheadItem, type AheadPlan } from '../../shared/planAhead';
import { costBalance, spendByCategoryMonth, spendIn, withSubcategories, type SpendMap } from '../../shared/plannedCosts';
import { monthlyEquivalent } from '../../shared/projection';
import { GROUP_ORDER, usualOf, type GroupKey } from '../../shared/trends';
import type { HouseholdSettings } from '../env';
import { all, first } from '../lib/db';
import { aheadDebt, debtCategoryIds, dueDayCategories, linkDebts, loadDebts, takenByPlan, type DebtRow } from './debts';
import { loadForecastInputs, withoutSetAside, type ForecastInputs } from './forecastInputs';
import { goalsWithProgress } from './goals';
import { loadLaterMonths, ownLineRows, upcomingBills, type BudgetRow } from './planner';
import { addOlderSpend, loadPlannedCosts, type PlannedCostRow } from './plannedCosts';

/** Whole months ahead the inputs cover; the client shows 3, 6 or 12 of them. */
const MONTHS_AHEAD = 12;
/** The ledger reaches back 12 full months (last year's same month) plus this one. */
const LEDGER_MONTHS = 13;

export type GoalWithProgress = Awaited<ReturnType<typeof goalsWithProgress>>[number];

export interface MonthsAheadInputs {
  /** Months ahead's input plus Plan › Ahead's (debts, goals, items, surprises), without the saved plan's lines. */
  input: AheadInput;
  /** The plan as saved: the sliders' starting point. */
  saved: AheadPlan;
  debts: DebtRow[];
  goals: GoalWithProgress[];
  items: AheadItem[];
  /** savedCents null: the suggestion is used. */
  surprise: { suggestedCents: Cents; savedCents: Cents | null };
  hasBalance: boolean;
  hasIncome: boolean;
}

/**
 * Everything projectMonths and planAhead need for the rest of this month and the next 12, as the viewer may
 * see it: a partner's private bills are left out and private charges count only in fun totals.
 *
 * From next month the saved plan owns some money, so its old form is taken out here and planAhead puts it back
 * at the plan's amount (counted once, P7-R8): a debt's linked bill and the bills and due-day lines in its
 * category become its minimum + extra; a goal's saving line becomes the goal's monthly amount. This month is
 * left as it is.
 *
 * `link` runs debt auto-link first (Plan › Ahead and Debts).
 */
export async function loadMonthsAheadInput(
  db: D1Database,
  today: ISODate,
  viewerId: number,
  household: HouseholdSettings,
  opts: { link?: boolean } = {},
): Promise<MonthsAheadInputs> {
  const current = monthOf(today);
  const until = monthEnd(addMonths(current, MONTHS_AHEAD));
  if (opts.link) await linkDebts(db, today);
  const [inputs, costs, history, debts, items] = await Promise.all([
    loadForecastInputs(db, today, viewerId, household, { payUntil: until, trendsMonths: LEDGER_MONTHS }),
    loadPlannedCosts(db),
    first<{ first: ISODate | null }>(db, 'SELECT MIN(date) AS first FROM transactions WHERE deleted_at IS NULL'),
    loadDebts(db, viewerId),
    loadItems(db),
  ]);
  const { planner } = inputs;

  // Later months' rows (their due-day lines, their saving lines) in a fixed number of queries. Goals reuse the
  // ledger just loaded.
  const ledger = { from: monthStart(addMonths(current, 1 - LEDGER_MONTHS)), entries: inputs.trendsInput.entries };
  const [later, goals] = await Promise.all([
    loadLaterMonths(db, planner, addMonths(current, 1), addMonths(current, MONTHS_AHEAD), costs, inputs.categories),
    goalsWithProgress(db, today, false, ledger),
  ]);
  const monthRows = async (month: MonthKey) => later.get(month) ?? planner.data.rows;
  const upcoming = await upcomingBills(db, planner, today, viewerId, { until, repeat: true, laterMonths: true, monthRows });

  // Saving: every savings line, any timing, without its set-aside (P6-R5). This month counts what's left.
  // From next month a goal's line is the goal's monthly amount instead.
  const goalCategories = new Set(goals.flatMap((g) => (g.categoryId === null ? [] : [g.categoryId])));
  const goalLines = new Map<number, Cents>();
  const saving: Record<MonthKey, Cents> = {};
  const savingLines = new Map<MonthKey, Set<number>>();
  for (let i = 0; i <= MONTHS_AHEAD; i++) {
    const month = addMonths(current, i);
    const rows = ownLineRows(i === 0 ? planner.data.rows : await monthRows(month)).filter((r) => r.kind === 'savings' && r.funMemberId == null);
    savingLines.set(month, new Set(rows.map((r) => r.categoryId)));
    saving[month] = rows.reduce((sum, r) => {
      const left = i === 0 ? (planner.forecast.remainingByLine.get(r.categoryId) ?? []).reduce((a, b) => a + b, 0) : r.budgetCents;
      const cents = Math.max(0, left - r.plannedCostsCents);
      if (i === 0 || !goalCategories.has(r.categoryId)) return sum + cents;
      if (i === 1) goalLines.set(r.categoryId, cents);
      return sum;
    }, 0);
  }

  // Today's balance counts every charge, as Planned Costs does; a cost that started before the loaded
  // ledger needs its older spending too (summed in SQL).
  const spendAll = spendByCategoryMonth(inputs.trendsInput.entries);
  const ledgerStart = addMonths(current, 1 - LEDGER_MONTHS);
  const earliest = costs.reduce<MonthKey | null>((min, cost) => (min === null || cost.startMonth < min ? cost.startMonth : min), null);
  if (earliest !== null && earliest < ledgerStart) await addOlderSpend(db, spendAll, monthStart(earliest), monthEnd(addMonths(ledgerStart, -1)));

  const plannedCosts = plannedCostInputs(inputs, costs, current, spendAll);
  const costOf = new Map<number, number>();
  for (const cost of plannedCosts) for (const id of cost.coveredIds) costOf.set(id, cost.input.id);

  const parentOf = new Map(inputs.trendsInput.categories.map((c) => [c.id, c.parentId ?? null]));
  // From next month a debt's payment is its minimum + extra (see above).
  const taken = takenByPlan(debts, parentOf, current);
  const historyStart = history?.first ? monthOf(history.first) : null;
  const groupOf = groupsOf(inputs);
  // Due-day lines come out as bills; one filed in Everyday, Habits or Fun mustn't be in that group's usual too.
  const linesInUsual = dueDayOwnLines(planner.data.rows).flatMap((r) => {
    const group = groupOf.get(r.categoryId);
    return group === 'everyday' || group === 'habits' || group === 'fun'
      ? [{ group, cadence: 'monthly' as const, amountCents: r.budgetCents - r.plannedCostsCents }]
      : [];
  });
  const kindOf = new Map(planner.data.rows.map((r) => [r.categoryId, r.kind]));
  const bills: MonthBill[] = upcoming
    .filter((b) => !taken(b))
    // A savings line (or a bill standing in for one) is counted in saving.
    .filter((b) => {
      if (b.categoryId === null || kindOf.get(b.categoryId) !== 'savings') return true;
      if (b.source === 'budget') return false;
      const lines = savingLines.get(monthOf(b.date) < current ? current : monthOf(b.date));
      const parent = parentOf.get(b.categoryId) ?? null;
      return !(lines?.has(b.categoryId) || (parent !== null && lines?.has(parent)));
    })
    .map((b) => ({
      name: b.name,
      date: b.date,
      amountCents: withoutSetAside(b, inputs),
      cadence: b.source === 'recurring' ? (b.cadence ?? 'monthly') : null,
      // The viewer's private charges aren't in a cost's spending, so their bills aren't taken off it.
      plannedCostId: b.categoryId !== null && !b.privateMemberId ? (costOf.get(b.categoryId) ?? null) : null,
      group: b.privateMemberId ? ('fun' as const) : ('bills' as const),
    }))
    .filter((b) => b.amountCents > 0);

  // Surprises leave out due-day lines' and planned costs' categories (P7-R2).
  // Surprises: how far spending ran over its usual, leaving out what's counted elsewhere (P7-R2).
  const suggestedCents = suggestSurprise(inputs.trends, today, new Set([...costOf.keys(), ...debtCategoryIds(debts)]), historyStart);
  const surpriseCents = household.surpriseCents ?? suggestedCents;
  const input: AheadInput = {
    today,
    startBalanceCents: inputs.cash.total,
    lowBalanceCents: household.lowBalanceCents,
    income: inputs.sources,
    bills,
    usual: inputs.trends.usual,
    billsInUsual: [...inputs.confirmed, ...linesInUsual],
    saving,
    plannedCosts: plannedCosts.map((c) => c.input),
    historyStart,
    // A goal's saved monthly amount is its pace; otherwise its recent average.
    goals: goals.map((g) => ({ name: g.name, remainingCents: g.progress.remainingCents, recentAverageCents: g.monthlyCents ?? g.progress.recentAverageCents })),
    // A debt's category money is its payment, counted by the plan.
    otherBillsCents: otherBills(inputs, historyStart, new Set([...costOf.keys(), ...debtCategoryIds(debts)])),
    debts: debts.map((d) => aheadDebt(d, dueDayCategories(planner.data.rows), parentOf)),
    aheadGoals: goals.map((g) => ({ id: g.id, name: g.name, remainingCents: g.progress.remainingCents, targetDate: g.targetDate })),
    items,
    surpriseCents,
    surpriseSuggestedCents: suggestedCents,
    strategy: household.debtStrategy,
  };

  return {
    input,
    saved: {
      debtExtra: Object.fromEntries(debts.map((d) => [d.id, d.extraCents])),
      costMonthly: Object.fromEntries(input.plannedCosts.map((c) => [c.id, currentMonthly(c, today)])),
      // Not set: next month's line, as the forecast had it.
      // Two goals on one category: the line is the first's.
      goalMonthly: Object.fromEntries(
        goals.map((g) => {
          const line = g.categoryId === null ? 0 : (goalLines.get(g.categoryId) ?? 0);
          if (g.categoryId !== null) goalLines.delete(g.categoryId);
          return [g.id, g.monthlyCents ?? line];
        }),
      ),
      surpriseCents,
      strategy: household.debtStrategy,
      order: debts.map((d) => d.id),
    },
    debts,
    goals,
    items,
    surprise: { suggestedCents, savedCents: household.surpriseCents },
    hasBalance: inputs.cash.counted > 0,
    hasIncome: inputs.sources.length > 0,
  };
}

export function loadItems(db: D1Database): Promise<AheadItem[]> {
  return all<AheadItem>(
    db,
    'SELECT id, name, amount_cents AS amountCents, month, repeat, end_month AS endMonth FROM ahead_items ORDER BY month, id',
  );
}

/** This month's due-day spending lines of their own (as dueDayLines counts them), at their hand amount. */
function dueDayOwnLines(rows: readonly BudgetRow[]): BudgetRow[] {
  return ownLineRows(rows).filter(
    (r) => r.timing === 'due_day' && r.dueDay != null && (r.kind === 'expense' || r.kind === 'debt') && r.funMemberId == null && r.budgetCents - r.plannedCostsCents > 0,
  );
}

/**
 * "Other bills" (P6b-R17): for each top-level Bills category, its average month over the last 12 full months
 * (or those since history began), less what's already projected for it — its shared confirmed bills as monthly
 * amounts and this month's due-day lines — floored at 0 per category, then added up. Sub-categories linked to a
 * planned cost are projected as the cost, so their money is left out; a category linked itself is skipped.
 * Twelve months keep a quarterly or yearly charge to its monthly share. Private charges are already in fun.
 */
function otherBills(inputs: ForecastInputs, historyStart: MonthKey | null, inCost: ReadonlySet<number>): Cents {
  const { trends, trendsInput, planner } = inputs;
  if (historyStart === null) return 0;
  const full = trends.months.map((m, i) => ({ m, i })).filter(({ m }) => m < trends.partialMonth && m >= historyStart);
  if (!full.length) return 0;
  const average = (byMonth: readonly Cents[]) => full.reduce((sum, { i }) => sum + (byMonth[i] ?? 0), 0) / full.length;
  const rowOf = new Map(trends.categories.map((c) => [c.id, c]));
  const childrenOf = new Map<number, number[]>();
  for (const c of trendsInput.categories) if (c.parentId != null) childrenOf.set(c.parentId, [...(childrenOf.get(c.parentId) ?? []), c.id]);
  const lines = dueDayOwnLines(planner.data.rows);

  let total = 0;
  for (const row of trends.categories) {
    if (row.group !== 'bills' || row.parentId !== null || inCost.has(row.id)) continue;
    const linked = (childrenOf.get(row.id) ?? []).filter((id) => inCost.has(id));
    const ids = new Set([row.id, ...(childrenOf.get(row.id) ?? [])].filter((id) => !inCost.has(id)));
    const spent = average(row.byMonth) - linked.reduce((sum, id) => sum + average(rowOf.get(id)?.byMonth ?? []), 0);
    const covered =
      inputs.confirmed.filter((b) => b.privateMemberId === null && ids.has(b.categoryId)).reduce((sum, b) => sum + monthlyEquivalent(Math.abs(b.amountCents), b.cadence), 0) +
      lines.filter((r) => ids.has(r.categoryId)).reduce((sum, r) => sum + r.budgetCents - r.plannedCostsCents, 0);
    total += Math.max(0, spent - covered);
  }
  return Math.round(total);
}

/** The spending-group of each category. */
function groupsOf(inputs: ForecastInputs): Map<number, GroupKey> {
  const groupOfSection = new Map(GROUP_ORDER.map((g) => [g.section, g.key]));
  const out = new Map<number, GroupKey>();
  for (const c of inputs.trendsInput.categories) {
    const group = groupOfSection.get(c.section);
    if (group) out.set(c.id, group);
  }
  return out;
}

/**
 * Each planned cost with linked categories, as projectMonths takes it (P6b-R1, R2, R4). A cost with no
 * categories is left out: its spending can't be told from anything else's, so it stays in usual.
 */
function plannedCostInputs(
  inputs: ForecastInputs,
  costs: readonly PlannedCostRow[],
  current: MonthKey,
  spendAll: SpendMap,
): { input: PlannedCostInput; coveredIds: number[] }[] {
  const { trends, trendsInput } = inputs;
  const categories = trendsInput.categories.map((c) => ({ id: c.id, parentId: c.parentId ?? null }));
  const groupOf = groupsOf(inputs);
  // What's expected counts shared charges only, so a partner's private spending never shows up as "like last Dec".
  const spendShared = spendByCategoryMonth(trendsInput.entries.filter((e) => e.privateMemberId === null));
  const lastYear = Array.from({ length: 12 }, (_, i) => addMonths(current, i - 12));
  const linkedAnywhere = new Set(costs.flatMap((c) => c.categoryIds));

  return costs
    .filter((cost) => cost.categoryIds.length > 0)
    .map((cost) => {
      const coveredIds = withSubcategories(cost.categoryIds, categories, linkedAnywhere);
      const covered = new Set(coveredIds);
      const spendByMonth: Record<MonthKey, Cents> = {};
      for (const month of [...lastYear, current]) spendByMonth[month] = spendIn(spendShared, coveredIds, month, month);

      // Its group: where most of last year's spending went, else its first category's (P6b-R4).
      const byGroup = new Map<GroupKey, Cents>();
      for (const id of coveredIds) {
        const group = groupOf.get(id);
        if (group) byGroup.set(group, (byGroup.get(group) ?? 0) + spendIn(spendShared, [id], lastYear[0]!, lastYear.at(-1)!));
      }
      const ranked = [...byGroup].sort((a, b) => b[1] - a[1]);
      const group = (ranked[0] && ranked[0][1] > 0 ? ranked[0][0] : groupOf.get(cost.categoryIds[0]!)) ?? 'everyday';

      // Usual as Trends counts it, less its own shared confirmed bills (they come off usual as bills already).
      const usual = usualOf(trends, trends.months.map((m) => spendIn(spendShared, coveredIds, m, m)));
      const ownBills = inputs.confirmed
        .filter((b) => b.privateMemberId === null && covered.has(b.categoryId))
        .reduce((sum, b) => sum + monthlyEquivalent(Math.abs(b.amountCents), b.cadence), 0);

      return {
        coveredIds,
        input: {
          id: cost.id,
          name: cost.name,
          group,
          balanceNowCents: costBalance({ ...cost, categoryIds: coveredIds }, spendAll, current),
          startMonth: cost.startMonth,
          amounts: cost.amounts,
          spendByMonth,
          usualCents: Math.max(0, usual - ownBills),
          ownBillsMonthlyCents: ownBills,
        },
      };
    });
}
