import { addDays, type ISODate } from '../../shared/dates';
import { findTransferPairs, pairKey, type TransferCandidate } from '../../shared/transfers';
import { all, batchAll, nowIso, stmt } from '../lib/db';
import type { IngestContext } from './context';
import { rederive } from './ingest';

/**
 * Pairs up transfers between your own accounts in a date range. Paychecks and rows a
 * person (or their rule) filed as ordinary spending or income are never paired; a category
 * the automatic layers picked (the bank calling a card payment "shopping") doesn't stop a pair,
 * and both halves are then re-sorted (see classify).
 */
export async function matchTransfers(db: D1Database, from: ISODate, to: ISODate, ctx?: IngestContext): Promise<number> {
  const candidates = await all<TransferCandidate>(
    db,
    `SELECT t.id, t.account_id AS accountId, t.date, t.amount_cents AS amountCents, t.name,
            t.plaid_category AS plaidCategory
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.date BETWEEN ? AND ?
        AND t.deleted_at IS NULL AND t.is_ignored = 0 AND t.pending = 0
        AND t.transfer_pair_id IS NULL AND t.income_source_id IS NULL AND t.is_split = 0
        AND (c.kind IS NULL OR c.kind IN ('transfer', 'savings', 'debt')
             OR (t.category_source = 'auto' AND t.private_member_id IS NULL))`,
    addDays(from, -3),
    addDays(to, 3),
  );
  if (candidates.length < 2) return 0;

  const unlinks = await all<{ a: number; b: number }>(db, 'SELECT a_id AS a, b_id AS b FROM transfer_unlinks');
  const pairs = findTransferPairs(candidates, { unlinked: new Set(unlinks.map((u) => pairKey(u.a, u.b))) });

  const now = nowIso();
  await batchAll(
    db,
    pairs.flatMap((p) => [
      stmt(db, 'UPDATE transactions SET transfer_pair_id = ?, updated_at = ? WHERE id = ?', p.inId, now, p.outId),
      stmt(db, 'UPDATE transactions SET transfer_pair_id = ?, updated_at = ? WHERE id = ?', p.outId, now, p.inId),
    ]),
  );
  await rederive(db, pairs.flatMap((p) => [p.outId, p.inId]), ctx);
  return pairs.length;
}
