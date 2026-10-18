import { addMonths, monthEnd, monthOf, monthStart, type ISODate, type MonthKey } from '../../shared/dates';
import type { Cents } from '../../shared/money';
import type { MonthBill, MonthsAheadInput, PlannedCostInput } from '../../shared/monthsAhead';
import { costBalance, spendByCategoryMonth, spendIn, withSubcategories, type SpendMap } from '../../shared/plannedCosts';
import { monthlyEquivalent } from '../../shared/projection';
import { GROUP_ORDER, usualOf, type GroupKey } from '../../shared/trends';
import type { HouseholdSettings } from '../env';
import { first } from '../lib/db';
import { loadForecastInputs, withoutSetAside, type ForecastInputs } from './forecastInputs';
import { laterMonthRows, ownLineRows, upcomingBills, type BudgetRow } from './planner';
import { addOlderSpend, loadPlannedCosts, type PlannedCostRow } from './plannedCosts';

/** Whole months ahead the inputs cover; the client shows 3, 6 or 12 of them. */
const MONTHS_AHEAD = 12;
/** The ledger reaches back 12 full months (last year's same month) plus this one. */
const LEDGER_MONTHS = 13;

export interface MonthsAheadInputs {
  input: MonthsAheadInput;
  hasBalance: boolean;
  hasIncome: boolean;
}

/**
 * Everything projectMonths needs for the rest of this month and the next 12, as the viewer may see it: a
 * partner's private bills are left out and private charges count only in fun totals.
 */
export async function loadMonthsAheadInput(
  db: D1Database,
  today: ISODate,
  viewerId: number,
  household: HouseholdSettings,
): Promise<MonthsAheadInputs> {
  const current = monthOf(today);
  const until = monthEnd(addMonths(current, MONTHS_AHEAD));
  const [inputs, costs, history] = await Promise.all([
    loadForecastInputs(db, today, viewerId, household, { payUntil: until, trendsMonths: LEDGER_MONTHS }),
    loadPlannedCosts(db),
    first<{ first: ISODate | null }>(db, 'SELECT MIN(date) AS first FROM transactions WHERE deleted_at IS NULL'),
  ]);
  const { planner } = inputs;

  // Later months' rows are wanted twice (their due-day lines, their saving lines): load each once.
  const rowsByMonth = new Map<MonthKey, Promise<readonly BudgetRow[]>>();
  const monthRows = (month: MonthKey) => {
    let rows = rowsByMonth.get(month);
    if (!rows) rowsByMonth.set(month, (rows = laterMonthRows(db, planner, month)));
    return rows;
  };
  const upcoming = await upcomingBills(db, planner, today, viewerId, { until, repeat: true, laterMonths: true, monthRows });

  // Saving: every savings line, any timing, without its set-aside (P6-R5). This month counts what's left.
  const saving: Record<MonthKey, Cents> = {};
  const savingLines = new Map<MonthKey, Set<number>>();
  for (let i = 0; i <= MONTHS_AHEAD; i++) {
    const month = addMonths(current, i);
    const rows = ownLineRows(i === 0 ? planner.data.rows : await monthRows(month)).filter((r) => r.kind === 'savings' && r.funMemberId == null);
    savingLines.set(month, new Set(rows.map((r) => r.categoryId)));
    saving[month] = rows.reduce((sum, r) => {
      const left = i === 0 ? (planner.forecast.remainingByLine.get(r.categoryId) ?? []).reduce((a, b) => a + b, 0) : r.budgetCents;
      return sum + Math.max(0, left - r.plannedCostsCents);
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
  const kindOf = new Map(planner.data.rows.map((r) => [r.categoryId, r.kind]));
  const bills: MonthBill[] = upcoming
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

  return {
    input: {
      today,
      startBalanceCents: inputs.cash.total,
      lowBalanceCents: household.lowBalanceCents,
      income: inputs.sources,
      bills,
      usual: inputs.trends.usual,
      billsInUsual: inputs.confirmed,
      saving,
      plannedCosts: plannedCosts.map((c) => c.input),
      historyStart: history?.first ? monthOf(history.first) : null,
      // The route adds them (from Goals' own progress).
      goals: [],
    },
    hasBalance: inputs.cash.counted > 0,
    hasIncome: inputs.sources.length > 0,
  };
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
      for (const month of lastYear) spendByMonth[month] = spendIn(spendShared, coveredIds, month, month);

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
        },
      };
    });
}
