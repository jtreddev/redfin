import { ledgerEntries, monthActuals, type CategoryKind } from '../../shared/actuals';
import type { Timing } from '../../shared/allocation';
import { SPECIAL } from '../../shared/categorySet';
import {
  addDays,
  addMonths,
  clampDay,
  monthEnd,
  monthOf,
  monthStart,
  type ISODate,
  type MonthKey,
} from '../../shared/dates';
import { latestCharges, type IncreaseCharge } from '../../shared/billIncrease';
import { buildForecast, type Forecast, type ForecastLine } from '../../shared/forecast';
import type { Cents } from '../../shared/money';
import { payDatesBetween, payDatesInMonth } from '../../shared/paySchedule';
import { funMoneyBalance, PRIVACY_SQL } from '../../shared/privacy';
import { nextOccurrence, type Cadence } from '../../shared/recurring';
import { safeToSpend, type SafeToSpend } from '../../shared/safeToSpend';
import { monthWeeks } from '../../shared/weeks';
import type { HouseholdSettings } from '../env';
import { all, first } from '../lib/db';
import { loadCategories, loadIncomeSources, scheduleOf, type IncomeSourceRow } from './context';
import { loadLedger } from './ledger';
import { plannedCostsForMonth } from './plannedCosts';

export interface BudgetRow {
  categoryId: number;
  name: string;
  sectionId: number;
  sectionName: string;
  kind: CategoryKind;
  kidScoped: boolean;
  funMemberId: number | null;
  lineId: number | null;
  budgetCents: Cents;
  timing: Timing;
  dueDay: number | null;
  notes: string | null;
  /** The parent category when this is a sub-category. Its money is also in the parent's actualCents. */
  parentId: number | null;
  /** This category's own money plus its sub-categories'. */
  actualCents: Cents;
  byWeek: Cents[];
  /** This category's own money, without its sub-categories. */
  ownActualCents: Cents;
  ownByWeek: Cents[];
  /**
   * Budget comes from Income & paydays or a fun money allowance rather than a typed line.
   * planned_costs: the hand budget plus this month's planned-cost set-asides (see plannedCostsCents).
   * children: no line of its own; the budget is the sum of its sub-categories' lines.
   */
  computed: 'paychecks' | 'fun_money' | 'planned_costs' | 'children' | null;
  /** The part of budgetCents that is planned-cost set-asides (0 except on Saving › Savings & Planned Costs). */
  plannedCostsCents: Cents;
}

interface LineRow {
  id: number;
  categoryId: number;
  budgetCents: number;
  timing: Timing;
  dueDay: number | null;
  notes: string | null;
}

export interface MonthData {
  month: MonthKey;
  rows: BudgetRow[];
  sources: IncomeSourceRow[];
  uncategorized: { inCents: Cents; outCents: Cents; inByWeek: Cents[]; outByWeek: Cents[]; count: number };
  allowancePayDates: ISODate[];
}

/** Budget vs actual for every category in a month, including computed paycheck and fun money lines. */
export async function loadMonth(db: D1Database, month: MonthKey): Promise<MonthData> {
  const [categories, lines, sources, members, ledger, plannedCostsCents] = await Promise.all([
    loadCategories(db),
    all<LineRow>(
      db,
      `SELECT id, category_id AS categoryId, budget_cents AS budgetCents, timing, due_day AS dueDay, notes
         FROM budget_lines WHERE month = ?`,
      month,
    ),
    loadIncomeSources(db),
    all<{ id: number; funAllowanceCents: number }>(db, 'SELECT id, fun_allowance_cents AS funAllowanceCents FROM members'),
    loadLedger(db, monthStart(month), monthEnd(month)),
    plannedCostsForMonth(db, month),
  ]);

  const actuals = monthActuals(ledgerEntries(ledger), month);
  const weeks = monthWeeks(month);
  const zeros = () => weeks.map(() => 0);
  const lineByCategory = new Map(lines.map((l) => [l.categoryId, l]));
  const allowanceByMember = new Map(members.map((m) => [m.id, m.funAllowanceCents]));

  const allowancePayDates = [
    ...new Set(sources.filter((s) => s.drivesAllowance === 1).flatMap((s) => payDatesInMonth(scheduleOf(s), month))),
  ].sort();
  const paycheckBudget = sources.reduce(
    (total, s) => total + payDatesInMonth(scheduleOf(s), month).length * s.netPayCents,
    0,
  );

  const rows: BudgetRow[] = [];
  // Sub-categories roll up: a parent's actual is its own plus its children's.
  const childrenOf = new Map<number, number[]>();
  for (const c of categories) if (c.parentId != null) childrenOf.set(c.parentId, [...(childrenOf.get(c.parentId) ?? []), c.id]);

  for (const c of categories) {
    const line = lineByCategory.get(c.id);
    const own = actuals.byCategory.get(c.id);
    const children = childrenOf.get(c.id) ?? [];
    const childLines = children.flatMap((id) => lineByCategory.get(id) ?? []);
    let actual = own;
    for (const id of children) {
      const child = actuals.byCategory.get(id);
      if (!child) continue;
      const base = actual ?? { totalCents: 0, byWeek: zeros() };
      actual = { totalCents: base.totalCents + child.totalCents, byWeek: base.byWeek.map((v, i) => v + (child.byWeek[i] ?? 0)) };
    }
    let computed: BudgetRow['computed'] = null;
    let budgetCents = line?.budgetCents ?? 0;
    let timing: Timing = line?.timing ?? 'even';
    let planned = 0;

    if (c.sectionName === SPECIAL.paychecks[0] && c.name === SPECIAL.paychecks[1] && sources.length) {
      computed = 'paychecks';
      // Sub-categories' lines (a planned bonus) stay their own forecast lines, so they add here too.
      budgetCents = paycheckBudget + childLines.reduce((total, l) => total + l.budgetCents, 0);
      timing = 'due_day';
    } else if (c.funMemberId != null && !line) {
      computed = 'fun_money';
      budgetCents = (allowanceByMember.get(c.funMemberId) ?? 0) * allowancePayDates.length;
      timing = 'even';
    } else if (c.sectionName === SPECIAL.savings[0] && c.name === SPECIAL.savings[1] && plannedCostsCents) {
      // Added to the hand budget (other savings), never replacing it.
      computed = 'planned_costs';
      planned = plannedCostsCents;
      // This row is a planned line, so its children aren't: with no hand line, their lines count here.
      if (!line) budgetCents += childLines.reduce((total, l) => total + l.budgetCents, 0);
      budgetCents += planned;
    } else if (!line && childLines.length) {
      // Lines only on sub-categories: the parent shows their sum.
      computed = 'children';
      budgetCents = childLines.reduce((total, l) => total + l.budgetCents, 0);
    }

    if (c.archived && !line && !actual && !childLines.length) continue;
    rows.push({
      categoryId: c.id,
      name: c.name,
      sectionId: c.sectionId,
      sectionName: c.sectionName,
      kind: c.kind,
      kidScoped: c.kidScoped === 1,
      funMemberId: c.funMemberId,
      lineId: line?.id ?? null,
      budgetCents,
      timing,
      dueDay: line?.dueDay ?? null,
      notes: line?.notes ?? null,
      parentId: c.parentId,
      actualCents: actual?.totalCents ?? 0,
      byWeek: actual?.byWeek ?? zeros(),
      ownActualCents: own?.totalCents ?? 0,
      ownByWeek: own?.byWeek ?? zeros(),
      computed,
      plannedCostsCents: planned,
    });
  }

  return {
    month,
    rows,
    sources,
    uncategorized: {
      inCents: actuals.uncategorizedIn.totalCents,
      outCents: actuals.uncategorizedOut.totalCents,
      inByWeek: actuals.uncategorizedIn.byWeek,
      outByWeek: actuals.uncategorizedOut.byWeek,
      count: actuals.uncategorizedCount,
    },
    allowancePayDates,
  };
}

export interface StartingBalance {
  cents: Cents;
  source: 'manual' | 'bank' | 'previous_month' | 'none';
}

/** The accounts that count as cash: shown checking and savings, never cards or loans. */
export const CASH_ACCOUNTS_WHERE = "is_cash = 1 AND hidden = 0 AND type NOT IN ('credit', 'loan')";

/** Cash on day 1: typed in, worked back from bank balances, or carried from last month's forecast. */
async function startingBalance(
  db: D1Database,
  month: MonthKey,
  household: HouseholdSettings,
  today: ISODate,
  depth: number,
): Promise<StartingBalance> {
  const manual = await first<{ cents: number | null }>(
    db,
    'SELECT starting_balance_cents AS cents FROM month_settings WHERE month = ?',
    month,
  );
  if (manual?.cents != null) return { cents: manual.cents, source: 'manual' };

  const currentMonth = monthOf(today);
  if (month === currentMonth) {
    const cash = await first<{ total: number; counted: number }>(
      db,
      `SELECT COALESCE(SUM(current_balance_cents), 0) AS total, COUNT(current_balance_cents) AS counted
         FROM accounts WHERE ${CASH_ACCOUNTS_WHERE}`,
    );
    if (!cash?.counted) return { cents: 0, source: 'none' };
    const movement = await first<{ net: number }>(
      db,
      `SELECT COALESCE(SUM(t.amount_cents), 0) AS net
         FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE a.is_cash = 1 AND a.hidden = 0 AND a.type NOT IN ('credit', 'loan') AND a.current_balance_cents IS NOT NULL
          AND t.deleted_at IS NULL AND t.is_ignored = 0 AND t.pending = 0 AND t.date >= ?`,
      monthStart(month),
    );
    return { cents: cash.total - (movement?.net ?? 0), source: 'bank' };
  }

  if (month > currentMonth && depth < 12) {
    const previous = await buildPlanner(db, addMonths(month, -1), household, today, depth + 1);
    return { cents: previous.forecast.totals.endBalance, source: 'previous_month' };
  }
  return { cents: 0, source: 'none' };
}

export interface Planner {
  month: MonthKey;
  data: MonthData;
  forecast: Forecast;
  safe: SafeToSpend;
  startingBalance: StartingBalance;
}

export async function buildPlanner(
  db: D1Database,
  month: MonthKey,
  household: HouseholdSettings,
  today: ISODate,
  depth = 0,
): Promise<Planner> {
  const [data, received, start] = await Promise.all([
    loadMonth(db, month),
    all<{ sourceId: number; payDate: ISODate }>(
      db,
      `SELECT DISTINCT income_source_id AS sourceId, pay_date AS payDate FROM transactions
        WHERE deleted_at IS NULL AND is_ignored = 0 AND income_source_id IS NOT NULL AND pay_date BETWEEN ? AND ?`,
      monthStart(month),
      monthEnd(month),
    ),
    startingBalance(db, month, household, today, depth),
  ]);

  const weeks = monthWeeks(month);
  const incomeByWeek = weeks.map((_, i) => data.uncategorized.inByWeek[i] ?? 0);
  const outflowByWeek = weeks.map((_, i) => data.uncategorized.outByWeek[i] ?? 0);
  const lines: ForecastLine[] = [];

  // A planned line is a typed budget (or fun money / planned costs); a parent's sum of its children's
  // lines isn't one: those children are lines themselves.
  const isPlanned = (row: BudgetRow) =>
    row.computed !== 'paychecks' && row.computed !== 'children' && (row.lineId !== null || row.budgetCents > 0);
  const rowById = new Map(data.rows.map((r) => [r.categoryId, r]));
  for (const row of data.rows) {
    if (row.kind === 'transfer') continue;
    const parent = row.parentId === null ? undefined : rowById.get(row.parentId);
    // Already counted in the parent's line.
    if (parent && isPlanned(parent)) continue;
    const planned = isPlanned(row);
    if (planned) {
      lines.push({
        id: row.categoryId,
        kind: row.kind === 'income' ? 'income' : 'expense',
        budgetCents: row.budgetCents,
        timing: row.timing,
        dueDay: row.dueDay,
        actualByWeek: row.byWeek,
      });
    } else {
      const target = row.kind === 'income' ? incomeByWeek : outflowByWeek;
      // Its own money only: each sub-category adds its own.
      row.ownByWeek.forEach((v, i) => {
        target[i] = (target[i] ?? 0) + v;
      });
    }
  }

  const receivedBySource = new Map<number, ISODate[]>();
  for (const r of received) receivedBySource.set(r.sourceId, [...(receivedBySource.get(r.sourceId) ?? []), r.payDate]);

  const forecast = buildForecast({
    month,
    today,
    startingBalanceCents: start.cents,
    lowBalanceCents: household.lowBalanceCents,
    paySources: data.sources.map((s) => ({
      id: s.id,
      netPayCents: s.netPayCents,
      schedule: scheduleOf(s),
      receivedPayDates: receivedBySource.get(s.id) ?? [],
    })),
    lines,
    otherActual: { incomeByWeek, outflowByWeek },
  });

  return { month, data, forecast, safe: safeToSpend(forecast, household.lowBalanceCents), startingBalance: start };
}

export interface FunMoneyRow {
  memberId: number;
  name: string;
  color: string;
  allowancePerPaydayCents: Cents;
  accruedCents: Cents;
  spentCents: Cents;
  balanceCents: Cents;
  paydaysCounted: number;
  isViewer: boolean;
  nextPayDate: ISODate | null;
}

export async function funMoneyBalances(
  db: D1Database,
  household: HouseholdSettings,
  today: ISODate,
  viewerId: number,
): Promise<FunMoneyRow[]> {
  const start = household.funMoneyStartDate ?? monthStart(monthOf(today));
  const [members, sources, categories, adjustments] = await Promise.all([
    all<{ id: number; name: string; color: string; funAllowanceCents: number }>(
      db,
      'SELECT id, name, color, fun_allowance_cents AS funAllowanceCents FROM members ORDER BY id',
    ),
    loadIncomeSources(db),
    loadCategories(db),
    all<{ memberId: number; total: number }>(
      db,
      'SELECT member_id AS memberId, SUM(amount_cents) AS total FROM fun_adjustments WHERE date >= ? GROUP BY member_id',
      start,
    ),
  ]);
  const ledger = start <= today ? await loadLedger(db, start, today) : [];
  const entries = ledgerEntries(ledger);

  const allowanceSources = sources.filter((s) => s.drivesAllowance === 1);
  const payDates = [...new Set(allowanceSources.flatMap((s) => payDatesBetween(scheduleOf(s), start, today)))];
  const upcoming = allowanceSources
    .flatMap((s) => payDatesBetween(scheduleOf(s), addDays(today, 1), addDays(today, 31)))
    .sort()[0] ?? null;
  const adjustmentByMember = new Map(adjustments.map((a) => [a.memberId, a.total]));

  return members.map((m) => {
    const funCategory = categories.find((c) => c.funMemberId === m.id)?.id;
    const spentCents = entries
      .filter((e) => e.categoryId === funCategory || e.privateMemberId === m.id)
      .reduce((total, e) => total - e.amountCents, 0);
    const balance = funMoneyBalance({
      allowancePerPaydayCents: m.funAllowanceCents,
      payDates,
      startDate: start,
      today,
      spentCents,
      adjustmentsCents: adjustmentByMember.get(m.id) ?? 0,
    });
    return {
      memberId: m.id,
      name: m.name,
      color: m.color,
      allowancePerPaydayCents: m.funAllowanceCents,
      ...balance,
      isViewer: m.id === viewerId,
      nextPayDate: upcoming,
    };
  });
}

/** A recurring bill's date is left as it is for this many days (it may be late), then rolled forward. */
const STALE_GRACE_DAYS = 3;
/** A charge this many days before a bill's date (or any time after) pays it. */
const PAID_EARLY_DAYS = 5;
/** A charge pays a bill only when it's within this share of the usual amount (a partial payment or another purchase doesn't). */
const PAID_AMOUNT_SLACK = 0.15;

export interface UpcomingBill {
  name: string;
  date: ISODate;
  amountCents: Cents;
  overdue: boolean;
  source: 'budget' | 'recurring';
  categoryId: number | null;
  /** A recurring bill's cadence (budget lines are monthly). */
  cadence?: Cadence;
  /** A recurring bill that is the viewer's own private one. */
  privateMemberId?: number | null;
}

/** A later month's budget rows: its own when it has a budget, otherwise this month's carried forward. */
export async function laterMonthRows(db: D1Database, planner: Planner, month: MonthKey): Promise<readonly BudgetRow[]> {
  const budgeted = await first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM budget_lines WHERE month = ?', month);
  return budgeted?.n ? (await loadMonth(db, month)).rows : planner.data.rows;
}

/** A row that is a planned line of its own (typed, or the planned-costs line), not one counted in its parent's. */
export function ownLineRows(rows: readonly BudgetRow[]): BudgetRow[] {
  const byId = new Map(rows.map((r) => [r.categoryId, r]));
  const hasLine = (r: BudgetRow | undefined) => r !== undefined && (r.lineId !== null || r.computed === 'planned_costs');
  return rows.filter((r) => hasLine(r) && !(r.parentId !== null && hasLine(byId.get(r.parentId))));
}

/**
 * A month's due-day spending lines at their full budget, as bills on their due day: the same lines the
 * forecast counts (no income, paychecks or fun money; a sub-category whose parent has a line is in the parent).
 * Planned-cost set-asides stay in the account (P6-R5), so a savings line counts only its hand part.
 */
function dueDayLines(rows: readonly BudgetRow[], month: MonthKey): UpcomingBill[] {
  return ownLineRows(rows)
    .filter((r) => r.timing === 'due_day' && r.dueDay != null && r.kind !== 'income' && r.kind !== 'transfer' && r.funMemberId == null)
    .filter((r) => r.budgetCents - r.plannedCostsCents > 0)
    .map((r) => ({
      name: r.name,
      date: clampDay(month, r.dueDay!),
      amountCents: r.budgetCents - r.plannedCostsCents,
      overdue: false,
      source: 'budget',
      categoryId: r.categoryId,
    }));
}

/**
 * Due-day budget lines not yet paid this month, plus confirmed recurring bills coming up. The horizon is a
 * number of days from today, or `until` a date; with `repeat`, a recurring bill shows every time it comes up
 * before then (weekly ones more than once), not only next time.
 *
 * A recurring bill already charged (a matching charge since 5 days before its date) shows its next date.
 *
 * With `until` in a later month, that month's due-day lines come too (P6-R3b): from its budget, or, when it
 * has none yet, this month's lines carried forward at their full amount. A confirmed bill in the same
 * category (or a sub-category of it) that month takes the line's place.
 */
export async function upcomingBills(
  db: D1Database,
  planner: Planner,
  today: ISODate,
  viewerId: number,
  horizon:
    | number
    | {
        until: ISODate;
        repeat?: boolean;
        laterMonths?: boolean;
        /** A later month's rows, for a caller that needs them too (default: laterMonthRows). */
        monthRows?: (month: MonthKey) => Promise<readonly BudgetRow[]>;
      } = 21,
): Promise<UpcomingBill[]> {
  const bills: UpcomingBill[] = [];
  for (const row of planner.data.rows) {
    if (row.timing !== 'due_day' || row.dueDay == null || row.kind === 'income') continue;
    if (row.computed === 'paychecks' || row.computed === 'fun_money') continue;
    const remaining = (planner.forecast.remainingByLine.get(row.categoryId) ?? []).reduce((a, b) => a + b, 0);
    if (remaining <= 0) continue;
    const date = clampDay(planner.month, row.dueDay);
    bills.push({ name: row.name, date, amountCents: remaining, overdue: date < today, source: 'budget', categoryId: row.categoryId });
  }

  // Every visible confirmed bill takes part in matching (as for "bill went up"), so a charge goes to the same
  // bill; only those with a next date come up. Charges since today − 8 are enough: after the roll below, a
  // past occurrence is at most 3 days old, and a charge up to 5 days before it counts.
  const [recurring, charges] = await Promise.all([
    all<{ id: number; merchant: string; name: string; nextDate: ISODate | null; cadence: Cadence; expectedAmountCents: number; categoryId: number | null; privateMemberId: number | null }>(
      db,
      `SELECT id, merchant, name, next_date AS nextDate, cadence, expected_amount_cents AS expectedAmountCents, category_id AS categoryId,
              private_member_id AS privateMemberId
         FROM recurring_bills
        WHERE status = 'confirmed' AND (private_member_id IS NULL OR private_member_id = ?)`,
      viewerId,
    ),
    all<IncreaseCharge>(
      db,
      `SELECT t.id, t.date, COALESCE(t.normalized_merchant, t.name) AS merchant, t.amount_cents AS amountCents,
              t.private_member_id AS privateMemberId
         FROM transactions t
        WHERE t.amount_cents < 0 AND t.deleted_at IS NULL AND t.pending = 0 AND t.date >= ? AND ${PRIVACY_SQL}`,
      addDays(today, -(STALE_GRACE_DAYS + PAID_EARLY_DAYS)),
      viewerId,
    ),
  ]);
  const lastCharge = latestCharges(recurring, charges);
  const until = typeof horizon === 'number' ? addDays(today, horizon) : horizon.until;
  const repeat = typeof horizon !== 'number' && horizon.repeat === true;
  // A sub-category's bill is covered by its parent's line too (the line counts the child's money).
  const parentOf = new Map(planner.data.rows.map((r) => [r.categoryId, r.parentId]));
  const lineCategories = (categoryId: number | null): number[] => {
    const parentId = categoryId == null ? null : (parentOf.get(categoryId) ?? null);
    return categoryId == null ? [] : parentId == null ? [categoryId] : [categoryId, parentId];
  };
  const budgetCategories = new Set(bills.map((b) => b.categoryId));
  for (const r of recurring) {
    if (r.nextDate == null) continue;
    let date = r.nextDate;
    // Roll stale dates forward (the charge probably happened; detection refreshes it later).
    for (let guard = 0; date < addDays(today, -STALE_GRACE_DAYS) && guard < 60; guard++) date = nextOccurrence(date, r.cadence);
    // A date today or earlier with a matching charge since (or up to 5 days before it) is paid: the next one is due.
    const paid = lastCharge.get(r.id);
    const usual = Math.abs(r.expectedAmountCents);
    const paidOn = paid && Math.abs(Math.abs(paid.amountCents) - usual) <= usual * PAID_AMOUNT_SLACK ? paid.date : undefined;
    for (let guard = 0; date <= today && paidOn !== undefined && paidOn >= addDays(date, -PAID_EARLY_DAYS) && guard < 60; guard++) {
      date = nextOccurrence(date, r.cadence);
    }
    for (let guard = 0; date <= until && guard < 60; guard++, date = nextOccurrence(date, r.cadence)) {
      if (!(lineCategories(r.categoryId).some((id) => budgetCategories.has(id)) && monthOf(date) === planner.month)) {
        bills.push({
          name: r.name,
          date,
          amountCents: Math.abs(r.expectedAmountCents),
          overdue: date < today,
          source: 'recurring',
          categoryId: r.categoryId,
          cadence: r.cadence,
          privateMemberId: r.privateMemberId,
        });
      }
      if (!repeat) break;
    }
  }

  if (typeof horizon !== 'number' && horizon.laterMonths) {
    for (let month = addMonths(planner.month, 1); month <= monthOf(until); month = addMonths(month, 1)) {
      const rows = await (horizon.monthRows ?? ((m: MonthKey) => laterMonthRows(db, planner, m)))(month);
      const billed = new Set<number | null>(bills.filter((b) => b.source === 'recurring' && monthOf(b.date) === month).flatMap((b) => lineCategories(b.categoryId)));
      for (const line of dueDayLines(rows, month)) {
        if (line.date <= until && !billed.has(line.categoryId)) bills.push(line);
      }
    }
  }
  return bills.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.amountCents - a.amountCents));
}

/** Forecast as plain JSON (Maps don't serialize). */
export function forecastJson(forecast: Forecast) {
  return {
    ...forecast,
    remainingByLine: Object.fromEntries(forecast.remainingByLine),
  };
}
