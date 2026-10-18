import { Hono } from 'hono';
import { monthEnd, monthStart } from '../../shared/dates';
import { PRIVACY_SQL } from '../../shared/privacy';
import type { AppEnv } from '../env';
import { all, allByIds, batchAll, first, nowIso, run, stmt, type Param } from '../lib/db';
import {
  badRequest,
  HttpError,
  notFound,
  optBool,
  optDate,
  optInt,
  optStr,
  paramId,
  readBody,
  reqDate,
  reqInt,
  reqMonth,
  reqStr,
} from '../lib/http';
import { loadIngestContext, type IngestContext } from '../services/context';
import { enforceFunMoney, insertTransactions, STORED_SELECT, type Classification, type StoredTxn } from '../services/ingest';
import { learnFromFix, undoMove } from '../services/learn';

export const transactions = new Hono<AppEnv>();

export const TXN_SELECT = `SELECT t.id, t.account_id AS accountId, a.name AS accountName, a.type AS accountType,
  a.institution, t.date, t.amount_cents AS amountCents, t.name, t.merchant_name AS merchantName, t.memo, t.pending,
  t.source, t.category_id AS categoryId, t.category_source AS categorySource, t.kid_id AS kidId,
  t.private_member_id AS privateMemberId, t.income_source_id AS incomeSourceId, t.pay_date AS payDate, t.notes,
  t.category_reason AS categoryReason, t.transfer_pair_id AS transferPairId, t.is_ignored AS isIgnored, t.is_split AS isSplit,
  t.import_batch_id AS importBatchId, t.updated_at AS updatedAt
  FROM transactions t JOIN accounts a ON a.id = t.account_id`;

export interface TxnRow {
  id: number;
  accountId: number;
  accountName: string;
  accountType: string;
  institution: string | null;
  date: string;
  amountCents: number;
  name: string;
  merchantName: string | null;
  memo: string | null;
  pending: number;
  source: 'plaid' | 'import' | 'manual';
  categoryId: number | null;
  categorySource: Classification['categorySource'];
  categoryReason: string | null;
  kidId: number | null;
  privateMemberId: number | null;
  incomeSourceId: number | null;
  payDate: string | null;
  notes: string | null;
  transferPairId: number | null;
  isIgnored: number;
  isSplit: number;
  importBatchId: number | null;
  updatedAt: string;
}

interface SplitRow {
  id: number;
  transactionId: number;
  categoryId: number | null;
  kidId: number | null;
  amountCents: number;
  notes: string | null;
}

export function toApi(row: TxnRow, splits: SplitRow[] = []) {
  return {
    ...row,
    pending: row.pending === 1,
    isIgnored: row.isIgnored === 1,
    isSplit: row.isSplit === 1,
    isPrivate: row.privateMemberId !== null,
    splits: row.isSplit === 1 ? splits.filter((s) => s.transactionId === row.id) : [],
  };
}

async function loadSplits(db: D1Database, ids: number[]): Promise<SplitRow[]> {
  if (!ids.length) return [];
  return allByIds<SplitRow>(
    db,
    (list) => `SELECT id, transaction_id AS transactionId, category_id AS categoryId, kid_id AS kidId,
                      amount_cents AS amountCents, notes FROM splits WHERE transaction_id IN (${list}) ORDER BY id`,
    ids,
  );
}

export async function visibleTxn(db: D1Database, id: number, viewerId: number): Promise<TxnRow> {
  const row = await first<TxnRow>(db, `${TXN_SELECT} WHERE t.id = ? AND t.deleted_at IS NULL AND ${PRIVACY_SQL}`, id, viewerId);
  if (!row) throw notFound('Transaction not found');
  return row;
}

/** You can't file something under your spouse's fun money (it would vanish from your view). */
function assertCategoryAllowed(ctx: IngestContext, categoryId: number | null, viewerId: number) {
  if (categoryId === null) return;
  const owner = ctx.funCategoryOwner.get(categoryId);
  if (owner !== undefined && owner !== viewerId) throw new HttpError(403, 'That’s your partner’s fun money category.');
}

transactions.get('/transactions', async (c) => {
  const db = c.env.DB;
  const q = c.req.query();
  const viewer = c.get('viewer');
  const where = ['t.deleted_at IS NULL', PRIVACY_SQL];
  const params: Param[] = [viewer.memberId];

  if (q.month) {
    const month = reqMonth(q.month);
    where.push('t.date BETWEEN ? AND ?');
    params.push(monthStart(month), monthEnd(month));
  }
  if (q.from) {
    where.push('t.date >= ?');
    params.push(reqDate(q.from, 'from'));
  }
  if (q.to) {
    where.push('t.date <= ?');
    params.push(reqDate(q.to, 'to'));
  }
  if (q.accountId) {
    where.push('t.account_id = ?');
    params.push(reqInt(q.accountId, 'accountId'));
  }
  if (q.categoryId) {
    const id = reqInt(q.categoryId, 'categoryId');
    where.push('(t.category_id = ? OR EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id = t.id AND s.category_id = ?))');
    params.push(id, id);
  }
  if (q.kidId) {
    const id = reqInt(q.kidId, 'kidId');
    where.push('(t.kid_id = ? OR EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id = t.id AND s.kid_id = ?))');
    params.push(id, id);
  }
  if (q.importBatchId) {
    where.push('t.import_batch_id = ?');
    params.push(reqInt(q.importBatchId, 'importBatchId'));
  }
  if (q.uncategorized === '1') {
    where.push('t.category_id IS NULL AND t.is_split = 0 AND t.is_ignored = 0 AND t.transfer_pair_id IS NULL');
  }
  if (q.private === '1') {
    where.push('t.private_member_id = ?');
    params.push(viewer.memberId);
  }
  if (q.q) {
    const like = `%${q.q.replace(/[%_]/g, '').slice(0, 60)}%`;
    where.push('(t.name LIKE ? OR t.merchant_name LIKE ? OR t.notes LIKE ?)');
    params.push(like, like, like);
  }
  if (q.ignored !== '1') where.push('t.is_ignored = 0');

  const limit = Math.min(200, Math.max(1, Number(q.limit) || 100));
  const offset = Math.max(0, Number(q.offset) || 0);
  const rows = await all<TxnRow>(
    db,
    `${TXN_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`,
    ...params,
    limit + 1,
    offset,
  );
  const page = rows.slice(0, limit);
  const splits = await loadSplits(db, page.filter((r) => r.isSplit === 1).map((r) => r.id));
  return c.json({ transactions: page.map((r) => toApi(r, splits)), hasMore: rows.length > limit });
});

transactions.get('/transactions/:id', async (c) => {
  const db = c.env.DB;
  const viewer = c.get('viewer');
  const row = await visibleTxn(db, paramId(c), viewer.memberId);
  const splits = await loadSplits(db, [row.id]);
  const pair = row.transferPairId
    ? await first<TxnRow>(db, `${TXN_SELECT} WHERE t.id = ? AND ${PRIVACY_SQL}`, row.transferPairId, viewer.memberId)
    : null;
  return c.json({ ...toApi(row, splits), transferPair: pair ? toApi(pair) : null });
});

transactions.post('/transactions', async (c) => {
  const db = c.env.DB;
  const viewer = c.get('viewer');
  const body = await readBody(c);
  const ctx = await loadIngestContext(db);

  // Validate everything before creating anything.
  const amountCents = reqInt(body.amountCents, 'amountCents');
  if (amountCents === 0) throw badRequest('Amount can’t be zero');
  const date = reqDate(body.date, 'date');
  const name = reqStr(body.name, 'name', 200);
  const categoryId = optInt(body.categoryId, 'categoryId', { min: 1 }) ?? null;
  assertCategoryAllowed(ctx, categoryId, viewer.memberId);
  const isPrivate = optBool(body.isPrivate, 'isPrivate') ?? false;
  const kidId = optInt(body.kidId, 'kidId', { min: 1 }) ?? null;
  const notes = optStr(body.notes, 'notes', 1000);

  let accountId = optInt(body.accountId, 'accountId', { min: 1 });
  if (!accountId) {
    const cash = await first<{ id: number }>(db, `SELECT id FROM accounts WHERE type = 'cash' ORDER BY id LIMIT 1`);
    accountId =
      cash?.id ??
      (await first<{ id: number }>(db, `INSERT INTO accounts (name, type, is_cash) VALUES ('Cash', 'cash', 1) RETURNING id`))?.id;
    if (!accountId) throw new Error('Could not create cash account');
  }

  const handSet = categoryId !== null || isPrivate || kidId !== null;
  const result = await insertTransactions(db, ctx, [
    {
      accountId,
      date,
      amountCents,
      name,
      source: 'manual',
      createdByMemberId: viewer.memberId,
      ...(handSet
        ? {
            carry: {
              categoryId,
              categorySource: 'user',
              categoryReason: null,
              ruleId: null,
              kidId,
              privateMemberId: isPrivate ? viewer.memberId : null,
              isIgnored: false,
              incomeSourceId: null,
              payDate: null,
              normalizedMerchant: '',
            },
          }
        : {}),
    },
  ]);
  const id = result.insertedIds[0];
  if (!id) throw new Error('Insert failed');
  if (notes) await run(db, 'UPDATE transactions SET notes = ? WHERE id = ?', notes, id);
  return c.json(toApi(await visibleTxn(db, id, viewer.memberId)), 201);
});

transactions.patch('/transactions/:id', async (c) => {
  const db = c.env.DB;
  const viewer = c.get('viewer');
  const row = await visibleTxn(db, paramId(c), viewer.memberId);
  const body = await readBody(c);
  const ctx = await loadIngestContext(db);

  let k: Classification = {
    categoryId: row.categoryId,
    categorySource: row.categorySource,
    categoryReason: null,
    ruleId: null,
    kidId: row.kidId,
    privateMemberId: row.privateMemberId,
    isIgnored: row.isIgnored === 1,
    incomeSourceId: row.incomeSourceId,
    payDate: row.payDate,
    normalizedMerchant: '',
  };
  let classificationTouched = false;
  const viewerFunCategory = ctx.funCategoryByMember.get(viewer.memberId) ?? null;

  if (body.categoryId !== undefined) {
    const categoryId = optInt(body.categoryId, 'categoryId', { min: 1 }) ?? null;
    assertCategoryAllowed(ctx, categoryId, viewer.memberId);
    if (row.isSplit === 1 && categoryId !== null) throw badRequest('Remove the split first.');
    k.categoryId = categoryId;
    if (k.privateMemberId === viewer.memberId && (categoryId === null || !ctx.funCategoryOwner.has(categoryId))) {
      k.privateMemberId = null;
    }
    classificationTouched = true;
  }
  if (body.kidId !== undefined) {
    k.kidId = optInt(body.kidId, 'kidId', { min: 1 }) ?? null;
    classificationTouched = true;
  }
  if (body.isPrivate !== undefined) {
    const isPrivate = optBool(body.isPrivate, 'isPrivate');
    if (isPrivate) {
      k.privateMemberId = viewer.memberId;
      k.categoryId = viewerFunCategory;
    } else {
      k.privateMemberId = null;
      if (k.categoryId !== null && k.categoryId === viewerFunCategory) k.categoryId = null;
    }
    classificationTouched = true;
  }
  if (body.isIgnored !== undefined) {
    k.isIgnored = optBool(body.isIgnored, 'isIgnored') ?? false;
    classificationTouched = true;
  }
  if (classificationTouched) {
    k = enforceFunMoney(ctx, { ...k, categorySource: 'user' });
  }

  // The charge's category before this fix, so Undo can put it back.
  const beforeFix = body.categoryId !== undefined ? await first<StoredTxn>(db, `${STORED_SELECT} WHERE t.id = ?`, row.id) : null;

  const statements: D1PreparedStatement[] = [];
  const now = nowIso();
  if (classificationTouched) {
    statements.push(
      stmt(
        db,
        `UPDATE transactions SET category_id = ?, category_source = 'user', category_reason = NULL, rule_id = NULL, kid_id = ?,
           private_member_id = ?, is_ignored = ?, updated_at = ? WHERE id = ?`,
        k.categoryId,
        k.kidId,
        k.privateMemberId,
        k.isIgnored ? 1 : 0,
        now,
        row.id,
      ),
    );
  }
  if (body.notes !== undefined) {
    statements.push(stmt(db, 'UPDATE transactions SET notes = ?, updated_at = ? WHERE id = ?', optStr(body.notes, 'notes', 1000), now, row.id));
  }
  if (row.source === 'manual') {
    const date = optDate(body.date, 'date');
    const amountCents = optInt(body.amountCents, 'amountCents');
    const name = optStr(body.name, 'name', 200);
    if (date) statements.push(stmt(db, 'UPDATE transactions SET date = ? WHERE id = ?', date, row.id));
    if (amountCents) statements.push(stmt(db, 'UPDATE transactions SET amount_cents = ? WHERE id = ?', amountCents, row.id));
    if (name) statements.push(stmt(db, 'UPDATE transactions SET name = ? WHERE id = ?', name, row.id));
  }
  if (!statements.length) throw badRequest('Nothing to update');
  await batchAll(db, statements);

  // A fix teaches a quiet rule and re-files similar charges; the app offers Undo.
  let move: { id: number; moved: number; merchant: string; categoryName: string } | null = null;
  const learnFrom = k.categoryId;
  if (body.categoryId !== undefined && learnFrom !== null && (row.categoryId !== learnFrom || row.categorySource !== 'user')) {
    const stored = await first<StoredTxn>(db, `${STORED_SELECT} WHERE t.id = ?`, row.id);
    const learned = stored ? await learnFromFix(db, ctx, viewer, stored, learnFrom, beforeFix ?? stored) : null;
    if (learned?.moveId) {
      const category = await first<{ name: string }>(db, 'SELECT name FROM categories WHERE id = ?', learnFrom);
      move = { id: learned.moveId, moved: learned.moved, merchant: learned.merchant, categoryName: category?.name ?? '' };
    }
  }

  const updated = await visibleTxn(db, row.id, viewer.memberId).catch(() => null);
  const splits = updated ? await loadSplits(db, [row.id]) : [];
  return c.json({ transaction: updated ? toApi(updated, splits) : null, move });
});

transactions.post('/category-moves/:id/undo', async (c) => {
  return c.json(await undoMove(c.env.DB, c.get('viewer'), paramId(c)));
});

transactions.delete('/transactions/:id', async (c) => {
  const db = c.env.DB;
  const row = await visibleTxn(db, paramId(c), c.get('viewer').memberId);
  const now = nowIso();
  if (row.source === 'plaid') {
    // Synced rows would come back; hide them from totals instead.
    await run(db, `UPDATE transactions SET is_ignored = 1, category_source = 'user', updated_at = ? WHERE id = ?`, now, row.id);
    return c.json({ ok: true, ignored: true });
  }
  await batchAll(db, [
    stmt(db, 'UPDATE transactions SET deleted_at = ?, transfer_pair_id = NULL WHERE id = ?', now, row.id),
    stmt(db, 'UPDATE transactions SET transfer_pair_id = NULL WHERE transfer_pair_id = ?', row.id),
  ]);
  return c.json({ ok: true, deleted: true });
});

const MAX_SPLITS = 20;

transactions.put('/transactions/:id/splits', async (c) => {
  const db = c.env.DB;
  const viewer = c.get('viewer');
  const row = await visibleTxn(db, paramId(c), viewer.memberId);
  const body = await readBody(c);
  // Small enough that the whole change saves in one atomic batch.
  if (!Array.isArray(body.splits) || body.splits.length > MAX_SPLITS) throw badRequest(`splits must be a list of at most ${MAX_SPLITS}`);
  const ctx = await loadIngestContext(db);

  const splits = body.splits.map((raw, i) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const categoryId = optInt(s.categoryId, `splits[${i}].categoryId`, { min: 1 }) ?? null;
    assertCategoryAllowed(ctx, categoryId, viewer.memberId);
    if (categoryId !== null && ctx.funCategoryOwner.has(categoryId)) throw badRequest('Fun money can’t be part of a split.');
    return {
      categoryId,
      kidId: optInt(s.kidId, `splits[${i}].kidId`, { min: 1 }) ?? null,
      amountCents: reqInt(s.amountCents, `splits[${i}].amountCents`),
      notes: optStr(s.notes, `splits[${i}].notes`, 200) ?? null,
    };
  });
  if (splits.length === 1) throw badRequest('A split needs at least two parts.');
  const total = splits.reduce((sum, s) => sum + s.amountCents, 0);
  if (splits.length && total !== row.amountCents) {
    throw badRequest(`Split parts add up to ${total / 100} but the transaction is ${row.amountCents / 100}.`);
  }

  const now = nowIso();
  await batchAll(db, [
    stmt(db, 'DELETE FROM splits WHERE transaction_id = ?', row.id),
    ...splits.map((s) =>
      stmt(db, 'INSERT INTO splits (transaction_id, category_id, kid_id, amount_cents, notes) VALUES (?, ?, ?, ?, ?)', row.id, s.categoryId, s.kidId, s.amountCents, s.notes),
    ),
    stmt(
      db,
      `UPDATE transactions SET is_split = ?, category_id = CASE WHEN ? = 1 THEN NULL ELSE category_id END,
         category_source = 'user', private_member_id = CASE WHEN ? = 1 THEN NULL ELSE private_member_id END, updated_at = ?
       WHERE id = ?`,
      splits.length ? 1 : 0,
      splits.length ? 1 : 0,
      splits.length ? 1 : 0,
      now,
      row.id,
    ),
  ]);
  const updated = await visibleTxn(db, row.id, viewer.memberId);
  return c.json(toApi(updated, await loadSplits(db, [row.id])));
});

transactions.post('/transactions/:id/unlink-transfer', async (c) => {
  const db = c.env.DB;
  const row = await visibleTxn(db, paramId(c), c.get('viewer').memberId);
  if (!row.transferPairId) throw badRequest('Not part of a transfer.');
  const [a, b] = row.id < row.transferPairId ? [row.id, row.transferPairId] : [row.transferPairId, row.id];
  await batchAll(db, [
    stmt(db, 'INSERT OR IGNORE INTO transfer_unlinks (a_id, b_id) VALUES (?, ?)', a, b),
    stmt(db, 'UPDATE transactions SET transfer_pair_id = NULL, updated_at = ? WHERE id IN (?, ?)', nowIso(), a, b),
  ]);
  return c.json({ ok: true });
});

transactions.post('/transactions/:id/link-transfer', async (c) => {
  const db = c.env.DB;
  const viewer = c.get('viewer');
  const row = await visibleTxn(db, paramId(c), viewer.memberId);
  const other = await visibleTxn(db, reqInt((await readBody(c)).otherId, 'otherId', { min: 1 }), viewer.memberId);
  if (row.transferPairId || other.transferPairId) throw badRequest('One of these is already paired.');
  if (row.accountId === other.accountId) throw badRequest('A transfer moves money between two different accounts.');
  if (row.amountCents !== -other.amountCents) throw badRequest('Transfer amounts must match (one in, one out).');
  const now = nowIso();
  await batchAll(db, [
    stmt(db, 'UPDATE transactions SET transfer_pair_id = ?, updated_at = ? WHERE id = ?', other.id, now, row.id),
    stmt(db, 'UPDATE transactions SET transfer_pair_id = ?, updated_at = ? WHERE id = ?', row.id, now, other.id),
    stmt(db, 'DELETE FROM transfer_unlinks WHERE (a_id = ? AND b_id = ?) OR (a_id = ? AND b_id = ?)', row.id, other.id, other.id, row.id),
  ]);
  return c.json({ ok: true });
});
