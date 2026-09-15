import { Hono } from 'hono';
import { PRIVACY_SQL } from '../../shared/privacy';
import type { AppEnv } from '../env';
import { all, batchAll, first, nowIso, run, stmt, Updates } from '../lib/db';
import { badRequest, HttpError, notFound, oneOf, optBool, optInt, paramId, readBody, reqStr } from '../lib/http';
import { loadIngestContext, RULE_SELECT, type RuleRow } from '../services/context';
import { reclassify, STORED_SELECT, type StoredTxn } from '../services/ingest';

export const rules = new Hono<AppEnv>();

const MATCH_FIELDS = ['name', 'merchant', 'any'] as const;

function toApi(row: RuleRow & { categoryName: string | null; kidName: string | null; accountName: string | null }) {
  return {
    id: row.id,
    position: row.position,
    matchField: row.matchField,
    matchText: row.matchText,
    accountId: row.accountId,
    accountName: row.accountName,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    kidId: row.kidId,
    kidName: row.kidName,
    isPrivate: row.privateMemberId !== null,
    ignore: row.ignoreTxn === 1,
  };
}

const RULE_LIST_SELECT = RULE_SELECT.replace(
  'FROM rules r',
  `, c.name AS categoryName, k.name AS kidName, a.name AS accountName
   FROM rules r LEFT JOIN categories c ON c.id = r.category_id LEFT JOIN kids k ON k.id = r.kid_id
   LEFT JOIN accounts a ON a.id = r.account_id`,
);

rules.get('/rules', async (c) => {
  const rows = await all<RuleRow & { categoryName: string | null; kidName: string | null; accountName: string | null }>(
    c.env.DB,
    `${RULE_LIST_SELECT} WHERE r.owner_member_id IS NULL OR r.owner_member_id = ? ORDER BY r.position, r.id`,
    c.get('viewer').memberId,
  );
  return c.json(rows.map(toApi));
});

/** Re-applies rules to past, non-hand-edited transactions whose text contains `text`. */
async function applyToMatching(db: D1Database, text: string): Promise<number> {
  const like = `%${text.toUpperCase().replace(/[%_]/g, '')}%`;
  const rows = await all<StoredTxn>(
    db,
    `${STORED_SELECT}
      WHERE t.deleted_at IS NULL AND (t.category_source IS NULL OR t.category_source != 'user')
        AND (UPPER(t.name) LIKE ? OR UPPER(COALESCE(t.merchant_name, '')) LIKE ? OR UPPER(COALESCE(t.memo, '')) LIKE ?)
      ORDER BY t.date DESC LIMIT 2000`,
    like,
    like,
    like,
  );
  return reclassify(db, await loadIngestContext(db), rows);
}

rules.post('/rules', async (c) => {
  const db = c.env.DB;
  const viewer = c.get('viewer');
  const body = await readBody(c);
  const matchText = reqStr(body.matchText, 'matchText', 120);
  if (matchText.length < 2) throw badRequest('Match text is too short.');
  const categoryId = optInt(body.categoryId, 'categoryId', { min: 1 }) ?? null;
  const kidId = optInt(body.kidId, 'kidId', { min: 1 }) ?? null;
  const isPrivate = optBool(body.isPrivate, 'isPrivate') ?? false;
  const ignore = optBool(body.ignore, 'ignore') ?? false;
  if (categoryId === null && kidId === null && !isPrivate && !ignore) throw badRequest('Pick what the rule should do.');

  if (categoryId !== null) {
    const category = await first<{ funMemberId: number | null }>(db, 'SELECT fun_member_id AS funMemberId FROM categories WHERE id = ?', categoryId);
    if (!category) throw badRequest('Unknown category');
    if (category.funMemberId !== null && category.funMemberId !== viewer.memberId) {
      throw new HttpError(403, 'That’s your partner’s fun money category.');
    }
  }
  const privateRule = isPrivate || (categoryId !== null && (await first(db, 'SELECT 1 FROM categories WHERE id = ? AND fun_member_id = ?', categoryId, viewer.memberId)) !== null);

  const row = await first<{ id: number }>(
    db,
    `INSERT INTO rules (position, match_field, match_text, account_id, category_id, kid_id, private_member_id, ignore_txn, owner_member_id)
     VALUES ((SELECT COALESCE(MIN(position), 1000) - 10 FROM rules), ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    oneOf(body.matchField, 'matchField', MATCH_FIELDS) ?? 'any',
    matchText,
    optInt(body.accountId, 'accountId', { min: 1 }) ?? null,
    categoryId,
    kidId,
    privateRule ? viewer.memberId : null,
    ignore ? 1 : 0,
    privateRule ? viewer.memberId : null,
  );
  const updated = optBool(body.applyToExisting, 'applyToExisting') === false ? 0 : await applyToMatching(db, matchText);
  return c.json({ id: row?.id, updated }, 201);
});

async function ownedRule(db: D1Database, id: number, viewerId: number) {
  const rule = await first<{ id: number; matchText: string; ownerMemberId: number | null }>(
    db,
    'SELECT id, match_text AS matchText, owner_member_id AS ownerMemberId FROM rules WHERE id = ?',
    id,
  );
  if (!rule || (rule.ownerMemberId !== null && rule.ownerMemberId !== viewerId)) throw notFound('Rule not found');
  return rule;
}

rules.patch('/rules/:id', async (c) => {
  const db = c.env.DB;
  const rule = await ownedRule(db, paramId(c), c.get('viewer').memberId);
  const body = await readBody(c);
  const ignore = optBool(body.ignore, 'ignore');
  const updates = new Updates()
    .set('match_field', oneOf(body.matchField, 'matchField', MATCH_FIELDS))
    .set('match_text', body.matchText === undefined ? undefined : reqStr(body.matchText, 'matchText', 120))
    .set('account_id', optInt(body.accountId, 'accountId', { min: 1 }))
    .set('category_id', optInt(body.categoryId, 'categoryId', { min: 1 }))
    .set('kid_id', optInt(body.kidId, 'kidId', { min: 1 }))
    .set('ignore_txn', ignore === undefined ? undefined : ignore ? 1 : 0);
  if (updates.empty) throw badRequest('Nothing to update');
  await run(db, `UPDATE rules SET ${updates.sets.join(', ')}, updated_at = ? WHERE id = ?`, ...updates.params, nowIso(), rule.id);
  const text = typeof body.matchText === 'string' ? body.matchText : rule.matchText;
  const updated = (await applyToMatching(db, rule.matchText)) + (text !== rule.matchText ? await applyToMatching(db, text) : 0);
  return c.json({ ok: true, updated });
});

rules.delete('/rules/:id', async (c) => {
  const db = c.env.DB;
  const rule = await ownedRule(db, paramId(c), c.get('viewer').memberId);
  const affected = await all<StoredTxn>(db, `${STORED_SELECT} WHERE t.rule_id = ? AND t.deleted_at IS NULL`, rule.id);
  await run(db, 'DELETE FROM rules WHERE id = ?', rule.id);
  const updated = await reclassify(db, await loadIngestContext(db), affected);
  return c.json({ ok: true, updated });
});

rules.post('/rules/reorder', async (c) => {
  const db = c.env.DB;
  const body = await readBody(c);
  if (!Array.isArray(body.ids) || !body.ids.every((id) => Number.isInteger(id))) throw badRequest('ids must be a list of rule ids');
  await batchAll(
    db,
    (body.ids as number[]).map((id, i) => stmt(db, 'UPDATE rules SET position = ?, updated_at = ? WHERE id = ?', (i + 1) * 10, nowIso(), id)),
  );
  return c.json({ ok: true });
});

/** How many visible transactions a rule would match, with a few examples. */
rules.post('/rules/preview', async (c) => {
  const db = c.env.DB;
  const viewer = c.get('viewer');
  const body = await readBody(c);
  const text = reqStr(body.matchText, 'matchText', 120).toUpperCase().replace(/[%_]/g, '');
  const field = oneOf(body.matchField, 'matchField', MATCH_FIELDS) ?? 'any';
  const column =
    field === 'name'
      ? "UPPER(t.name) LIKE ?1"
      : field === 'merchant'
        ? "UPPER(COALESCE(t.merchant_name, '')) LIKE ?1"
        : "(UPPER(t.name) LIKE ?1 OR UPPER(COALESCE(t.merchant_name, '')) LIKE ?1)";
  const accountId = optInt(body.accountId, 'accountId', { min: 1 }) ?? null;
  const where = `t.deleted_at IS NULL AND ${column} AND (?2 IS NULL OR t.account_id = ?2)
    AND (t.private_member_id IS NULL OR t.private_member_id = ?3)`;
  const like = `%${text}%`;
  const [count, examples] = await Promise.all([
    first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM transactions t WHERE ${where}`, like, accountId, viewer.memberId),
    all(db, `SELECT t.id, t.date, t.name, t.amount_cents AS amountCents FROM transactions t WHERE ${where} ORDER BY t.date DESC LIMIT 5`, like, accountId, viewer.memberId),
  ]);
  void PRIVACY_SQL;
  return c.json({ count: count?.n ?? 0, examples });
});

/** Re-applies all rules to past transactions in chunks: call again with the returned afterId until done. */
rules.post('/rules/apply', async (c) => {
  const db = c.env.DB;
  const afterId = optInt((await readBody(c)).afterId, 'afterId', { min: 0 }) ?? 0;
  const rows = await all<StoredTxn>(
    db,
    `${STORED_SELECT} WHERE t.id > ? AND t.deleted_at IS NULL AND (t.category_source IS NULL OR t.category_source != 'user')
      ORDER BY t.id LIMIT 400`,
    afterId,
  );
  const updated = await reclassify(db, await loadIngestContext(db), rows);
  const last = rows[rows.length - 1]?.id ?? null;
  return c.json({ updated, afterId: last, done: rows.length < 400 });
});
