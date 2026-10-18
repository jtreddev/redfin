import type { ISODate } from '../../shared/dates';
import type { Cents } from '../../shared/money';
import { matchPaycheck } from '../../shared/paychecks';
import { autoLayers, billFor, ruleResult, type AutoSubject } from '../../shared/autoCategory';
import { findPreparedRule, ruleSubjectName, matchTextOf, normalizeMerchant, preparedMatches, type CategorySource, type Rule } from '../../shared/rules';
import { looksLikeTransfer } from '../../shared/transfers';
import { allByIds, batchAll, nowIso, stmt } from '../lib/db';
import { loadIngestContext, type IngestContext } from './context';

export interface IncomingTxn {
  accountId: number;
  date: ISODate;
  amountCents: Cents;
  name: string;
  merchantName?: string | null;
  memo?: string | null;
  pending?: boolean;
  source: 'plaid' | 'import' | 'manual';
  plaidTxnId?: string | null;
  pendingTxnId?: string | null;
  plaidCategory?: string | null;
  plaidCategoryDetailed?: string | null;
  importFitid?: string | null;
  importHash?: string | null;
  importBatchId?: number | null;
  createdByMemberId?: number | null;
  /** Classification to keep (e.g. from the pending version of a posted transaction). */
  carry?: Classification;
}

export interface Classification {
  categoryId: number | null;
  categorySource: CategorySource;
  /** Why the category was picked automatically, e.g. "Under $25 at a gas station". */
  categoryReason: string | null;
  ruleId: number | null;
  kidId: number | null;
  privateMemberId: number | null;
  isIgnored: boolean;
  incomeSourceId: number | null;
  payDate: ISODate | null;
  normalizedMerchant: string;
}

type Classifiable = Pick<
  IncomingTxn,
  'accountId' | 'date' | 'amountCents' | 'name' | 'merchantName' | 'memo' | 'plaidCategory' | 'plaidCategoryDetailed'
> & {
  /** The other half when this is a matched transfer between your own accounts. */
  transferPairId?: number | null;
};

const PAYCHECK_REASON = 'Matches your paycheck';
const isSharedLearned = (rule: Rule) => !!rule.learned && rule.action.privateMemberId == null;
const CARD_PAYMENT_REASON = 'Card payment';
const PERSONAL_CARD_REASON = 'Your personal card';
const PAIRED_TRANSFER_REASON = 'Moved between your accounts';

/**
 * Decides category, kid, privacy and ignore for a transaction. Anything a person set
 * by hand is kept; automatic choices (rules, paycheck matching, saved bills, personal-card
 * defaults, built-in patterns, the bank's category, card payments) are re-derived each time.
 */
export function classify(ctx: IngestContext, txn: Classifiable, current?: Partial<Classification>): Classification {
  const out: Classification = {
    categoryId: current?.categoryId ?? null,
    categorySource: current?.categorySource ?? null,
    categoryReason: current?.categoryReason ?? null,
    ruleId: current?.ruleId ?? null,
    kidId: current?.kidId ?? null,
    privateMemberId: current?.privateMemberId ?? null,
    isIgnored: current?.isIgnored ?? false,
    incomeSourceId: null,
    payDate: null,
    normalizedMerchant: normalizeMerchant(txn.merchantName || txn.name),
  };

  const paired = txn.transferPairId != null;
  const paycheck = matchPaycheck(ctx.paySources, txn);
  if (paycheck) {
    out.incomeSourceId = paycheck.sourceId;
    out.payDate = paycheck.payDate;
  }
  if (out.categorySource === 'user') return out;

  if (out.categorySource === 'rule' || out.categorySource === 'auto') {
    Object.assign(out, {
      categoryId: null,
      categorySource: null,
      categoryReason: null,
      ruleId: null,
      kidId: null,
      privateMemberId: null,
      isIgnored: false,
    });
  }

  const subjectName = ruleSubjectName(txn.name, txn.memo);
  const accountOwner = ctx.privateAccountOwner.get(txn.accountId) ?? null;
  const subject: AutoSubject = {
    name: subjectName,
    merchantName: txn.merchantName ?? null,
    merchant: out.normalizedMerchant,
    accountId: txn.accountId,
    amountCents: txn.amountCents,
    bankDetailed: txn.plaidCategoryDetailed ?? null,
    bankPrimary: txn.plaidCategory ?? null,
    accountOwner,
  };

  // Each charge's text is normalized once, and the rules were prepared once per context.
  const text = matchTextOf(subject);
  const rules = ctx.rulesFor(accountOwner);
  let rule = findPreparedRule(rules, text);
  // A shared learned rule never takes over a charge your own private rule files: it would un-private it.
  if (rule && isSharedLearned(rule) && rules.some((p) => !p.rule.learned && p.rule.action.privateMemberId != null && preparedMatches(p, text))) {
    rule = findPreparedRule(rules.filter((p) => !isSharedLearned(p.rule)), text);
  }
  let ruleReason: string | null = null;
  let privateByRule = false;
  // A rule (typed or learned) comes from a person, so it may file a paired transfer under any category.
  let categoryByRule = false;
  if (rule) {
    const auto = ruleResult(rule);
    const action = rule.action;
    out.categoryId = action.categoryId ?? null;
    out.categoryReason = auto.reason;
    out.kidId = action.kidId ?? null;
    out.privateMemberId = action.privateMemberId ?? null;
    out.isIgnored = !!action.ignore;
    out.ruleId = auto.ruleId;
    out.categorySource = 'rule';
    ruleReason = auto.reason;
    privateByRule = out.privateMemberId !== null;
    categoryByRule = out.categoryId !== null || privateByRule;
    // A kid-only or private-only rule doesn't pick a category, so the other layers below still can.
  }

  if (out.categoryId === null && !out.isIgnored) {
    const source = out.categorySource ?? 'auto';
    const privateOwner = ctx.privateAccountOwner.get(txn.accountId);
    // Bills, built-in patterns and the bank's category, worked out once.
    const auto = autoLayers(subject, ctx);
    if (paycheck && ctx.paychecksCategoryId) {
      Object.assign(out, { categoryId: ctx.paychecksCategoryId, categorySource: source, categoryReason: PAYCHECK_REASON });
    } else if (
      !paired &&
      privateOwner !== undefined &&
      txn.amountCents < 0 &&
      out.privateMemberId === null &&
      // Saved bills come before the personal-card default; built-in patterns and the bank's category after it.
      billFor(subject, ctx.bills) === null
    ) {
      Object.assign(out, { privateMemberId: privateOwner, categorySource: source, categoryReason: PERSONAL_CARD_REASON });
    } else if (auto.categoryId !== null) {
      Object.assign(out, { categoryId: auto.categoryId, categorySource: source, categoryReason: auto.reason });
    } else if (
      txn.amountCents > 0 &&
      ctx.accountType.get(txn.accountId) === 'credit' &&
      ctx.cardPaymentCategoryId &&
      looksLikeTransfer({ id: 0, accountId: txn.accountId, date: txn.date, amountCents: txn.amountCents, name: subjectName })
    ) {
      Object.assign(out, { categoryId: ctx.cardPaymentCategoryId, categorySource: source, categoryReason: CARD_PAYMENT_REASON });
    }
  }

  const final = enforceFunMoney(ctx, out);
  if (final.categoryId !== out.categoryId) {
    // Moved into someone's fun money: the reason is why it's private, not what the bank thought.
    final.categoryReason = privateByRule ? ruleReason : PERSONAL_CARD_REASON;
  }
  // The automatic layers (bills, built-in patterns, the bank) only ever file half of a matched transfer as
  // Transfers; a rule may still count it, e.g. as savings. Kid tag, ignore and a kid-only rule stay.
  if (paired && !categoryByRule && !final.isIgnored && ctx.cardPaymentCategoryId && final.categoryId !== ctx.cardPaymentCategoryId) {
    Object.assign(final, {
      categoryId: ctx.cardPaymentCategoryId,
      categorySource: final.categorySource === 'rule' ? 'rule' : 'auto',
      categoryReason: PAIRED_TRANSFER_REASON,
      privateMemberId: null,
    });
  }
  return final;
}

/** Private ⇔ filed under that person's fun money. */
export function enforceFunMoney(ctx: IngestContext, k: Classification): Classification {
  if (k.categoryId !== null) {
    const owner = ctx.funCategoryOwner.get(k.categoryId);
    if (owner !== undefined) return { ...k, privateMemberId: owner };
  }
  if (k.privateMemberId !== null) {
    const funCategory = ctx.funCategoryByMember.get(k.privateMemberId);
    if (funCategory !== undefined) return { ...k, categoryId: funCategory };
  }
  return k;
}

const INSERT_SQL = `INSERT OR IGNORE INTO transactions (
  account_id, date, amount_cents, name, merchant_name, normalized_merchant, memo, pending, source,
  plaid_txn_id, pending_txn_id, plaid_category, plaid_category_detailed, import_fitid, import_hash, import_batch_id,
  category_id, category_source, category_reason, rule_id, kid_id, private_member_id, income_source_id, pay_date,
  is_ignored, created_by_member_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`;

export interface InsertResult {
  inserted: number;
  duplicates: number;
  insertedIds: number[];
  minDate: ISODate | null;
  maxDate: ISODate | null;
}

/** Inserts classified rows; rows that hit a dedupe key (FITID, CSV key, Plaid id) are skipped. */
export async function insertTransactions(
  db: D1Database,
  ctx: IngestContext,
  rows: readonly IncomingTxn[],
): Promise<InsertResult> {
  const statements = rows.map((row) => {
    const k = row.carry ? enforceFunMoney(ctx, { ...classify(ctx, row, row.carry), ...pickUserFields(row.carry) }) : classify(ctx, row);
    return stmt(
      db,
      INSERT_SQL,
      row.accountId,
      row.date,
      row.amountCents,
      row.name,
      row.merchantName,
      k.normalizedMerchant,
      row.memo,
      row.pending ? 1 : 0,
      row.source,
      row.plaidTxnId,
      row.pendingTxnId,
      row.plaidCategory,
      row.plaidCategoryDetailed,
      row.importFitid,
      row.importHash,
      row.importBatchId,
      k.categoryId,
      k.categorySource,
      k.categoryReason,
      k.ruleId,
      k.kidId,
      k.privateMemberId,
      k.incomeSourceId,
      k.payDate,
      k.isIgnored ? 1 : 0,
      row.createdByMemberId,
    );
  });

  const results = await batchAll(db, statements);
  const insertedIds: number[] = [];
  let minDate: ISODate | null = null;
  let maxDate: ISODate | null = null;
  results.forEach((result, i) => {
    const id = (result.results?.[0] as { id?: number } | undefined)?.id;
    const row = rows[i];
    if (id === undefined || !row) return;
    insertedIds.push(id);
    if (!minDate || row.date < minDate) minDate = row.date;
    if (!maxDate || row.date > maxDate) maxDate = row.date;
  });
  return { inserted: insertedIds.length, duplicates: rows.length - insertedIds.length, insertedIds, minDate, maxDate };
}

/** Fields a person set by hand that must survive (pending → posted). */
function pickUserFields(carry: Classification): Partial<Classification> {
  return carry.categorySource === 'user'
    ? {
        categoryId: carry.categoryId,
        categorySource: 'user',
        categoryReason: carry.categoryReason,
        kidId: carry.kidId,
        privateMemberId: carry.privateMemberId,
        isIgnored: carry.isIgnored,
      }
    : {};
}

export interface StoredTxn {
  id: number;
  accountId: number;
  date: ISODate;
  amountCents: Cents;
  name: string;
  merchantName: string | null;
  memo: string | null;
  categoryId: number | null;
  categorySource: CategorySource;
  categoryReason: string | null;
  ruleId: number | null;
  kidId: number | null;
  privateMemberId: number | null;
  isIgnored: number;
  isSplit: number;
  plaidCategory: string | null;
  plaidCategoryDetailed: string | null;
  incomeSourceId: number | null;
  payDate: ISODate | null;
  normalizedMerchant: string | null;
  transferPairId: number | null;
}

export const STORED_SELECT = `SELECT t.id, t.account_id AS accountId, t.date, t.amount_cents AS amountCents, t.name,
  t.merchant_name AS merchantName, t.memo, t.category_id AS categoryId, t.category_source AS categorySource,
  t.category_reason AS categoryReason, t.is_split AS isSplit, t.plaid_category AS plaidCategory,
  t.plaid_category_detailed AS plaidCategoryDetailed, t.rule_id AS ruleId, t.kid_id AS kidId, t.private_member_id AS privateMemberId, t.is_ignored AS isIgnored,
  t.income_source_id AS incomeSourceId, t.pay_date AS payDate, t.normalized_merchant AS normalizedMerchant,
  t.transfer_pair_id AS transferPairId
  FROM transactions t`;

/** Rows whose classification would change under `ctx`, with the new classification. Split rows are left alone. */
export function classificationChanges(ctx: IngestContext, rows: readonly StoredTxn[]): { row: StoredTxn; k: Classification }[] {
  const changes: { row: StoredTxn; k: Classification }[] = [];
  for (const row of rows) {
    if (row.isSplit === 1) continue;
    const k = classify(ctx, row, {
      categoryId: row.categoryId,
      categorySource: row.categorySource,
      categoryReason: row.categoryReason,
      ruleId: row.ruleId,
      kidId: row.kidId,
      privateMemberId: row.privateMemberId,
      isIgnored: row.isIgnored === 1,
    });
    const changed =
      k.categoryId !== row.categoryId ||
      k.categorySource !== row.categorySource ||
      k.categoryReason !== row.categoryReason ||
      k.ruleId !== row.ruleId ||
      k.kidId !== row.kidId ||
      k.privateMemberId !== row.privateMemberId ||
      k.isIgnored !== (row.isIgnored === 1) ||
      k.incomeSourceId !== row.incomeSourceId ||
      k.payDate !== row.payDate ||
      k.normalizedMerchant !== row.normalizedMerchant;
    if (changed) changes.push({ row, k });
  }
  return changes;
}

/**
 * Re-runs classification over stored rows (after rules change). Everything that changes is saved; split rows are
 * left alone. Returns rows updated, or with `visibleTo` only those that person may see (not a partner's private ones).
 */
export async function reclassify(db: D1Database, ctx: IngestContext, rows: readonly StoredTxn[], visibleTo?: number): Promise<number> {
  const now = nowIso();
  const statements: D1PreparedStatement[] = [];
  let visible = 0;
  for (const { row, k } of classificationChanges(ctx, rows)) {
    if (visibleTo === undefined || row.privateMemberId === null || row.privateMemberId === visibleTo) visible++;
    statements.push(
      stmt(
        db,
        `UPDATE transactions SET category_id = ?, category_source = ?, category_reason = ?, rule_id = ?, kid_id = ?,
           private_member_id = ?, is_ignored = ?, income_source_id = ?, pay_date = ?, normalized_merchant = ?, updated_at = ?
         WHERE id = ?`,
        k.categoryId,
        k.categorySource,
        k.categoryReason,
        k.ruleId,
        k.kidId,
        k.privateMemberId,
        k.isIgnored ? 1 : 0,
        k.incomeSourceId,
        k.payDate,
        k.normalizedMerchant,
        now,
        row.id,
      ),
    );
  }
  await batchAll(db, statements);
  return visible;
}

/** Re-derives automatic choices for these rows, e.g. after they were paired or unpaired as a transfer. */
export async function rederive(db: D1Database, ids: readonly number[], ctx?: IngestContext): Promise<number> {
  if (!ids.length) return 0;
  const rows = await allByIds<StoredTxn>(db, (list) => `${STORED_SELECT} WHERE t.deleted_at IS NULL AND t.id IN (${list})`, ids);
  return reclassify(db, ctx ?? (await loadIngestContext(db)), rows);
}
