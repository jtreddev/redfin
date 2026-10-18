import { Hono } from 'hono';
import { monthEnd, monthStart } from '../../shared/dates';
import { PRIVACY_SQL } from '../../shared/privacy';
import { likeAnywhere, parseSearch } from '../../shared/search';
import { GROUP_ORDER } from '../../shared/trends';
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
import { enforceFunMoney, insertTransactions, rederive, STORED_SELECT, type Classification, type StoredTxn } from '../services/ingest';
import { findSimilar, learnFromFix, undoMove } from '../services/learn';

export const transactions = new Hono<AppEnv>();

const TRENDS_GROUP_SECTION = new Map<string, string>(GROUP_ORDER.map((g) => [g.key, g.section]));

/** Most ids one filter or bulk change takes. */
const MAX_FILTER_IDS = 100;

/**
 * The categories a category filter covers. Today that is just the ones picked; once categories have
 * sub-categories (categories.parent_id, migration 0007), a parent's children belong here too.
 */
function expandCategoryIds(ids: number[]): number[] {
  return [...new Set(ids)];
}

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

/** A hand change to how a charge is filed; absent fields stay as they are. */
interface Edit {
  categoryId?: number | null;
  kidId?: number | null;
  isPrivate?: boolean;
  isIgnored?: boolean;
}

/** Reads and checks an edit from a request body (PATCH) or a bulk `set`. */
function readEdit(ctx: IngestContext, body: Record<string, unknown>, viewerId: number): Edit {
  const edit: Edit = {};
  if (body.categoryId !== undefined) {
    edit.categoryId = optInt(body.categoryId, 'categoryId', { min: 1 }) ?? null;
    assertCategoryAllowed(ctx, edit.categoryId, viewerId);
  }
  if (body.kidId !== undefined) edit.kidId = optInt(body.kidId, 'kidId', { min: 1 }) ?? null;
  if (body.isPrivate !== undefined) edit.isPrivate = optBool(body.isPrivate, 'isPrivate');
  if (body.isIgnored !== undefined) edit.isIgnored = optBool(body.isIgnored, 'isIgnored');
  return edit;
}

/**
 * How a charge ends up filed after a hand edit: picked by hand ('user'), and fun money kept consistent
 * (your private charges live in your fun money; leaving it makes them shared).
 */
function applyEdit(ctx: IngestContext, row: TxnRow, edit: Edit, viewerId: number): Classification {
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
  if (!Object.keys(edit).length) return k;
  const viewerFunCategory = ctx.funCategoryByMember.get(viewerId) ?? null;
  if (edit.categoryId !== undefined) {
    const categoryId = edit.categoryId;
    k.categoryId = categoryId;
    if (k.privateMemberId === viewerId && (categoryId === null || !ctx.funCategoryOwner.has(categoryId))) {
      k.privateMemberId = null;
    }
  }
  if (edit.kidId !== undefined) k.kidId = edit.kidId;
  if (edit.isPrivate !== undefined) {
    if (edit.isPrivate) {
      k.privateMemberId = viewerId;
      k.categoryId = viewerFunCategory;
    } else {
      k.privateMemberId = null;
      if (k.categoryId !== null && k.categoryId === viewerFunCategory) k.categoryId = null;
    }
  }
  if (edit.isIgnored !== undefined) k.isIgnored = edit.isIgnored;
  k = enforceFunMoney(ctx, { ...k, categorySource: 'user' });
  return k;
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
  const categoryIds = (c.req.queries('categoryId') ?? []).flatMap((v) => v.split(',')).filter((v) => v.trim() !== '');
  if (categoryIds.length) {
    if (categoryIds.length > MAX_FILTER_IDS) throw badRequest(`At most ${MAX_FILTER_IDS} categories at once.`);
    // One bound list (D1 allows 100 parameters a statement), matched against the charge and its split parts.
    // A parent includes its sub-categories.
    const list = JSON.stringify(expandCategoryIds(categoryIds.map((v) => reqInt(v.trim(), 'categoryId'))));
    const inList =
      'IN (SELECT id FROM categories WHERE id IN (SELECT value FROM json_each(?)) OR parent_id IN (SELECT value FROM json_each(?)))';
    where.push(`(t.category_id ${inList} OR EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id = t.id AND s.category_id ${inList}))`);
    params.push(list, list, list, list);
  }
  if (q.group) {
    // The Trends groups, counted the way Trends counts them: your private charges are your fun money.
    const section = TRENDS_GROUP_SECTION.get(q.group);
    if (!section) throw badRequest('Unknown group.');
    const inGroup = 'SELECT c.id FROM categories c JOIN sections sec ON sec.id = c.section_id WHERE sec.name = ?';
    const filed = `(t.category_id IN (${inGroup}) OR EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id = t.id AND s.category_id IN (${inGroup})))`;
    where.push(q.group === 'fun' ? `(t.private_member_id IS NOT NULL OR ${filed})` : `(t.private_member_id IS NULL AND ${filed})`);
    params.push(section, section);
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
  const search = parseSearch((q.q ?? '').slice(0, 100));
  if (search.text) {
    // Case-insensitive (LIKE, ASCII). The bank's description, merchant, notes, and the category (or split parts') name.
    const like = likeAnywhere(search.text.slice(0, 60));
    const textMatch = `t.name LIKE ? ESCAPE '\\' OR t.memo LIKE ? ESCAPE '\\' OR t.merchant_name LIKE ? ESCAPE '\\'
      OR t.normalized_merchant LIKE ? ESCAPE '\\' OR t.notes LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM categories qc WHERE qc.id = t.category_id AND qc.name LIKE ? ESCAPE '\\')
      OR EXISTS (SELECT 1 FROM splits qs JOIN categories qc ON qc.id = qs.category_id
                  WHERE qs.transaction_id = t.id AND qc.name LIKE ? ESCAPE '\\')`;
    params.push(like, like, like, like, like, like, like);
    // A bare amount ("45", "$45.12") also finds charges of that size, money in or out.
    if (search.amount) {
      where.push(`(${textMatch} OR ABS(t.amount_cents) BETWEEN ? AND ?)`);
      params.push(search.amount.minCents, search.amount.maxCents);
    } else {
      where.push(`(${textMatch})`);
    }
  }
  const minCents = [search.minCents, q.minCents ? reqInt(q.minCents, 'minCents', { min: 0 }) : null].filter((v) => v !== null);
  const maxCents = [search.maxCents, q.maxCents ? reqInt(q.maxCents, 'maxCents', { min: 0 }) : null].filter((v) => v !== null);
  if (minCents.length) {
    where.push('ABS(t.amount_cents) >= ?');
    params.push(Math.max(...minCents));
  }
  if (maxCents.length) {
    where.push('ABS(t.amount_cents) <= ?');
    params.push(Math.min(...maxCents));
  }
  if (q.ignored !== '1') where.push('t.is_ignored = 0');

  const limit = Math.min(200, Math.max(1, Number(q.limit) || 100));
  const offset = Math.max(0, Number(q.offset) || 0);
  const filter = where.join(' AND ');
  // The page and the totals for the whole result, in one round trip.
  const [pageResult, totalsResult] = await db.batch([
    stmt(db, `${TXN_SELECT} WHERE ${filter} ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`, ...params, limit + 1, offset),
    stmt(
      db,
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents ELSE 0 END), 0) AS outCents,
              COALESCE(SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents ELSE 0 END), 0) AS inCents
         FROM transactions t WHERE ${filter}`,
      ...params,
    ),
  ]);
  const rows = (pageResult?.results ?? []) as TxnRow[];
  const totals = (totalsResult?.results?.[0] ?? { count: 0, outCents: 0, inCents: 0 }) as { count: number; outCents: number; inCents: number };
  const page = rows.slice(0, limit);
  const splits = await loadSplits(db, page.filter((r) => r.isSplit === 1).map((r) => r.id));
  return c.json({
    transactions: page.map((r) => toApi(r, splits)),
    hasMore: rows.length > limit,
    totals: { count: totals.count, outCents: totals.outCents, inCents: totals.inCents },
  });
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

/**
 * How many other charges "also file similar ones" would move if this charge went to `categoryId`
 * (optional), and the merchant key it would learn. Read-only; the same matching as learning.
 */
transactions.get('/transactions/:id/similar', async (c) => {
  const db = c.env.DB;
  const viewer = c.get('viewer');
  const row = await visibleTxn(db, paramId(c), viewer.memberId);
  const raw = c.req.query('categoryId');
  const categoryId = raw === undefined || raw === '' ? null : reqInt(raw, 'categoryId', { min: 1 });
  const ctx = await loadIngestContext(db);
  assertCategoryAllowed(ctx, categoryId, viewer.memberId);
  // A split charge can't take a category, so "also file similar ones" has nothing to start from.
  if (row.isSplit === 1) return c.json({ count: 0, merchant: '' });
  const stored = await first<StoredTxn>(db, `${STORED_SELECT} WHERE t.id = ?`, row.id);
  const found = stored ? await findSimilar(db, ctx, viewer, stored, categoryId) : null;
  return c.json({ count: found?.ids.length ?? 0, merchant: found?.learned?.matchText ?? '' });
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
  // A pick changes this charge only; "also file similar ones" is an explicit choice.
  const alsoSimilar = optBool(body.alsoSimilar, 'alsoSimilar') ?? false;

  const edit = readEdit(ctx, body, viewer.memberId);
  if (row.isSplit === 1 && edit.categoryId !== undefined && edit.categoryId !== null) throw badRequest('Remove the split first.');
  const classificationTouched = Object.keys(edit).length > 0;
  const k = applyEdit(ctx, row, edit, viewer.memberId);

  // The charge's category before this fix, so Undo can put it back.
  const beforeFix = body.categoryId !== undefined && alsoSimilar ? await first<StoredTxn>(db, `${STORED_SELECT} WHERE t.id = ?`, row.id) : null;

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
  if (alsoSimilar && (k.categoryId === null || row.isSplit === 1)) throw badRequest('Pick a category first.');
  if (!statements.length && !alsoSimilar) throw badRequest('Nothing to update');
  if (statements.length) await batchAll(db, statements);

  // Asked for: teach a quiet rule and re-file similar charges; the app offers Undo.
  let move: { id: number; moved: number; merchant: string; categoryName: string } | null = null;
  const learnFrom = k.categoryId;
  if (alsoSimilar && learnFrom !== null) {
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

/** Most charges one bulk change takes. */
const MAX_BULK = 500;

/**
 * Bulk edit: the same hand change (category, kid, private, left out) on many charges, as one-offs
 * (nothing is learned). Only charges the viewer can see are changed; split charges keep their parts
 * when a category or privacy is set. One move records it all, so one Undo puts it back.
 */
transactions.post('/transactions/bulk', async (c) => {
  const db = c.env.DB;
  const viewer = c.get('viewer');
  const body = await readBody(c);
  if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > MAX_BULK) {
    throw badRequest(`ids must be a list of 1 to ${MAX_BULK} charges`);
  }
  const ids = [...new Set(body.ids.map((id, i) => reqInt(id, `ids[${i}]`, { min: 1 })))];
  if (!body.set || typeof body.set !== 'object' || Array.isArray(body.set)) throw badRequest('set is required');
  const ctx = await loadIngestContext(db);
  const edit = readEdit(ctx, body.set as Record<string, unknown>, viewer.memberId);
  if (!Object.keys(edit).length) throw badRequest('Nothing to change');
  const filing = edit.categoryId !== undefined || edit.isPrivate !== undefined;
  if (edit.categoryId != null && !(await first(db, 'SELECT 1 AS x FROM categories WHERE id = ?', edit.categoryId))) {
    throw badRequest('No such category.');
  }
  if (edit.kidId != null && !(await first(db, 'SELECT 1 AS x FROM kids WHERE id = ?', edit.kidId))) throw badRequest('No such kid.');

  // One bound list, whatever the size (D1 allows 100 parameters a statement).
  const rows = await all<TxnRow>(
    db,
    `${TXN_SELECT} WHERE t.id IN (SELECT value FROM json_each(?)) AND t.deleted_at IS NULL AND ${PRIVACY_SQL}`,
    JSON.stringify(ids),
    viewer.memberId,
  );
  const changes = rows
    .filter((row) => !(filing && row.isSplit === 1))
    .map((row) => {
      const k = applyEdit(ctx, row, edit, viewer.memberId);
      return { id: row.id, c: k.categoryId, k: k.kidId, p: k.privateMemberId, i: k.isIgnored ? 1 : 0 };
    });
  if (!changes.length) return c.json({ updated: 0, skipped: ids.length, moveId: null });

  const now = nowIso();
  const payload = JSON.stringify(changes);
  const field = (name: string) => `json_extract(j.value, '$.${name}')`;
  // Re-checked inside the batch, so a charge made private or deleted, or split, since the read above is left alone.
  const stillOk = (t: string) =>
    `${t}.deleted_at IS NULL AND (${t}.private_member_id IS NULL OR ${t}.private_member_id = ?) AND NOT (? AND ${t}.is_split = 1)`;
  // This request's move: the batch runs alone, so the newest bulk move of this person is the one just made.
  const thisMove = `(SELECT MAX(id) FROM category_moves WHERE member_id = ? AND kind = 'bulk')`;
  // Record, snapshot and change in one atomic batch. The changed charges carry the move's time in
  // updated_at, which is how Undo knows a charge hasn't been touched since.
  const [moveResult, , updateResult] = await db.batch([
    stmt(db, `INSERT INTO category_moves (member_id, kind, created_at) VALUES (?, 'bulk', ?) RETURNING id`, viewer.memberId, now),
    stmt(
      db,
      `INSERT INTO category_move_items (move_id, transaction_id, old_category_id, old_source, old_reason, old_rule_id,
         old_kid_id, old_private_member_id, old_is_ignored, old_is_split, new_category_id, new_kid_id, new_private_member_id, new_is_ignored)
       SELECT ${thisMove}, t.id, t.category_id, t.category_source, t.category_reason, t.rule_id, t.kid_id, t.private_member_id,
              t.is_ignored, t.is_split, ${field('c')}, ${field('k')}, ${field('p')}, ${field('i')}
         FROM json_each(?) j JOIN transactions t ON t.id = ${field('id')}
        WHERE ${stillOk('t')}`,
      viewer.memberId,
      payload,
      viewer.memberId,
      filing ? 1 : 0,
    ),
    stmt(
      db,
      `UPDATE transactions SET category_id = ${field('c')}, category_source = 'user', category_reason = NULL, rule_id = NULL,
         kid_id = ${field('k')}, private_member_id = ${field('p')}, is_ignored = ${field('i')}, updated_at = ?
         FROM json_each(?) j WHERE transactions.id = ${field('id')} AND ${stillOk('transactions')}`,
      now,
      payload,
      viewer.memberId,
      filing ? 1 : 0,
    ),
    // Nothing left to change after all: no empty move to undo.
    stmt(
      db,
      `DELETE FROM category_moves WHERE id = ${thisMove} AND NOT EXISTS (SELECT 1 FROM category_move_items i WHERE i.move_id = category_moves.id)`,
      viewer.memberId,
    ),
  ]);
  const updated = updateResult?.meta.changes ?? 0;
  const moveId = updated ? ((moveResult?.results?.[0] as { id: number } | undefined)?.id ?? null) : null;
  return c.json({ updated, skipped: ids.length - updated, moveId });
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
  if (row.transferPairId) await rederive(db, [row.transferPairId]);
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
  // No longer a transfer: the app sorts both halves again.
  await rederive(db, [a, b]);
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
  const ctx = await loadIngestContext(db);
  // A paired half is filed as a transfer and shared. A charge that was private (say, on your personal card)
  // stays private and in its person's fun money: linking pins that as a hand choice, which you can still change.
  const keepPrivate = [row, other]
    .filter((t) => t.privateMemberId !== null && t.categorySource !== 'user' && t.isSplit === 0)
    .map((t) => {
      const k = enforceFunMoney(ctx, {
        categoryId: t.categoryId,
        categorySource: 'user',
        categoryReason: null,
        ruleId: null,
        kidId: t.kidId,
        privateMemberId: t.privateMemberId,
        isIgnored: t.isIgnored === 1,
        incomeSourceId: t.incomeSourceId,
        payDate: t.payDate,
        normalizedMerchant: '',
      });
      return stmt(
        db,
        `UPDATE transactions SET category_id = ?, category_source = 'user', category_reason = NULL, rule_id = NULL,
           private_member_id = ?, updated_at = ? WHERE id = ?`,
        k.categoryId,
        k.privateMemberId,
        now,
        t.id,
      );
    });
  await batchAll(db, [
    stmt(db, 'UPDATE transactions SET transfer_pair_id = ?, updated_at = ? WHERE id = ?', other.id, now, row.id),
    stmt(db, 'UPDATE transactions SET transfer_pair_id = ?, updated_at = ? WHERE id = ?', row.id, now, other.id),
    stmt(db, 'DELETE FROM transfer_unlinks WHERE (a_id = ? AND b_id = ?) OR (a_id = ? AND b_id = ?)', row.id, other.id, other.id, row.id),
    ...keepPrivate,
  ]);
  await rederive(db, [row.id, other.id], ctx);
  return c.json({ ok: true });
});
