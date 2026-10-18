import { addDays, monthOf, type ISODate } from '../../shared/dates';
import type { Cents } from '../../shared/money';
import type { PaydaySource } from '../../shared/projection';
import type { Cadence } from '../../shared/recurring';
import { buildTrends, GROUP_ORDER, type GroupKey, type Trends, type TrendsInput } from '../../shared/trends';
import type { HouseholdSettings } from '../env';
import { all, first } from '../lib/db';
import { loadIncomeSources, scheduleOf } from './context';
import { buildPlanner, CASH_ACCOUNTS_WHERE, type Planner, type UpcomingBill } from './planner';
import { loadTrendsInput, monthsBack } from './trends';

/** A confirmed bill with a next date, with the spending group its usual amount sits in. */
export interface ConfirmedBill {
  categoryId: number;
  cadence: Cadence;
  amountCents: Cents;
  privateMemberId: number | null;
  /** The viewer's private bills are in fun, where Trends counts private charges. */
  group: GroupKey | null;
}

export interface ForecastInputs {
  cash: { total: Cents; counted: number };
  /** Active income sources, with the paydays (tomorrow to `payUntil`) whose deposit already came in. */
  sources: PaydaySource[];
  planner: Planner;
  trendsInput: TrendsInput;
  trends: Trends;
  /** The viewer's visible confirmed bills (a partner's private ones are left out). */
  confirmed: ConfirmedBill[];
  /** Planned-cost set-asides on this month's savings line, by category: they stay in the account (P6-R5). */
  setAside: Map<number, Cents>;
}

/**
 * What both forecasts start from: today's cash, the paydays, this month's planner, the usual spending (from
 * `trendsMonths` months of ledger, the current one included) and the confirmed bills the viewer can see.
 */
export async function loadForecastInputs(
  db: D1Database,
  today: ISODate,
  viewerId: number,
  household: HouseholdSettings,
  opts: { payUntil: ISODate; trendsMonths: number },
): Promise<ForecastInputs> {
  const [cash, sources, received, planner, trendsInput, confirmed] = await Promise.all([
    first<{ total: number; counted: number }>(
      db,
      `SELECT COALESCE(SUM(current_balance_cents), 0) AS total, COUNT(current_balance_cents) AS counted FROM accounts WHERE ${CASH_ACCOUNTS_WHERE}`,
    ),
    loadIncomeSources(db),
    all<{ sourceId: number; payDate: string }>(
      db,
      `SELECT DISTINCT income_source_id AS sourceId, pay_date AS payDate FROM transactions
        WHERE deleted_at IS NULL AND is_ignored = 0 AND income_source_id IS NOT NULL AND pay_date BETWEEN ? AND ?`,
      addDays(today, 1),
      opts.payUntil,
    ),
    buildPlanner(db, monthOf(today), household, today),
    loadTrendsInput(db, monthsBack(today, opts.trendsMonths), today),
    all<{ categoryId: number; cadence: Cadence; amountCents: number; privateMemberId: number | null }>(
      db,
      `SELECT category_id AS categoryId, cadence, expected_amount_cents AS amountCents, private_member_id AS privateMemberId
         FROM recurring_bills
        WHERE status = 'confirmed' AND category_id IS NOT NULL AND next_date IS NOT NULL
          AND (private_member_id IS NULL OR private_member_id = ?)`,
      viewerId,
    ),
  ]);

  const groupOf = new Map(GROUP_ORDER.map((g) => [g.section, g.key]));
  const sectionOf = new Map(trendsInput.categories.map((c) => [c.id, c.section]));
  return {
    cash: { total: cash?.total ?? 0, counted: cash?.counted ?? 0 },
    sources: sources.map((s) => ({
      name: s.name,
      netPayCents: s.netPayCents,
      schedule: scheduleOf(s),
      receivedPayDates: received.filter((r) => r.sourceId === s.id).map((r) => r.payDate),
    })),
    planner,
    trendsInput,
    trends: buildTrends(trendsInput),
    confirmed: confirmed.map((b) => ({
      ...b,
      group: b.privateMemberId !== null ? 'fun' : (groupOf.get(sectionOf.get(b.categoryId) ?? '') ?? null),
    })),
    setAside: new Map(planner.data.rows.filter((r) => r.plannedCostsCents > 0).map((r) => [r.categoryId, r.plannedCostsCents])),
  };
}

/**
 * A bill's amount less its set-aside: a due-day savings line this month counts only its hand part (P6-R5).
 * Later months' lines already come without them.
 */
export function withoutSetAside(bill: UpcomingBill, inputs: Pick<ForecastInputs, 'planner' | 'setAside'>): Cents {
  const own =
    bill.source === 'budget' && bill.categoryId !== null && monthOf(bill.date) === inputs.planner.month ? (inputs.setAside.get(bill.categoryId) ?? 0) : 0;
  return Math.max(0, bill.amountCents - own);
}
