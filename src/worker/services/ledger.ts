import type { CategoryKind, LedgerSplit, LedgerTxn } from '../../shared/actuals';
import type { ISODate } from '../../shared/dates';
import { all } from '../lib/db';

interface TxnRow {
  id: number;
  date: ISODate;
  amountCents: number;
  categoryId: number | null;
  categoryKind: CategoryKind | null;
  kidId: number | null;
  privateMemberId: number | null;
  transferPairId: number | null;
  isIgnored: number;
  isSplit: number;
}

interface SplitRow extends LedgerSplit {
  transactionId: number;
}

/** All transactions in a date range, shaped for budget math (splits attached). */
export async function loadLedger(db: D1Database, from: ISODate, to: ISODate): Promise<LedgerTxn[]> {
  const [txns, splits] = await Promise.all([
    all<TxnRow>(
      db,
      `SELECT t.id, t.date, t.amount_cents AS amountCents, t.category_id AS categoryId, c.kind AS categoryKind,
              t.kid_id AS kidId, t.private_member_id AS privateMemberId, t.transfer_pair_id AS transferPairId,
              t.is_ignored AS isIgnored, t.is_split AS isSplit
         FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.deleted_at IS NULL AND t.date BETWEEN ? AND ?`,
      from,
      to,
    ),
    all<SplitRow>(
      db,
      `SELECT s.transaction_id AS transactionId, s.category_id AS categoryId, c.kind AS categoryKind,
              s.kid_id AS kidId, s.amount_cents AS amountCents
         FROM splits s
         JOIN transactions t ON t.id = s.transaction_id
         LEFT JOIN categories c ON c.id = s.category_id
        WHERE t.deleted_at IS NULL AND t.is_split = 1 AND t.date BETWEEN ? AND ?`,
      from,
      to,
    ),
  ]);

  const splitsByTxn = new Map<number, LedgerSplit[]>();
  for (const s of splits) {
    const list = splitsByTxn.get(s.transactionId) ?? [];
    list.push({ categoryId: s.categoryId, categoryKind: s.categoryKind, kidId: s.kidId, amountCents: s.amountCents });
    splitsByTxn.set(s.transactionId, list);
  }

  return txns.map((t) => ({
    id: t.id,
    date: t.date,
    amountCents: t.amountCents,
    categoryId: t.categoryId,
    categoryKind: t.categoryKind,
    kidId: t.kidId,
    privateMemberId: t.privateMemberId,
    transferPairId: t.transferPairId,
    isIgnored: t.isIgnored === 1,
    ...(t.isSplit === 1 ? { splits: splitsByTxn.get(t.id) ?? [] } : {}),
  }));
}
