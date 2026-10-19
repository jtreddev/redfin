import { addMonths, monthOf, monthStart, type ISODate, type MonthKey } from '../../shared/dates';
import { estimatedMinimum } from '../../shared/debt';
import type { Cents } from '../../shared/money';
import { cardPaidInFull, type AheadDebt, type DebtKind } from '../../shared/planAhead';
import { all, nowIso, stmt } from '../lib/db';
import type { UpcomingBill } from './planner';

/** estimatedMinimum in SQL, for a balance expression and the debt's rate. Keep the two in step. */
export const estimatedMinimumSql = (balance: string, apr = 'apr_percent') =>
  `CASE WHEN ${balance} <= 0 THEN 0 ELSE MIN(${balance}, MAX(2500, CAST(ROUND(${balance} * 0.01) AS INTEGER) + CAST(ROUND(${balance} * ${apr} / 1200.0) AS INTEGER))) END`;

/** A debt's balance (alias d) from its linked account (alias a), made positive: money the bank owes you isn't debt. */
export const LIVE_BALANCE = 'CASE WHEN a.current_balance_cents IS NULL THEN d.balance_cents ELSE MAX(0, a.current_balance_cents) END';
/** A debt's minimum, its estimate following the live balance. */
export const LIVE_MINIMUM = `CASE WHEN d.min_estimated = 1 THEN ${estimatedMinimumSql(LIVE_BALANCE, 'd.apr_percent')} ELSE d.min_payment_cents END`;

/**
 * Stores each debt's balance from its account and its estimated minimum (they're read live, so this keeps the
 * stored copies, as exported, in step after a Plaid sync). Only rows that change are written.
 */
function refreshStatement(db: D1Database): D1PreparedStatement {
  const estimate = estimatedMinimumSql('s.b', 'debts.apr_percent');
  return stmt(
    db,
    `UPDATE debts SET balance_cents = s.b,
            min_payment_cents = CASE WHEN debts.min_estimated = 1 THEN ${estimate} ELSE debts.min_payment_cents END,
            updated_at = ?
       FROM (SELECT d.id, ${LIVE_BALANCE} AS b FROM debts d LEFT JOIN accounts a ON a.id = d.account_id) s
      WHERE s.id = debts.id AND (debts.balance_cents <> s.b OR (debts.min_estimated = 1 AND debts.min_payment_cents <> ${estimate}))`,
    nowIso(),
  );
}

/**
 * Auto-link: each shown credit card and loan account gets one debt, linked by account_id: an unlinked debt of
 * the same name, or a new one (source 'plaid'). A linked card is checked once for "paid in full" (P7-R7): when
 * it's linked, or on the first load for one linked before Plan › Ahead; never after the user sets it.
 * Idempotent and safe when two loads run at once: the link and the insert each check, in the same statement,
 * that no debt has the account yet. One query when nothing is new or unchecked, two to four when something is,
 * however many accounts (D1's 50 a request). `refresh` also stores every balance (after a sync).
 */
export async function linkDebts(db: D1Database, today: ISODate, { refresh = false } = {}): Promise<void> {
  const current = monthOf(today);
  // Accounts with no debt yet, and cards whose debt was never checked for paid in full.
  const accounts = await all<{ id: number; name: string; type: 'credit' | 'loan'; balanceCents: number | null; recent: string; debtId: number | null }>(
    db,
    `SELECT a.id, a.name, a.type, a.current_balance_cents AS balanceCents, d.id AS debtId,
            (SELECT json_group_array(json_array(substr(t.date, 1, 7), t.amount_cents)) FROM transactions t
              WHERE t.account_id = a.id AND t.deleted_at IS NULL AND t.pending = 0 AND t.date BETWEEN ? AND ?) AS recent
       FROM accounts a LEFT JOIN debts d ON d.account_id = a.id
      WHERE a.type IN ('credit', 'loan') AND a.hidden = 0 AND (d.id IS NULL OR (a.type = 'credit' AND d.paid_in_full_checked = 0))
      ORDER BY a.id`,
    monthStart(addMonths(current, -4)),
    // Through today: this month's charges so far count toward the balance check.
    today,
  );
  if (!accounts.length) {
    if (refresh) await refreshStatement(db).run();
    return;
  }

  const rows = accounts.map((a) => {
    const byMonth: Record<MonthKey, { paidCents: Cents; chargedCents: Cents }> = {};
    for (const [month, cents] of JSON.parse(a.recent) as [MonthKey, Cents][]) {
      const m = (byMonth[month] ??= { paidCents: 0, chargedCents: 0 });
      if (cents > 0) m.paidCents += cents;
      else m.chargedCents -= cents;
    }
    const balance = Math.max(0, a.balanceCents ?? 0);
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      balance,
      min: estimatedMinimum(balance, 0),
      kind: a.type === 'credit' ? 'credit_card' : 'other',
      paidInFull: a.type === 'credit' && cardPaidInFull(byMonth, today, a.balanceCents ?? 0) ? 1 : 0,
    };
  });
  const unchecked = rows.filter((_, i) => accounts[i]!.debtId !== null);
  const json = JSON.stringify(rows.filter((_, i) => accounts[i]!.debtId === null));
  const checks = JSON.stringify(rows.flatMap((r, i) => (accounts[i]!.debtId === null ? [] : [{ id: accounts[i]!.debtId, paidInFull: r.paidInFull }])));
  const candidates = `(SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.name') AS name, json_extract(value, '$.type') AS type,
                              json_extract(value, '$.balance') AS balance, json_extract(value, '$.min') AS min,
                              json_extract(value, '$.kind') AS kind, json_extract(value, '$.paidInFull') AS paidInFull
                         FROM json_each(?))`;
  const linking = rows.length > unchecked.length;
  await db.batch([
    // A card linked before: checked once, unless the user has set it meanwhile.
    ...(unchecked.length
      ? [
          stmt(
            db,
            `UPDATE debts SET paid_in_full = j.paidInFull, paid_in_full_checked = 1, updated_at = ?
               FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.paidInFull') AS paidInFull FROM json_each(?)) j
              WHERE debts.id = j.id AND debts.paid_in_full_checked = 0`,
            nowIso(),
            checks,
          ),
        ]
      : []),
    ...(linking ? linkStatements(db, json, candidates) : []),
    ...(refresh ? [refreshStatement(db)] : []),
  ]);
}

/** Link by name, then insert, the accounts in `json` (see linkDebts). */
function linkStatements(db: D1Database, json: string, candidates: string): D1PreparedStatement[] {
  return [
    // An unlinked debt of the same name takes the account (and its balance).
    stmt(
      db,
      `UPDATE debts SET account_id = j.id, balance_cents = j.balance, paid_in_full = j.paidInFull, updated_at = ?,
              paid_in_full_checked = CASE WHEN j.type = 'credit' THEN 1 ELSE debts.paid_in_full_checked END,
              kind = CASE WHEN j.type = 'credit' AND debts.kind = 'other' THEN 'credit_card' ELSE debts.kind END
         FROM ${candidates} j
        WHERE debts.id = (SELECT d.id FROM debts d WHERE d.account_id IS NULL AND d.archived = 0 AND lower(d.name) = lower(j.name) ORDER BY d.id LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM debts d WHERE d.account_id = j.id)`,
      nowIso(),
      json,
    ),
    stmt(
      db,
      `INSERT INTO debts (name, account_id, balance_cents, min_payment_cents, min_estimated, source, kind, paid_in_full, paid_in_full_checked)
       SELECT j.name, j.id, j.balance, j.min, 1, 'plaid', j.kind, j.paidInFull, j.type = 'credit' FROM ${candidates} j
        WHERE NOT EXISTS (SELECT 1 FROM debts d WHERE d.account_id = j.id)`,
      json,
    ),
  ];
}

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
  /** Our estimate ("estimated" until edited). */
  minEstimated: boolean;
  dueDay: number | null;
  extraCents: Cents;
  sort: number;
  paidInFull: boolean;
  endMonth: MonthKey | null;
  /** The linked bill, when the viewer may see it. */
  billId: number | null;
  billName: string | null;
  /** The linked bill is confirmed: its charges count the minimum. */
  billConfirmed: boolean;
  categoryId: number | null;
  categoryName: string | null;
  /** When a hand-kept balance was last typed in. */
  balanceAsOf: ISODate | null;
  /** A confirmed bill whose name or merchant matches the debt's or its account's: shown, never applied. */
  suggestedBillId: number | null;
  suggestedBillName: string | null;
  updatedAt: string;
}

/** A visible confirmed bill matching a debt (d) or its account (a) by name or merchant. */
const SUGGESTED_BILL = (column: string) => `(SELECT r.${column} FROM recurring_bills r
   WHERE d.bill_id IS NULL AND r.status = 'confirmed' AND (r.private_member_id IS NULL OR r.private_member_id = ?)
     AND (instr(lower(r.name), lower(d.name)) > 0 OR instr(lower(d.name), lower(r.name)) > 0
          OR (length(r.merchant) >= 3 AND instr(lower(d.name), lower(r.merchant)) > 0)
          OR (a.name IS NOT NULL AND (instr(lower(r.name), lower(a.name)) > 0 OR (length(r.merchant) >= 3 AND instr(lower(a.name), lower(r.merchant)) > 0))))
   ORDER BY r.id LIMIT 1)`;

/**
 * The household's debts (not archived) as the viewer may see them: a partner's private bill isn't named. A linked
 * debt's balance is its account's now, and an estimated minimum follows it.
 */
export async function loadDebts(db: D1Database, viewerId: number): Promise<DebtRow[]> {
  const rows = await all<Omit<DebtRow, 'minEstimated' | 'paidInFull' | 'billConfirmed'> & { minEstimated: number; paidInFull: number; billConfirmed: number | null }>(
    db,
    `SELECT d.id, d.name, d.kind, d.account_id AS accountId, a.name AS accountName, d.source, ${LIVE_BALANCE} AS balanceCents,
            d.apr_percent AS aprPercent, d.min_estimated AS minEstimated, d.due_day AS dueDay,
            ${LIVE_MINIMUM} AS minPaymentCents,
            d.extra_cents AS extraCents, d.sort, d.paid_in_full AS paidInFull, d.end_month AS endMonth,
            b.id AS billId, b.name AS billName, b.status = 'confirmed' AS billConfirmed,
            d.category_id AS categoryId, c.name AS categoryName, d.balance_as_of AS balanceAsOf, d.updated_at AS updatedAt,
            ${SUGGESTED_BILL('id')} AS suggestedBillId, ${SUGGESTED_BILL('name')} AS suggestedBillName
       FROM debts d
       LEFT JOIN accounts a ON a.id = d.account_id
       LEFT JOIN recurring_bills b ON b.id = d.bill_id AND (b.private_member_id IS NULL OR b.private_member_id = ?)
       LEFT JOIN categories c ON c.id = d.category_id
      WHERE d.archived = 0
      ORDER BY d.sort, d.id`,
    viewerId,
    viewerId,
    viewerId,
  );
  return rows.map((r) => ({ ...r, minEstimated: r.minEstimated === 1, paidInFull: r.paidInFull === 1, billConfirmed: r.billConfirmed === 1 }));
}

/** Its payment is counted elsewhere: a confirmed bill the viewer sees, or its category's budget line (P7-R8). */
export const isCovered = (d: Pick<DebtRow, 'billId' | 'billConfirmed' | 'categoryId'>) => (d.billId !== null && d.billConfirmed) || d.categoryId !== null;

/** Debts that take part in payoff: not paid in full, with a balance. */
export const inPayoff = (d: Pick<DebtRow, 'paidInFull' | 'balanceCents'>) => !d.paidInFull && d.balanceCents > 0;

export function aheadDebt(d: DebtRow): AheadDebt {
  return {
    id: d.id,
    name: d.name,
    kind: d.kind,
    balanceCents: d.balanceCents,
    aprPercent: d.aprPercent,
    minPaymentCents: d.minPaymentCents,
    dueDay: d.dueDay,
    endMonth: d.endMonth,
    paidInFull: d.paidInFull,
    sort: d.sort,
    covered: isCovered(d),
  };
}

/**
 * From next month the saved plan owns some money (P7-R8): a payoff debt's linked bill, the bills and due-day
 * lines in its category (or a sub-category), and the lines of goals in `goalCategories`. True for a bill or line
 * the plan counts instead, so callers drop it. This month is left as it is.
 */
export function takenByPlan(
  debts: readonly DebtRow[],
  parentOf: ReadonlyMap<number, number | null>,
  current: MonthKey,
  goalCategories: ReadonlySet<number> = new Set(),
): (bill: Pick<UpcomingBill, 'date' | 'billId' | 'categoryId' | 'source'>) => boolean {
  const payoff = debts.filter(inPayoff);
  const bills = new Set(payoff.flatMap((d) => (d.billId !== null && d.billConfirmed ? [d.billId] : [])));
  const categories = new Set(payoff.flatMap((d) => (d.categoryId === null ? [] : [d.categoryId])));
  const inDebtCategory = (id: number) => categories.has(id) || categories.has(parentOf.get(id) ?? -1);
  return (b) =>
    monthOf(b.date) > current &&
    ((b.billId !== undefined && bills.has(b.billId)) ||
      (b.categoryId !== null && (inDebtCategory(b.categoryId) || (b.source === 'budget' && goalCategories.has(b.categoryId)))));
}

/** The categories whose money is a payoff debt's (left out of "other bills"). */
export const debtCategoryIds = (debts: readonly DebtRow[]) => debts.filter(inPayoff).flatMap((d) => (d.categoryId === null ? [] : [d.categoryId]));
