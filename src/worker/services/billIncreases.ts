import { billIncreases, INCREASE_WINDOW_DAYS, type IncreaseBill, type IncreaseCharge } from '../../shared/billIncrease';
import { addDays, type ISODate } from '../../shared/dates';
import { PRIVACY_SQL } from '../../shared/privacy';
import { all } from '../lib/db';

/**
 * "Bill went up" for the confirmed bills this person can see (R17), with each bill's name. Two queries: the
 * bills, and the last 45 days of charges out (the same filters as marking a bill by hand).
 */
export async function loadBillIncreases(db: D1Database, today: ISODate, viewerId: number, billId?: number) {
  const [bills, charges] = await Promise.all([
    all<IncreaseBill & { name: string }>(
      db,
      `SELECT id, merchant, name, expected_amount_cents AS expectedAmountCents, increase_seen_cents AS increaseSeenCents,
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
      addDays(today, -INCREASE_WINDOW_DAYS),
      viewerId,
    ),
  ]);
  const names = new Map(bills.map((b) => [b.id, b.name]));
  // All of the bills take part even for one, so a charge still goes to the closest bill from its merchant.
  return billIncreases(bills, charges)
    .filter((i) => billId === undefined || i.billId === billId)
    .map((i) => ({ billId: i.billId, name: names.get(i.billId) ?? '', usualCents: i.usualCents, latestCents: i.latestCents, date: i.date }));
}
