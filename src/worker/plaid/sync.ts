import { addDays, todayIn, type ISODate } from '../../shared/dates';
import { findImportedTwin } from '../../shared/dedupe';
import type { Env } from '../env';
import { all, allByIds, batchAll, first, nowIso, placeholders, run, stmt } from '../lib/db';
import { loadIngestContext } from '../services/context';
import { insertTransactions, reclassify, STORED_SELECT, type IncomingTxn, type StoredTxn } from '../services/ingest';
import { matchTransfers } from '../services/transfers';
import {
  dollarsOrNull,
  plaid,
  plaidAmountToCents,
  PlaidError,
  type InvestmentTransaction,
  type LiabilitiesResponse,
  type PlaidAccount,
  type PlaidTransaction,
  type TransactionsSyncResponse,
} from './client';
import { decryptToken } from './crypto';

interface ItemRow {
  id: number;
  itemId: string;
  institutionName: string | null;
  accessTokenEnc: string;
  cursor: string | null;
  syncStartCursor: string | null;
  hasMore: number;
  historyComplete: number;
  status: 'ok' | 'login_required' | 'error';
  liabilitiesUpdatedAt: string | null;
  balancesUpdatedAt: string | null;
}

const ITEM_SELECT = `SELECT id, item_id AS itemId, institution_name AS institutionName, access_token_enc AS accessTokenEnc,
  cursor, sync_start_cursor AS syncStartCursor, has_more AS hasMore, history_complete AS historyComplete, status,
  liabilities_updated_at AS liabilitiesUpdatedAt, balances_updated_at AS balancesUpdatedAt
  FROM plaid_items`;

const LOGIN_ERRORS = new Set(['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'PENDING_DISCONNECT', 'ITEM_LOCKED', 'USER_SETUP_REQUIRED', 'ACCESS_NOT_GRANTED']);
const PAGE_SIZE = 100;

export function accountTypeFor(account: PlaidAccount): { type: string; isCash: boolean } {
  switch (account.type) {
    case 'depository': {
      // Only everyday money counts as spendable cash in the weekly plan; savings, CDs and HSAs don't.
      const subtype = account.subtype ?? '';
      if (/savings|money market|cd|hsa/i.test(subtype)) return { type: 'savings', isCash: false };
      return { type: 'checking', isCash: true };
    }
    case 'credit':
      return { type: 'credit', isCash: false };
    case 'loan':
      return { type: 'loan', isCash: false };
    case 'investment':
    case 'brokerage':
      // Fidelity's Cash Management Account reports as an investment account.
      return { type: 'investment', isCash: /cash management/i.test(account.subtype ?? '') };
    default:
      return { type: 'other', isCash: false };
  }
}

/** Creates or refreshes accounts for an Item. Names and settings you changed are kept. */
export async function upsertPlaidAccounts(
  db: D1Database,
  itemRowId: number,
  institutionName: string | null,
  accounts: readonly PlaidAccount[],
): Promise<void> {
  const now = nowIso();
  await batchAll(
    db,
    accounts.map((a) => {
      const { type, isCash } = accountTypeFor(a);
      return stmt(
        db,
        `INSERT INTO accounts (name, institution, mask, type, is_cash, plaid_item_id, plaid_account_id,
                               current_balance_cents, available_balance_cents, credit_limit_cents, balance_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (plaid_account_id) DO UPDATE SET
           plaid_item_id = excluded.plaid_item_id,
           current_balance_cents = excluded.current_balance_cents,
           available_balance_cents = excluded.available_balance_cents,
           credit_limit_cents = excluded.credit_limit_cents,
           balance_updated_at = excluded.balance_updated_at,
           updated_at = excluded.balance_updated_at`,
        a.name || a.official_name || 'Account',
        institutionName,
        a.mask,
        type,
        isCash,
        itemRowId,
        a.account_id,
        dollarsOrNull(a.balances.current),
        dollarsOrNull(a.balances.available),
        dollarsOrNull(a.balances.limit),
        now,
      );
    }),
  );
}

function toIncoming(t: PlaidTransaction | InvestmentTransaction, accountId: number): IncomingTxn {
  if ('investment_transaction_id' in t) {
    return {
      accountId,
      date: t.date,
      amountCents: plaidAmountToCents(t.amount),
      name: t.name,
      source: 'plaid',
      plaidTxnId: `inv-${t.investment_transaction_id}`,
      plaidCategory: `INVESTMENT_${t.type.toUpperCase()}`,
    };
  }
  return {
    accountId,
    date: t.date,
    amountCents: plaidAmountToCents(t.amount),
    name: t.original_description || t.name,
    merchantName: t.merchant_name,
    pending: t.pending,
    source: 'plaid',
    plaidTxnId: t.transaction_id,
    pendingTxnId: t.pending_transaction_id,
    plaidCategory: t.personal_finance_category?.primary ?? null,
  };
}

export interface SyncStepResult {
  itemId: number | null;
  institutionName: string | null;
  /** True when there's nothing left to do for this request. */
  done: boolean;
  added: number;
  modified: number;
  removed: number;
  status: 'ok' | 'login_required' | 'error' | 'idle';
  error?: string;
  /** Friendly heads-up, e.g. history still loading. */
  note?: string;
}

async function pickItem(
  db: D1Database,
  itemId: number | undefined,
  since: string | undefined,
  excludeIds: readonly number[],
): Promise<ItemRow | null> {
  if (itemId) return first<ItemRow>(db, `${ITEM_SELECT} WHERE id = ?`, itemId);
  const exclude = excludeIds.length ? `AND id NOT IN (${placeholders(excludeIds.length)})` : '';
  if (since) {
    // "Sync now": each bank once since the button was pressed, plus any page still in progress.
    return first<ItemRow>(
      db,
      `${ITEM_SELECT}
        WHERE status = 'ok' AND (has_more = 1 OR last_attempt_at IS NULL OR last_attempt_at < ?) ${exclude}
        ORDER BY has_more DESC, COALESCE(last_attempt_at, '') ASC
        LIMIT 1`,
      since,
      ...excludeIds,
    );
  }
  // Cron: anything mid-page, still loading history, or not synced in 6 hours.
  return first<ItemRow>(
    db,
    `${ITEM_SELECT}
      WHERE status = 'ok'
        AND (has_more = 1 OR history_complete = 0 OR last_synced_at IS NULL OR last_synced_at < ?)
        ${exclude}
      ORDER BY has_more DESC, COALESCE(last_synced_at, '') ASC
      LIMIT 1`,
    new Date(Date.now() - 6 * 3_600_000).toISOString(),
    ...excludeIds,
  );
}

/**
 * One small unit of sync work: a single page of up to 100 transactions for one bank.
 * Safe to repeat; the cursor is saved only after the page is stored. Cron and the
 * "Sync now" button both call this until it reports done.
 */
export async function syncStep(
  env: Env,
  {
    itemId,
    trigger,
    since,
    excludeIds = [],
  }: { itemId?: number; trigger: 'cron' | 'manual' | 'link'; since?: string; excludeIds?: readonly number[] },
): Promise<SyncStepResult> {
  const db = env.DB;
  const item = await pickItem(db, itemId, since, excludeIds);
  if (!item) return { itemId: null, institutionName: null, done: true, added: 0, modified: 0, removed: 0, status: 'idle' };

  const now = nowIso();
  const runRow = await first<{ id: number }>(
    db,
    'INSERT INTO sync_runs (plaid_item_id, trigger) VALUES (?, ?) RETURNING id',
    item.id,
    trigger,
  );
  await run(db, 'UPDATE plaid_items SET last_attempt_at = ? WHERE id = ?', now, item.id);

  const base = { itemId: item.id, institutionName: item.institutionName };
  try {
    const accessToken = await decryptToken(env, item.accessTokenEnc);
    const paginationStart = item.hasMore ? item.syncStartCursor : item.cursor;

    let page: TransactionsSyncResponse;
    try {
      page = await plaid<TransactionsSyncResponse>(env, '/transactions/sync', {
        access_token: accessToken,
        ...(item.cursor ? { cursor: item.cursor } : {}),
        count: PAGE_SIZE,
        options: { include_original_description: true },
      });
    } catch (error) {
      if (error instanceof PlaidError && error.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') {
        await run(db, 'UPDATE plaid_items SET cursor = ?, has_more = 0 WHERE id = ?', paginationStart, item.id);
        await finishRun(db, runRow?.id, { status: 'ok', error: 'Restarted pagination' });
        return { ...base, done: false, added: 0, modified: 0, removed: 0, status: 'ok' };
      }
      throw error;
    }

    if (page.accounts?.length) {
      await upsertPlaidAccounts(db, item.id, item.institutionName, page.accounts);
      await run(db, 'UPDATE plaid_items SET balances_updated_at = ? WHERE id = ?', now, item.id);
    }
    const accountRows = await all<{ id: number; plaidAccountId: string }>(
      db,
      'SELECT id, plaid_account_id AS plaidAccountId FROM accounts WHERE plaid_item_id = ?',
      item.id,
    );
    const accountIdFor = new Map(accountRows.map((a) => [a.plaidAccountId, a.id]));
    const ctx = await loadIngestContext(db);

    const added = await applyAdded(db, ctx, page.added, accountIdFor);
    const modified = await applyModified(db, ctx, page.modified, accountIdFor);
    const removed = await applyRemoved(db, page.removed.map((r) => r.transaction_id));

    const dates = [...page.added, ...page.modified].map((t) => t.date).sort();
    if (dates.length) await matchTransfers(db, dates[0] as ISODate, dates[dates.length - 1] as ISODate);

    // Right after linking, the bank may still be preparing data; don't count that as synced.
    const updateStatus = page.transactions_update_status;
    const notReady = updateStatus === 'NOT_READY';
    const allHistoryIn = !updateStatus || updateStatus === 'HISTORICAL_UPDATE_COMPLETE' || updateStatus === 'TRANSACTIONS_UPDATE_STATUS_UNKNOWN';
    await run(
      db,
      `UPDATE plaid_items SET cursor = ?, sync_start_cursor = ?, has_more = ?,
         history_complete = CASE WHEN ? = 1 THEN 1 ELSE history_complete END,
         last_synced_at = CASE WHEN ? = 1 THEN ? ELSE last_synced_at END,
         status = 'ok', error_code = NULL, error_message = NULL, updated_at = ?
       WHERE id = ?`,
      page.next_cursor,
      page.has_more ? paginationStart : null,
      page.has_more ? 1 : 0,
      !page.has_more && allHistoryIn ? 1 : 0,
      !page.has_more && !notReady ? 1 : 0,
      now,
      now,
      item.id,
    );

    if (!page.has_more && !notReady) await refreshExtras(env, item, accessToken, accountIdFor);

    await finishRun(db, runRow?.id, { status: 'ok', added, modified, removed, hasMore: page.has_more });
    const note = notReady
      ? `${item.institutionName ?? 'The bank'} is still preparing your transactions. Try again in a few minutes.`
      : !page.has_more && !allHistoryIn
        ? 'Recent transactions are in; older history is still loading and will sync automatically.'
        : undefined;
    return { ...base, done: !page.has_more && Boolean(itemId), added, modified, removed, status: 'ok', ...(note ? { note } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof PlaidError ? error.code : 'INTERNAL';
    const status = LOGIN_ERRORS.has(code) ? 'login_required' : error instanceof PlaidError && error.type === 'ITEM_ERROR' ? 'error' : null;
    await run(
      db,
      `UPDATE plaid_items SET error_code = ?, error_message = ?, status = COALESCE(?, status), updated_at = ? WHERE id = ?`,
      code,
      message,
      status,
      now,
      item.id,
    );
    await finishRun(db, runRow?.id, { status: 'error', error: `${code}: ${message}` });
    return { ...base, done: true, added: 0, modified: 0, removed: 0, status: status ?? 'error', error: message };
  }
}

async function finishRun(
  db: D1Database,
  runId: number | undefined,
  r: { status: 'ok' | 'error'; added?: number; modified?: number; removed?: number; hasMore?: boolean; error?: string },
) {
  if (!runId) return;
  await run(
    db,
    `UPDATE sync_runs SET finished_at = ?, status = ?, added = ?, modified = ?, removed = ?, has_more = ?, error = ? WHERE id = ?`,
    nowIso(),
    r.status,
    r.added ?? 0,
    r.modified ?? 0,
    r.removed ?? 0,
    r.hasMore ? 1 : 0,
    r.error ?? null,
    runId,
  );
}

async function applyAdded(
  db: D1Database,
  ctx: Awaited<ReturnType<typeof loadIngestContext>>,
  added: readonly PlaidTransaction[],
  accountIdFor: Map<string, number>,
): Promise<number> {
  if (!added.length) return 0;
  const now = nowIso();

  // Pending versions (possibly already removed) whose details should carry over to the posted row.
  const pendingIds = added.map((t) => t.pending_transaction_id).filter((id): id is string => Boolean(id));
  const pendingRows = pendingIds.length
    ? await allByIds<StoredTxn & { plaidTxnId: string; notes: string | null; isSplit: number }>(
        db,
        (list) => `${STORED_SELECT.replace('FROM transactions t', ', t.plaid_txn_id AS plaidTxnId, t.notes, t.is_split AS isSplit FROM transactions t')} WHERE t.plaid_txn_id IN (${list})`,
        pendingIds,
      )
    : [];
  const pendingById = new Map(pendingRows.map((r) => [r.plaidTxnId, r]));

  // File-imported rows the synced transactions duplicate.
  const posted = added.filter((t) => !t.pending && !t.pending_transaction_id);
  const accountIds = [...new Set(posted.map((t) => accountIdFor.get(t.account_id)).filter((id): id is number => id !== undefined))];
  const dates = posted.map((t) => t.date).sort();
  const importRows = accountIds.length && dates.length
    ? await allByIds<{ id: number; accountId: number; date: ISODate; amountCents: number }>(
        db,
        (list) => `SELECT id, account_id AS accountId, date, amount_cents AS amountCents FROM transactions
                    WHERE source = 'import' AND plaid_txn_id IS NULL AND deleted_at IS NULL
                      AND account_id IN (${list}) AND date BETWEEN ? AND ?`,
        accountIds,
        addDays(dates[0] as ISODate, -2),
        addDays(dates[dates.length - 1] as ISODate, 2),
      )
    : [];

  const claimed = new Set<number>();
  const mergeStatements: D1PreparedStatement[] = [];
  const toInsert: IncomingTxn[] = [];
  const followUps: D1PreparedStatement[] = [];

  for (const t of added) {
    const accountId = accountIdFor.get(t.account_id);
    if (accountId === undefined) continue;
    const incoming = toIncoming(t, accountId);

    const pending = t.pending_transaction_id ? pendingById.get(t.pending_transaction_id) : undefined;
    if (pending) {
      incoming.carry = {
        categoryId: pending.categoryId,
        categorySource: pending.categorySource,
        ruleId: pending.ruleId,
        kidId: pending.kidId,
        privateMemberId: pending.privateMemberId,
        isIgnored: pending.isIgnored === 1,
        incomeSourceId: null,
        payDate: null,
        normalizedMerchant: pending.normalizedMerchant ?? '',
      };
      followUps.push(
        stmt(db, 'UPDATE transactions SET notes = ? WHERE plaid_txn_id = ?', pending.notes, t.transaction_id),
      );
      if (pending.isSplit === 1 && pending.amountCents === incoming.amountCents) {
        followUps.push(
          stmt(
            db,
            `INSERT INTO splits (transaction_id, category_id, kid_id, amount_cents, notes)
             SELECT (SELECT id FROM transactions WHERE plaid_txn_id = ?), category_id, kid_id, amount_cents, notes
               FROM splits WHERE transaction_id = ?`,
            t.transaction_id,
            pending.id,
          ),
          stmt(db, 'UPDATE transactions SET is_split = 1 WHERE plaid_txn_id = ?', t.transaction_id),
        );
      }
      followUps.push(stmt(db, 'DELETE FROM transactions WHERE id = ?', pending.id));
      toInsert.push(incoming);
      continue;
    }

    if (!t.pending) {
      const twin = findImportedTwin(incoming, importRows, 2, claimed);
      if (twin !== null) {
        claimed.add(twin);
        mergeStatements.push(
          stmt(
            db,
            `UPDATE transactions SET plaid_txn_id = ?, source = 'plaid', merchant_name = ?, plaid_category = ?,
               date = ?, pending = 0, updated_at = ? WHERE id = ?`,
            t.transaction_id,
            t.merchant_name,
            incoming.plaidCategory,
            t.date,
            now,
            twin,
          ),
        );
        continue;
      }
    }
    toInsert.push(incoming);
  }

  await batchAll(db, mergeStatements);
  const inserted = await insertTransactions(db, ctx, toInsert);
  await batchAll(db, followUps);
  return inserted.inserted + mergeStatements.length;
}

async function applyModified(
  db: D1Database,
  ctx: Awaited<ReturnType<typeof loadIngestContext>>,
  modified: readonly PlaidTransaction[],
  accountIdFor: Map<string, number>,
): Promise<number> {
  if (!modified.length) return 0;
  const now = nowIso();
  const statements = modified.flatMap((t) => {
    const accountId = accountIdFor.get(t.account_id);
    if (accountId === undefined) return [];
    const incoming = toIncoming(t, accountId);
    return [
      stmt(
        db,
        `UPDATE transactions SET account_id = ?, date = ?, amount_cents = ?, name = ?, merchant_name = ?, pending = ?,
           plaid_category = ?, updated_at = ? WHERE plaid_txn_id = ?`,
        accountId,
        incoming.date,
        incoming.amountCents,
        incoming.name,
        incoming.merchantName,
        incoming.pending ? 1 : 0,
        incoming.plaidCategory,
        now,
        t.transaction_id,
      ),
    ];
  });
  await batchAll(db, statements);
  const rows = await allByIds<StoredTxn>(db, (list) => `${STORED_SELECT} WHERE t.plaid_txn_id IN (${list})`, modified.map((t) => t.transaction_id));
  await reclassify(db, ctx, rows);
  return statements.length;
}

/** Removed rows are soft-deleted first so a later "posted" version can still inherit your edits. */
async function applyRemoved(db: D1Database, ids: readonly string[]): Promise<number> {
  if (!ids.length) return 0;
  const now = nowIso();
  await batchAll(db, ids.map((id) => stmt(db, 'UPDATE transactions SET deleted_at = ? WHERE plaid_txn_id = ? AND deleted_at IS NULL', now, id)));
  return ids.length;
}

/** Once a day per bank: credit card/loan details and Fidelity cash-management activity. */
async function refreshExtras(env: Env, item: ItemRow, accessToken: string, accountIdFor: Map<string, number>) {
  const db = env.DB;
  const dayAgo = new Date(Date.now() - 20 * 3_600_000).toISOString();
  if (item.liabilitiesUpdatedAt && item.liabilitiesUpdatedAt > dayAgo) return;
  const now = nowIso();

  const accounts = await all<{ id: number; type: string; isCash: number; plaidAccountId: string; name: string }>(
    db,
    'SELECT id, type, is_cash AS isCash, plaid_account_id AS plaidAccountId, name FROM accounts WHERE plaid_item_id = ?',
    item.id,
  );

  if (accounts.some((a) => a.type === 'credit' || a.type === 'loan')) {
    try {
      const response = await plaid<LiabilitiesResponse>(env, '/liabilities/get', { access_token: accessToken });
      await upsertDebts(db, response, accountIdFor);
    } catch (error) {
      if (!(error instanceof PlaidError)) throw error;
      // Liabilities not consented or not supported at this bank: keep debts manual.
    }
  }

  const cashInvestment = accounts.filter((a) => a.type === 'investment' && a.isCash === 1);
  if (cashInvestment.length) {
    try {
      const household = await first<{ timezone: string }>(db, 'SELECT timezone FROM household WHERE id = 1');
      const today = todayIn(household?.timezone ?? 'America/Chicago');
      const response = await plaid<{ investment_transactions: InvestmentTransaction[] }>(env, '/investments/transactions/get', {
        access_token: accessToken,
        start_date: addDays(today, item.historyComplete ? -30 : -730),
        end_date: today,
        options: { account_ids: cashInvestment.map((a) => a.plaidAccountId), count: PAGE_SIZE, offset: 0 },
      });
      const cashLike = response.investment_transactions.filter((t) => ['cash', 'fee', 'transfer'].includes(t.type));
      const ctx = await loadIngestContext(db);
      const rows = cashLike
        .map((t) => {
          const accountId = accountIdFor.get(t.account_id);
          return accountId === undefined ? null : toIncoming(t, accountId);
        })
        .filter((r): r is IncomingTxn => r !== null);
      await insertTransactions(db, ctx, rows);
    } catch (error) {
      if (!(error instanceof PlaidError)) throw error;
    }
  }

  await run(db, 'UPDATE plaid_items SET liabilities_updated_at = ? WHERE id = ?', now, item.id);
}

async function upsertDebts(db: D1Database, response: LiabilitiesResponse, accountIdFor: Map<string, number>) {
  const now = nowIso();
  const balances = new Map(response.accounts.map((a) => [a.account_id, a]));
  const entries = [
    ...(response.liabilities.credit ?? []).map((c) => ({
      plaidAccountId: c.account_id,
      apr: c.aprs.find((a) => a.apr_type === 'purchase_apr')?.apr_percentage ?? c.aprs[0]?.apr_percentage ?? 0,
      minPayment: c.minimum_payment_amount,
      dueDate: c.next_payment_due_date,
    })),
    ...(response.liabilities.student ?? []).map((s) => ({
      plaidAccountId: s.account_id,
      apr: s.interest_rate_percentage,
      minPayment: s.minimum_payment_amount,
      dueDate: s.next_payment_due_date,
    })),
  ];

  for (const entry of entries) {
    if (!entry.plaidAccountId) continue;
    const accountId = accountIdFor.get(entry.plaidAccountId);
    const account = balances.get(entry.plaidAccountId);
    if (accountId === undefined || !account) continue;
    const balance = dollarsOrNull(account.balances.current) ?? 0;
    const minPayment = dollarsOrNull(entry.minPayment) ?? 0;
    const dueDay = entry.dueDate ? Number(entry.dueDate.slice(8, 10)) : null;
    const existing = await first<{ id: number }>(db, 'SELECT id FROM debts WHERE account_id = ?', accountId);
    if (existing) {
      await run(
        db,
        `UPDATE debts SET balance_cents = ?, apr_percent = ?, min_payment_cents = ?, due_day = COALESCE(?, due_day),
           source = 'plaid', updated_at = ? WHERE id = ?`,
        balance,
        entry.apr,
        minPayment,
        dueDay,
        now,
        existing.id,
      );
    } else {
      await run(
        db,
        `INSERT INTO debts (name, account_id, balance_cents, apr_percent, min_payment_cents, due_day, source)
         VALUES (?, ?, ?, ?, ?, ?, 'plaid')`,
        account.name,
        accountId,
        balance,
        entry.apr,
        minPayment,
        dueDay,
      );
    }
  }
}

/** Cron: one sync step, then light housekeeping. */
export async function runCron(env: Env): Promise<void> {
  await syncStep(env, { trigger: 'cron' });
  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const quarterAgo = new Date(Date.now() - 90 * 86_400_000).toISOString();
  await env.DB.batch([
    stmt(env.DB, `DELETE FROM transactions WHERE source = 'plaid' AND deleted_at IS NOT NULL AND deleted_at < ?`, monthAgo),
    stmt(env.DB, 'DELETE FROM sync_runs WHERE started_at < ?', quarterAgo),
  ]);
}
