import { Hono } from 'hono';
import { canView } from '../../shared/privacy';
import type { AppEnv } from '../env';
import { all, batchAll, first, nowIso, run, stmt, Updates } from '../lib/db';
import { badRequest, HttpError, notFound, oneOf, optBool, optInt, paramId, readBody, reqStr } from '../lib/http';
import { loadIngestContext, RULE_SELECT, toRule, withRules, type RuleRow } from '../services/context';
import { classificationChanges, reclassify, STORED_SELECT, type StoredTxn } from '../services/ingest';
import { normalizeText, ruleMatches, ruleSubjectName, type Rule } from '../../shared/rules';

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
    learned: row.learned === 1,
    amountMinCents: row.amountMin,
    amountMaxCents: row.amountMax,
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

const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

/**
 * Past, non-hand-edited transactions that could be affected by rules with this text. A SQL prefilter on the
 * longest word (so extra spaces in a bank name don't hide a match; % and _ are taken literally), newest first,
 * at most 2000 per text. Saving a rule and previewing it both start from exactly this set.
 */
async function candidatesFor(db: D1Database, texts: readonly string[]): Promise<StoredTxn[]> {
  const byId = new Map<number, StoredTxn>();
  for (const text of new Set(texts)) {
    const token = normalizeText(text)
      .split(' ')
      .reduce((best, word) => (word.length > best.length ? word : best), '');
    if (!token) continue;
    const like = `%${escapeLike(token)}%`;
    const rows = await all<StoredTxn>(
      db,
      `${STORED_SELECT}
        WHERE t.deleted_at IS NULL AND (t.category_source IS NULL OR t.category_source != 'user')
          AND (UPPER(t.name) LIKE ? ESCAPE '\\' OR UPPER(COALESCE(t.merchant_name, '')) LIKE ? ESCAPE '\\' OR UPPER(COALESCE(t.memo, '')) LIKE ? ESCAPE '\\')
        ORDER BY t.date DESC LIMIT 2000`,
      like,
      like,
      like,
    );
    // Same text test as a saved rule (see ruleMatches): whitespace-normalized, in the name or merchant.
    const needle = normalizeText(text);
    for (const row of rows) {
      if (normalizeText(ruleSubjectName(row.name, row.memo)).includes(needle) || normalizeText(row.merchantName).includes(needle)) byId.set(row.id, row);
    }
  }
  return [...byId.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
}

/** Re-applies rules to past, non-hand-edited transactions matching these texts. Counts only rows `viewerId` can see. */
async function applyToMatching(db: D1Database, texts: readonly string[], viewerId: number): Promise<number> {
  return reclassify(db, await loadIngestContext(db), await candidatesFor(db, texts), viewerId);
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

  const privateRule = (categoryId !== null && (await isOwnFunCategory(db, categoryId, viewer.memberId))) || isPrivate;

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
  const updated = optBool(body.applyToExisting, 'applyToExisting') === false ? 0 : await applyToMatching(db, [matchText], viewer.memberId);
  return c.json({ id: row?.id, updated }, 201);
});

/** True for your own fun money category; refuses your partner's. A rule filing into fun money is private. */
async function isOwnFunCategory(db: D1Database, categoryId: number, viewerId: number): Promise<boolean> {
  const category = await first<{ funMemberId: number | null }>(db, 'SELECT fun_member_id AS funMemberId FROM categories WHERE id = ?', categoryId);
  if (!category) throw badRequest('Unknown category');
  if (category.funMemberId !== null && category.funMemberId !== viewerId) {
    throw new HttpError(403, 'That’s your partner’s fun money category.');
  }
  return category.funMemberId === viewerId;
}

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
  const viewerId = c.get('viewer').memberId;
  const rule = await ownedRule(db, paramId(c), viewerId);
  const body = await readBody(c);
  const ignore = optBool(body.ignore, 'ignore');
  const applyToExisting = optBool(body.applyToExisting, 'applyToExisting');
  const categoryId = optInt(body.categoryId, 'categoryId', { min: 1 });
  const makePrivate = typeof categoryId === 'number' && (await isOwnFunCategory(db, categoryId, viewerId));
  const updates = new Updates()
    .set('match_field', oneOf(body.matchField, 'matchField', MATCH_FIELDS))
    .set('match_text', body.matchText === undefined ? undefined : reqStr(body.matchText, 'matchText', 120))
    .set('account_id', optInt(body.accountId, 'accountId', { min: 1 }))
    .set('category_id', categoryId)
    .set('private_member_id', makePrivate ? viewerId : undefined)
    .set('owner_member_id', makePrivate ? viewerId : undefined)
    .set('kid_id', optInt(body.kidId, 'kidId', { min: 1 }))
    .set('ignore_txn', ignore === undefined ? undefined : ignore ? 1 : 0);
  if (updates.empty) throw badRequest('Nothing to update');
  await run(db, `UPDATE rules SET ${updates.sets.join(', ')}, updated_at = ? WHERE id = ?`, ...updates.params, nowIso(), rule.id);
  const text = typeof body.matchText === 'string' ? body.matchText : rule.matchText;
  const updated = applyToExisting === false ? 0 : await applyToMatching(db, [rule.matchText, text], viewerId);
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
  if (!Array.isArray(body.ids) || body.ids.length > 1000 || !body.ids.every((id) => Number.isInteger(id))) {
    throw badRequest('ids must be a list of rule ids');
  }
  const viewerId = c.get('viewer').memberId;
  await batchAll(
    db,
    (body.ids as number[]).map((id, i) =>
      stmt(
        db,
        'UPDATE rules SET position = ?, updated_at = ? WHERE id = ? AND (owner_member_id IS NULL OR owner_member_id = ?)',
        (i + 1) * 10,
        nowIso(),
        id,
        viewerId,
      ),
    ),
  );
  return c.json({ ok: true });
});

/**
 * A dry run of saving a rule. Send what POST /rules would get, or add `ruleId` to preview an edit
 * (unsent fields keep the rule's current values). The rule goes where saving would put it, every candidate charge
 * is re-classified through the real classifier, and nothing is written.
 *   count       charges (that you may see) the rule matches
 *   wouldChange charges (that you may see) saving with "apply to past charges" would change
 *   sample      up to 5 of those, newest first
 * A partner's private charges are never counted or shown.
 */
rules.post('/rules/preview', async (c) => {
  const db = c.env.DB;
  const viewerId = c.get('viewer').memberId;
  const body = await readBody(c);

  const ruleId = optInt(body.ruleId, 'ruleId', { min: 1 });
  const existing = ruleId === undefined ? null : await first<RuleRow>(db, `${RULE_SELECT} WHERE r.id = ?`, ruleId);
  if (ruleId !== undefined && (!existing || (existing.ownerMemberId !== null && existing.ownerMemberId !== viewerId))) {
    throw notFound('Rule not found');
  }
  const base = existing ? toRule(existing) : null;

  const matchText = body.matchText === undefined && base ? base.matchText : reqStr(body.matchText, 'matchText', 120);
  if (matchText.length < 2) throw badRequest('Match text is too short.');
  const accountId = optInt(body.accountId, 'accountId', { min: 1 });
  const categoryId = optInt(body.categoryId, 'categoryId', { min: 1 });
  const kidId = optInt(body.kidId, 'kidId', { min: 1 });
  const ignore = optBool(body.ignore, 'ignore');
  const matchField = oneOf(body.matchField, 'matchField', MATCH_FIELDS);
  const ownFun = typeof categoryId === 'number' && (await isOwnFunCategory(db, categoryId, viewerId));
  const isPrivate = base ? ownFun : ownFun || (optBool(body.isPrivate, 'isPrivate') ?? false);

  const ctx = await loadIngestContext(db);
  const action = { ...(base?.action ?? {}) };
  if (categoryId !== undefined) action.categoryId = categoryId;
  if (kidId !== undefined) action.kidId = kidId;
  if (ignore !== undefined) action.ignore = ignore;
  if (isPrivate) action.privateMemberId = viewerId;
  const draft: Rule = {
    id: base?.id ?? -1,
    // Saving puts a new rule above all the others.
    position: base?.position ?? Math.min(1000, ...ctx.rules.map((r) => r.position)) - 10,
    matchField: matchField ?? base?.matchField ?? 'any',
    matchText,
    accountId: accountId === undefined ? (base?.accountId ?? null) : accountId,
    amountMin: base?.amountMin ?? null,
    amountMax: base?.amountMax ?? null,
    learned: base?.learned ?? false,
    action,
  };
  // With nothing chosen yet there is nothing to change: the count still works while someone is typing.
  const doesSomething = base !== null || categoryId != null || kidId != null || isPrivate || draft.action.ignore;
  const hypothetical = doesSomething ? withRules(ctx, [...ctx.rules.filter((r) => r.id !== draft.id), draft]) : ctx;

  const visible = (await candidatesFor(db, base ? [base.matchText, matchText] : [matchText])).filter((row) => canView(row, viewerId));
  const matches = visible.filter((row) =>
    ruleMatches(draft, { name: ruleSubjectName(row.name, row.memo), merchantName: row.merchantName, accountId: row.accountId, amountCents: row.amountCents }),
  );
  const changes = classificationChanges(hypothetical, visible).map(({ row }) => row);
  const sample = changes.slice(0, 5).map((row) => ({ id: row.id, date: row.date, name: row.name, amountCents: row.amountCents }));
  return c.json({ count: matches.length, wouldChange: changes.length, sample, examples: sample });
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
