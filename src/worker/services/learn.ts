import { LEARNED_REASON } from '../../shared/autoCategory';
import { isGasStation } from '../../shared/builtinRules';
import { PRIVACY_SQL } from '../../shared/privacy';
import { normalizeMerchant, normalizeText, ruleAppliesToAccount, ruleMatches, type MatchField, type Rule } from '../../shared/rules';
import type { Viewer } from '../env';
import { all, batchAll, chunk, first, nowIso, placeholders, run, stmt } from '../lib/db';
import { HttpError, notFound } from '../lib/http';
import { loadIngestContext, type IngestContext } from './context';
import { reclassify, STORED_SELECT, type StoredTxn } from './ingest';

/**
 * Fixing a charge by hand teaches a quiet rule: the same merchant (and, at a gas station, the same
 * side of the habit cutoff) goes to the same category from now on. Earlier charges nobody set by hand
 * are re-filed right away, and the whole move can be undone for a day.
 */

/** Most charges one fix re-files, so a request stays bounded. */
const REFILE_LIMIT = 2000;
/** Ids per IN list: D1 allows 100 bound parameters per statement. */
const IDS_PER_STATEMENT = 90;

export interface LearnResult {
  moved: number;
  moveId: number | null;
  /** The learned rule, or null when no rule could match the charge. */
  ruleId: number | null;
  /** The rule's match text, e.g. "SHELL". */
  merchant: string;
}

/** Rule columns saved before a fix changes a learned rule, so Undo can put them back. */
interface RuleBefore {
  position: number;
  match_field: MatchField;
  match_text: string;
  account_id: number | null;
  category_id: number | null;
  kid_id: number | null;
  private_member_id: number | null;
  ignore_txn: number;
  owner_member_id: number | null;
  amount_min_cents: number | null;
  amount_max_cents: number | null;
  learned: number;
}

const RULE_BEFORE_COLUMNS = `position, match_field, match_text, account_id, category_id, kid_id, private_member_id, ignore_txn,
  owner_member_id, amount_min_cents, amount_max_cents, learned`;

interface Candidate {
  id: number;
  name: string;
  memo: string | null;
  merchantName: string | null;
  accountId: number;
  amountCents: number;
}

const subjectOf = (t: Candidate) => ({
  name: t.memo ? `${t.name} ${t.memo}` : t.name,
  merchantName: t.merchantName,
  accountId: t.accountId,
  amountCents: t.amountCents,
});

/**
 * The rule a fix teaches: merchant key, plus an amount range at gas stations so a coffee stop
 * never drags fill-ups along (under the cutoff → 0..cutoff-1, otherwise cutoff and up).
 * Null when even the charge itself wouldn't match.
 */
function ruleFor(ctx: IngestContext, txn: StoredTxn): Rule | null {
  const merchant = txn.normalizedMerchant || normalizeMerchant(txn.merchantName || txn.name);
  const matchField: MatchField = txn.merchantName?.trim() ? 'merchant' : 'name';
  const cents = Math.abs(txn.amountCents);
  const gas = isGasStation({ merchant, bankDetailed: txn.plaidCategoryDetailed });
  const [amountMin, amountMax] = !gas ? [null, null] : cents < ctx.cutoffCents ? [0, ctx.cutoffCents - 1] : [ctx.cutoffCents, null];
  const subject = subjectOf(txn);
  const rule: Rule = { id: 0, position: 0, matchField, matchText: merchant, amountMin, amountMax, learned: true, action: {} };
  if (ruleMatches(rule, subject)) return rule;
  // Keys drop punctuation ("CHICK-FIL-A" → "CHICK FIL A"), which the raw text may not contain.
  if (txn.merchantName?.trim()) {
    const whole = { ...rule, matchText: normalizeText(txn.merchantName) };
    if (ruleMatches(whole, subject)) return whole;
  }
  return null;
}

/** The tapped charge's category as it was before the fix, so Undo can put it back. */
export type BeforeFix = Pick<StoredTxn, 'categoryId' | 'categorySource' | 'categoryReason' | 'ruleId'>;

/**
 * Learns from a hand fix of `txn` (already saved) to `categoryId`, re-files similar charges the viewer
 * can see, and records the move for Undo, including the tapped charge's values from `before`.
 */
export async function learnFromFix(
  db: D1Database,
  ctx: IngestContext,
  viewer: Viewer,
  txn: StoredTxn,
  categoryId: number,
  before: BeforeFix = txn,
): Promise<LearnResult> {
  const learned = ruleFor(ctx, txn);
  if (!learned) return { moved: 0, moveId: null, ruleId: null, merchant: '' };
  const merchant = learned.matchText;
  // A fix into your own fun money makes a private rule that only you see.
  const privateTo = ctx.funCategoryOwner.get(categoryId) === viewer.memberId ? viewer.memberId : null;

  const existing = await first<RuleBefore & { id: number }>(
    db,
    `SELECT id, ${RULE_BEFORE_COLUMNS} FROM rules
      WHERE learned = 1 AND match_field = ? AND match_text = ? AND amount_min_cents IS ? AND amount_max_cents IS ?
        AND private_member_id IS ? AND owner_member_id IS ?
      ORDER BY position, id LIMIT 1`,
    learned.matchField,
    merchant,
    learned.amountMin,
    learned.amountMax,
    // A shared rule and your private one for the same merchant are different rules: neither takes over the other.
    privateTo,
    privateTo,
  );

  const column = learned.matchField === 'merchant' ? "COALESCE(t.merchant_name, '')" : "(t.name || ' ' || COALESCE(t.memo, ''))";
  const candidates = await all<Candidate>(
    db,
    `SELECT t.id, t.name, t.memo, t.merchant_name AS merchantName, t.account_id AS accountId, t.amount_cents AS amountCents
       FROM transactions t
      WHERE t.deleted_at IS NULL AND t.id != ? AND t.is_split = 0 AND t.is_ignored = 0
        AND (t.category_source IS NULL OR t.category_source != 'user')
        AND t.category_id IS NOT ? AND ${PRIVACY_SQL}
        AND (? IS NULL OR ABS(t.amount_cents) >= ?) AND (? IS NULL OR ABS(t.amount_cents) <= ?)
        AND UPPER(${column}) LIKE ? ESCAPE '\\'
      ORDER BY t.date DESC, t.id DESC LIMIT ${REFILE_LIMIT}`,
    txn.id,
    categoryId,
    viewer.memberId,
    learned.amountMin,
    learned.amountMin,
    learned.amountMax,
    learned.amountMax,
    `%${merchant.toUpperCase().replace(/[\\%_]/g, '\\$&')}%`,
  );
  // The same account check classify() uses, so re-filing never does what a later sync would undo.
  const asSaved: Rule = { ...learned, action: privateTo === null ? {} : { privateMemberId: privateTo } };
  const refile = candidates
    .filter((t) => ruleAppliesToAccount(asSaved, ctx.privateAccountOwner.get(t.accountId) ?? null) && ruleMatches(learned, subjectOf(t)))
    .map((t) => t.id);

  const now = nowIso();
  let ruleId: number;
  let moveId: number;
  if (existing) {
    ruleId = existing.id;
    const [, moveResult] = await db.batch([
      stmt(
        db,
        'UPDATE rules SET category_id = ?, private_member_id = ?, owner_member_id = ?, updated_at = ? WHERE id = ?',
        categoryId,
        privateTo,
        privateTo,
        now,
        ruleId,
      ),
      stmt(
        db,
        `INSERT INTO category_moves (member_id, rule_id, rule_before, tapped_transaction_id, fix_category_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
        viewer.memberId,
        ruleId,
        JSON.stringify(Object.fromEntries(Object.entries(existing).filter(([key]) => key !== 'id'))),
        txn.id,
        categoryId,
        now,
      ),
    ]);
    moveId = (moveResult?.results?.[0] as { id: number }).id;
  } else {
    // Learned rules go to the top, ahead of everything else.
    const [ruleResult, moveResult] = await db.batch([
      stmt(
        db,
        `INSERT INTO rules (position, match_field, match_text, category_id, private_member_id, owner_member_id,
           amount_min_cents, amount_max_cents, learned)
         VALUES ((SELECT COALESCE(MIN(position), 1000) - 10 FROM rules), ?, ?, ?, ?, ?, ?, ?, 1) RETURNING id`,
        learned.matchField,
        merchant,
        categoryId,
        privateTo,
        privateTo,
        learned.amountMin,
        learned.amountMax,
      ),
      stmt(
        db,
        `INSERT INTO category_moves (member_id, rule_id, rule_before, tapped_transaction_id, fix_category_id, created_at)
         VALUES (?, last_insert_rowid(), NULL, ?, ?, ?) RETURNING id, rule_id AS ruleId`,
        viewer.memberId,
        txn.id,
        categoryId,
        now,
      ),
    ]);
    ruleId = (ruleResult?.results?.[0] as { id: number }).id;
    const move = moveResult?.results?.[0] as { id: number; ruleId: number };
    if (move.ruleId !== ruleId) throw new Error('Learned rule and its move got out of step');
    moveId = move.id;
  }

  // Each group snapshots the old values and re-files in the same atomic batch.
  const filedPrivate = ctx.funCategoryOwner.get(categoryId) ?? null;
  const statements = [
    stmt(
      db,
      `INSERT INTO category_move_items (move_id, transaction_id, old_category_id, old_source, old_reason, old_rule_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      moveId,
      txn.id,
      before.categoryId,
      before.categorySource,
      before.categoryReason,
      before.ruleId,
    ),
    ...chunk(refile, IDS_PER_STATEMENT).flatMap((ids) => [
    stmt(
      db,
      `INSERT INTO category_move_items (move_id, transaction_id, old_category_id, old_source, old_reason, old_rule_id)
       SELECT ?, id, category_id, category_source, category_reason, rule_id FROM transactions WHERE id IN (${placeholders(ids.length)})`,
      moveId,
      ...ids,
    ),
    stmt(
      db,
      `UPDATE transactions SET category_id = ?, category_source = 'rule', category_reason = ?, rule_id = ?, private_member_id = ?,
         updated_at = ? WHERE id IN (${placeholders(ids.length)})`,
      categoryId,
      LEARNED_REASON,
      ruleId,
      filedPrivate,
      now,
      ...ids,
    ),
  ]),
  ];
  // Keep each snapshot+update pair in one atomic batch: the tapped charge's item shifts pairs by one.
  await batchAll(db, statements.slice(0, 1));
  await batchAll(db, statements.slice(1));

  return { moved: refile.length, moveId, ruleId, merchant };
}

/**
 * Puts back what a move did: each recorded charge's old category, source and reason, and the learned
 * rule as it was (or gone, if the move made it). Re-filed charges someone has since picked by hand or
 * split are left alone; the tapped charge goes back only if it is still exactly what the fix set.
 * Only the latest move for a rule can be undone, and only by the person who made it.
 */
export async function undoMove(db: D1Database, viewer: Viewer, moveId: number): Promise<{ restored: number }> {
  const move = await first<{
    id: number;
    memberId: number | null;
    ruleId: number | null;
    ruleBefore: string | null;
    tappedId: number | null;
    fixCategoryId: number | null;
  }>(
    db,
    `SELECT id, member_id AS memberId, rule_id AS ruleId, rule_before AS ruleBefore,
            tapped_transaction_id AS tappedId, fix_category_id AS fixCategoryId
       FROM category_moves WHERE id = ?`,
    moveId,
  );
  if (!move) throw notFound('Nothing to undo');
  if (move.memberId !== viewer.memberId) throw new HttpError(403, 'Only the person who made this change can undo it.');
  if (move.ruleId !== null) {
    const later = await first(db, 'SELECT 1 AS x FROM category_moves WHERE rule_id = ? AND id > ?', move.ruleId, move.id);
    if (later) throw new HttpError(409, 'Already changed again');
  }
  const now = nowIso();
  const before = move.ruleBefore ? (JSON.parse(move.ruleBefore) as RuleBefore) : null;
  const statements: D1PreparedStatement[] = [
    // Privacy follows the old category: fun money is private to its person, anything else is shared.
    stmt(
      db,
      `UPDATE transactions SET category_id = i.old_category_id, category_source = i.old_source, category_reason = i.old_reason,
         rule_id = (SELECT r.id FROM rules r WHERE r.id = i.old_rule_id),
         private_member_id = (SELECT c.fun_member_id FROM categories c WHERE c.id = i.old_category_id),
         updated_at = ?
         FROM category_move_items i
        WHERE i.move_id = ? AND i.transaction_id = transactions.id AND transactions.is_split = 0
          AND CASE WHEN i.transaction_id IS ?
                   THEN transactions.category_source IS 'user' AND transactions.category_id IS ?
                   ELSE transactions.category_source IS NOT 'user' END`,
      now,
      move.id,
      move.tappedId,
      move.fixCategoryId,
    ),
  ];
  if (before && move.ruleId !== null) {
    statements.push(
      stmt(
        db,
        `UPDATE rules SET position = ?, match_field = ?, match_text = ?, account_id = (SELECT id FROM accounts WHERE id = ?),
           category_id = (SELECT id FROM categories WHERE id = ?), kid_id = (SELECT id FROM kids WHERE id = ?),
           private_member_id = ?, ignore_txn = ?, owner_member_id = ?, amount_min_cents = ?, amount_max_cents = ?, learned = ?,
           updated_at = ?
         WHERE id = ?`,
        before.position,
        before.match_field,
        before.match_text,
        before.account_id,
        before.category_id,
        before.kid_id,
        before.private_member_id,
        before.ignore_txn,
        before.owner_member_id,
        before.amount_min_cents,
        before.amount_max_cents,
        before.learned,
        now,
        move.ruleId,
      ),
    );
  }
  statements.push(stmt(db, 'DELETE FROM category_move_items WHERE move_id = ?', move.id));
  statements.push(stmt(db, 'DELETE FROM category_moves WHERE id = ?', move.id));
  const [restore] = await db.batch(statements);
  const restored = restore?.meta.changes ?? 0;

  if (!before && move.ruleId !== null) {
    // The move made the rule: remove it, and re-sort charges it has filed since (new syncs).
    const affected = await all<StoredTxn>(db, `${STORED_SELECT} WHERE t.rule_id = ? AND t.deleted_at IS NULL`, move.ruleId);
    await run(db, 'DELETE FROM rules WHERE id = ?', move.ruleId);
    if (affected.length) await reclassify(db, await loadIngestContext(db), affected);
  }
  return { restored };
}

/** Undo lasts a day. */
export async function cleanupCategoryMoves(db: D1Database): Promise<void> {
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  await db.batch([
    stmt(db, 'DELETE FROM category_move_items WHERE move_id IN (SELECT id FROM category_moves WHERE created_at < ?)', dayAgo),
    stmt(db, 'DELETE FROM category_moves WHERE created_at < ?', dayAgo),
  ]);
}
