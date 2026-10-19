import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncStep } from '../src/worker/plaid/sync';
import type { Env } from '../src/worker/env';
import type { LiabilitiesResponse, PlaidAccount, PlaidTransaction } from '../src/worker/plaid/client';
import { api } from './helpers/api';
import { TestD1 } from './helpers/d1';
import { page, plaidTxn, seedBank, stubPlaid, testEnv } from './helpers/plaid';

let db: TestD1;
let env: Env;

beforeEach(() => {
  db = new TestD1();
  env = testEnv(db);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const txns = () =>
  db.rows<{ id: number; plaidTxnId: string | null; source: string; amountCents: number; date: string; importHash: string | null }>(
    `SELECT id, plaid_txn_id AS plaidTxnId, source, amount_cents AS amountCents, date, import_hash AS importHash
       FROM transactions WHERE deleted_at IS NULL ORDER BY id`,
  );

function insertImported(accountId: number, date: string, amountCents: number, name = 'Imported row') {
  db.exec(
    `INSERT INTO transactions (account_id, date, amount_cents, name, source, import_hash) VALUES (?, ?, ?, ?, 'import', ?)`,
    accountId,
    date,
    amountCents,
    name,
    `${accountId}|${date}|${amountCents}|${name}|0`,
  );
}

describe('syncStep', () => {
  it('saves card balances to the cent, and an overpaid card is not a debt', async () => {
    const { itemId } = await seedBank(db, env, 'card');
    db.exec(`UPDATE plaid_items SET liabilities_updated_at = NULL WHERE id = ?`, itemId);
    const card = (id: string, current: number): PlaidAccount => ({
      account_id: id,
      name: id,
      official_name: null,
      mask: null,
      type: 'credit',
      subtype: 'credit card',
      balances: { current, available: null, limit: 5000, iso_currency_code: 'USD' },
    });
    const accounts = [card('owed', 842.17), card('overpaid', -42.5)];
    const liabilities: LiabilitiesResponse = {
      accounts,
      liabilities: {
        credit: accounts.map((a) => ({
          account_id: a.account_id,
          aprs: [{ apr_percentage: 24.99, apr_type: 'purchase_apr' }],
          minimum_payment_amount: 35,
          next_payment_due_date: '2026-11-05',
          last_statement_balance: null,
        })),
      },
    };
    vi.stubGlobal('fetch', async (url: string) =>
      Response.json(new URL(url).pathname === '/liabilities/get' ? liabilities : page([], { accounts })),
    );

    await syncStep(env, { trigger: 'cron' });

    expect(db.rows(`SELECT plaid_account_id AS id, current_balance_cents AS cents FROM accounts WHERE type = 'credit' ORDER BY id`)).toEqual([
      { id: 'overpaid', cents: -4250 },
      { id: 'owed', cents: 84217 },
    ]);
    expect(db.rows(`SELECT name, balance_cents AS cents FROM debts ORDER BY name`)).toEqual([
      { name: 'overpaid', cents: 0 },
      { name: 'owed', cents: 84217 },
    ]);
  });

  it('links a card to a debt of the same name instead of adding a second one', async () => {
    db.exec("INSERT INTO debts (name, balance_cents, apr_percent, min_payment_cents) VALUES ('OWED', 100, 0, 0)");
    const { itemId } = await seedBank(db, env, 'card');
    db.exec(`UPDATE plaid_items SET liabilities_updated_at = NULL WHERE id = ?`, itemId);
    const card = (id: string, current: number): PlaidAccount => ({
      account_id: id,
      name: id,
      official_name: null,
      mask: null,
      type: 'credit',
      subtype: 'credit card',
      balances: { current, available: null, limit: 5000, iso_currency_code: 'USD' },
    });
    const accounts = [card('owed', 842.17), card('overpaid', -42.5)];
    const liabilities: LiabilitiesResponse = {
      accounts,
      liabilities: {
        credit: accounts.map((a) => ({
          account_id: a.account_id,
          aprs: [{ apr_percentage: 24.99, apr_type: 'purchase_apr' }],
          minimum_payment_amount: 35,
          next_payment_due_date: '2026-11-05',
          last_statement_balance: null,
        })),
      },
    };
    vi.stubGlobal('fetch', async (url: string) =>
      Response.json(new URL(url).pathname === '/liabilities/get' ? liabilities : page([], { accounts })),
    );

    await syncStep(env, { trigger: 'cron' });

    expect(db.rows(`SELECT d.name, a.plaid_account_id AS account, d.balance_cents AS cents, d.source FROM debts d JOIN accounts a ON a.id = d.account_id ORDER BY d.id`)).toEqual([
      { name: 'OWED', account: 'owed', cents: 84217, source: 'plaid' },
      { name: 'overpaid', account: 'overpaid', cents: 0, source: 'plaid' },
    ]);
    expect(db.rows('SELECT COUNT(*) AS n FROM debts')).toEqual([{ n: 2 }]);
  });

  it('stores a page of transactions', async () => {
    const { itemId } = await seedBank(db, env, 'chime');
    stubPlaid({ chime: [page([plaidTxn('chime', 't1', '2026-10-01', 12.34), plaidTxn('chime', 't2', '2026-10-02', 5)])] });

    const result = await syncStep(env, { itemId, trigger: 'manual' });

    expect(result).toMatchObject({ status: 'ok', added: 2 });
    expect(txns().map((t) => [t.plaidTxnId, t.amountCents])).toEqual([
      ['t1', -1234],
      ['t2', -500],
    ]);
  });

  it('cron moves on to other banks while one keeps failing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T11:00:00Z'));
    await seedBank(db, env, 'broken', '2026-10-16T00:00:00Z');
    await seedBank(db, env, 'fine', '2026-10-16T01:00:00Z');
    const calls = stubPlaid({
      broken: [{ status: 500, error_code: 'INTERNAL_SERVER_ERROR', error_type: 'API_ERROR' }],
      fine: [page([plaidTxn('fine', 't1', '2026-10-15', 1)])],
    });

    await syncStep(env, { trigger: 'cron' });
    vi.setSystemTime(new Date('2026-10-17T11:15:00Z'));
    await syncStep(env, { trigger: 'cron' });

    expect(calls).toEqual(['broken /transactions/sync', 'fine /transactions/sync']);
    expect(txns()).toHaveLength(1);

    // The failing bank is tried again after a back-off.
    vi.setSystemTime(new Date('2026-10-17T12:15:00Z'));
    await syncStep(env, { trigger: 'cron' });
    expect(calls.at(-1)).toBe('broken /transactions/sync');
  });

  it('merges a posted transaction whose pending version was never synced into the imported copy', async () => {
    const { itemId, accountId } = await seedBank(db, env, 'card');
    insertImported(accountId, '2026-10-01', -4250);
    stubPlaid({ card: [page([plaidTxn('card', 'posted-1', '2026-10-02', 42.5, { pending_transaction_id: 'pending-never-seen' })])] });

    await syncStep(env, { itemId, trigger: 'manual' });

    const rows = txns();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ plaidTxnId: 'posted-1', source: 'plaid' });
  });

  it('can replay a page that was already stored', async () => {
    const { itemId, accountId } = await seedBank(db, env, 'chime');
    const replay = page([plaidTxn('chime', 't1', '2026-10-01', 20)]);
    stubPlaid({ chime: [replay, replay] });
    await syncStep(env, { itemId, trigger: 'manual' });
    // An unrelated imported row with the same amount, imported after the first sync.
    insertImported(accountId, '2026-10-02', -2000, 'Different store');

    const result = await syncStep(env, { itemId, trigger: 'manual' });

    expect(result.status).toBe('ok');
    expect(txns().map((t) => [t.plaidTxnId, t.source])).toEqual([
      ['t1', 'plaid'],
      [null, 'import'],
    ]);
  });

  it('merges a posted transaction into the imported copy even when its pending amount differed (a tip)', async () => {
    const { itemId, accountId } = await seedBank(db, env, 'card');
    const dining = db.rows<{ id: number }>('SELECT id FROM categories ORDER BY id LIMIT 1')[0]!.id;
    db.exec(
      `INSERT INTO transactions (account_id, date, amount_cents, name, source, plaid_txn_id, pending, category_id, category_source, notes)
       VALUES (?, '2026-10-01', -4000, 'BISTRO', 'plaid', 'p1', 1, ?, 'user', 'date night')`,
      accountId,
      dining,
    );
    insertImported(accountId, '2026-10-02', -5000, 'BISTRO');
    stubPlaid({ card: [page([plaidTxn('card', 'posted-1', '2026-10-03', 50, { pending_transaction_id: 'p1' })])] });

    await syncStep(env, { itemId, trigger: 'manual' });

    const rows = db.rows(
      `SELECT plaid_txn_id AS plaidTxnId, amount_cents AS amountCents, category_id AS categoryId, category_source AS categorySource, notes
         FROM transactions`,
    );
    expect(rows).toEqual([{ plaidTxnId: 'posted-1', amountCents: -5000, categoryId: dining, categorySource: 'user', notes: 'date night' }]);
  });

  it('retries a bank in error every few hours, and clears the error when it works', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T11:00:00Z'));
    const { itemId } = await seedBank(db, env, 'chime', '2026-10-16T00:00:00Z');
    db.exec(
      `UPDATE plaid_items SET status = 'error', error_code = 'PRODUCT_NOT_READY', last_attempt_at = '2026-10-17T09:00:00Z' WHERE id = ?`,
      itemId,
    );
    const calls = stubPlaid({ chime: [page([])] });

    expect((await syncStep(env, { trigger: 'cron' })).status).toBe('idle');

    vi.setSystemTime(new Date('2026-10-17T15:30:00Z'));
    await syncStep(env, { trigger: 'cron' });
    expect(calls).toEqual(['chime /transactions/sync']);
    expect(db.rows('SELECT status, error_code AS errorCode FROM plaid_items')).toEqual([{ status: 'ok', errorCode: null }]);
  });

  it('"Sync now" retries a bank in error right away', async () => {
    const { itemId } = await seedBank(db, env, 'chime');
    db.exec(`UPDATE plaid_items SET status = 'error', error_code = 'PRODUCT_NOT_READY', last_attempt_at = ? WHERE id = ?`, new Date().toISOString(), itemId);
    stubPlaid({ chime: [page([])] });

    const result = await syncStep(env, { trigger: 'manual', since: new Date(Date.now() + 1000).toISOString() });

    expect(result).toMatchObject({ itemId, status: 'ok' });
  });

  it('never syncs the same bank twice at once', async () => {
    const { itemId } = await seedBank(db, env, 'busy');
    await seedBank(db, env, 'free');
    db.exec('UPDATE plaid_items SET sync_lock_until = ? WHERE id = ?', new Date(Date.now() + 30_000).toISOString(), itemId);
    const calls = stubPlaid({ busy: [page([])], free: [page([])] });

    expect(await syncStep(env, { itemId, trigger: 'link' })).toMatchObject({ itemId, status: 'ok', done: false, busy: true });
    await syncStep(env, { trigger: 'cron' });

    expect(calls).toEqual(['free /transactions/sync']);
    // Released after each step, whether it worked or not.
    expect(db.rows('SELECT sync_lock_until AS lock FROM plaid_items ORDER BY id')).toEqual([{ lock: expect.any(String) }, { lock: null }]);
  });

  it('copies splits from the pending version only once, even if a page is retried part way', async () => {
    const { itemId, accountId } = await seedBank(db, env, 'card');
    db.exec(
      `INSERT INTO transactions (account_id, date, amount_cents, name, source, plaid_txn_id, pending, is_split)
       VALUES (?, '2026-10-01', -3000, 'Target', 'plaid', 'p1', 1, 1)`,
      accountId,
    );
    const pendingId = db.rows<{ id: number }>("SELECT id FROM transactions WHERE plaid_txn_id = 'p1'")[0]!.id;
    db.exec('INSERT INTO splits (transaction_id, amount_cents) VALUES (?, -1000), (?, -2000)', pendingId, pendingId);
    // State after a crash part way through the page: posted row and its splits stored, pending row not yet deleted.
    db.exec(
      `INSERT INTO transactions (account_id, date, amount_cents, name, source, plaid_txn_id, pending_txn_id, is_split)
       VALUES (?, '2026-10-02', -3000, 'Target', 'plaid', 'posted-1', 'p1', 1)`,
      accountId,
    );
    const postedId = db.rows<{ id: number }>("SELECT id FROM transactions WHERE plaid_txn_id = 'posted-1'")[0]!.id;
    db.exec('INSERT INTO splits (transaction_id, amount_cents) VALUES (?, -1000), (?, -2000)', postedId, postedId);
    stubPlaid({ card: [page([plaidTxn('card', 'posted-1', '2026-10-02', 30, { pending_transaction_id: 'p1' })])] });

    await syncStep(env, { itemId, trigger: 'manual' });

    expect(txns().map((t) => t.plaidTxnId)).toEqual(['posted-1']);
    expect(db.rows('SELECT amount_cents AS a FROM splits WHERE transaction_id = ? ORDER BY id', postedId)).toEqual([{ a: -1000 }, { a: -2000 }]);
  });
});

describe('file import into a bank-synced account', () => {
  const post = async (path: string, body: unknown) => {
    const response = await api(env, 'POST', path, body);
    expect(response.status).toBeLessThan(300);
    return response.json() as Promise<Record<string, number>>;
  };

  const importCsv = async (accountId: number, rows: { date: string; amountCents: number; name: string; occurrence?: number }[]) => {
    const { id } = await post('/import/batches', { accountId, format: 'csv' });
    return post(`/import/batches/${id}/rows`, { rows });
  };

  it('skips rows the bank already synced, and stays skipped on re-import', async () => {
    const { itemId, accountId } = await seedBank(db, env, 'chime');
    stubPlaid({ chime: [page([plaidTxn('chime', 't1', '2026-10-02', 4.5), plaidTxn('chime', 't2', '2026-10-05', 80)])] });
    await syncStep(env, { itemId, trigger: 'manual' });

    const file = [
      { date: '2026-10-01', amountCents: -450, name: 'COFFEE SHOP' },
      { date: '2026-10-01', amountCents: -450, name: 'COFFEE SHOP', occurrence: 1 },
      { date: '2026-10-05', amountCents: -8000, name: 'GROCERY' },
      { date: '2026-09-20', amountCents: -1500, name: 'OLDER THAN THE BANK DATA' },
    ];
    expect(await importCsv(accountId, file)).toEqual({ inserted: 2, duplicates: 2 });
    expect(await importCsv(accountId, file)).toEqual({ inserted: 0, duplicates: 4 });
    expect(txns().map((t) => [t.source, t.amountCents])).toEqual([
      ['plaid', -450],
      ['plaid', -8000],
      ['import', -450],
      ['import', -1500],
    ]);
  });
});

describe('automatic categories on synced charges', () => {
  const catId = (section: string, name: string) =>
    db.rows<{ id: number }>('SELECT c.id FROM categories c JOIN sections s ON s.id = c.section_id WHERE s.name = ? AND c.name = ?', section, name)[0]!.id;
  const row = (plaidTxnId: string) =>
    db.rows<{ categoryId: number | null; source: string | null; reason: string | null; detailed: string | null; privateMemberId: number | null; kidId: number | null; isSplit: number }>(
      `SELECT category_id AS categoryId, category_source AS source, category_reason AS reason, plaid_category_detailed AS detailed,
              private_member_id AS privateMemberId, kid_id AS kidId, is_split AS isSplit
         FROM transactions WHERE plaid_txn_id = ?`,
      plaidTxnId,
    )[0]!;
  const gas = { primary: 'TRANSPORTATION', detailed: 'TRANSPORTATION_GAS' };
  const shell = (id: string, dollars: number, extra: Partial<PlaidTransaction> = {}) =>
    plaidTxn('chime', id, '2026-10-01', dollars, { name: 'SHELL OIL 57444', merchant_name: 'Shell', personal_finance_category: gas, ...extra });

  it('a synced Shell charge under $25 lands in Habits with a reason', async () => {
    const { itemId } = await seedBank(db, env, 'chime');
    stubPlaid({ chime: [page([shell('t1', 6.75)])] });

    await syncStep(env, { itemId, trigger: 'manual' });

    expect(row('t1')).toMatchObject({
      categoryId: catId('Habits', 'Habits'),
      source: 'auto',
      reason: 'Under $25 at a gas station',
      detailed: 'TRANSPORTATION_GAS',
    });
  });

  it('hand-set charges keep their category through a modify', async () => {
    const { itemId } = await seedBank(db, env, 'chime');
    stubPlaid({ chime: [page([shell('t1', 6.75)])] });
    await syncStep(env, { itemId, trigger: 'manual' });
    const groceries = catId('Everyday', 'Groceries');
    db.exec(`UPDATE transactions SET category_id = ?, category_source = 'user', category_reason = NULL WHERE plaid_txn_id = 't1'`, groceries);

    stubPlaid({ chime: [page([], { modified: [shell('t1', 6.75, { name: 'SHELL OIL 57444 RENAMED' })] })] });
    await syncStep(env, { itemId, trigger: 'manual' });

    expect(row('t1')).toMatchObject({ categoryId: groceries, source: 'user', reason: null });
  });

  it('updates the bank category and re-derives it on a modify', async () => {
    const { itemId } = await seedBank(db, env, 'chime');
    stubPlaid({ chime: [page([plaidTxn('chime', 't1', '2026-10-01', 9, { name: 'CORNER SPOT' })])] });
    await syncStep(env, { itemId, trigger: 'manual' });
    expect(row('t1')).toMatchObject({ categoryId: null, source: null, reason: null });

    const fastFood = { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_FAST_FOOD' };
    stubPlaid({ chime: [page([], { modified: [plaidTxn('chime', 't1', '2026-10-01', 9, { name: 'CORNER SPOT', personal_finance_category: fastFood })] })] });
    await syncStep(env, { itemId, trigger: 'manual' });

    expect(row('t1')).toMatchObject({ detailed: 'FOOD_AND_DRINK_FAST_FOOD', source: 'auto', reason: expect.stringMatching(/^Bank says: /) });
    expect(row('t1').categoryId).not.toBeNull();
  });

  it('re-sent history fills in detailed categories', async () => {
    const { itemId } = await seedBank(db, env, 'chime');
    const eatingOut = catId('Fun & Wants', 'Eating Out');
    db.exec(`INSERT INTO transactions (account_id, date, amount_cents, name, source, plaid_txn_id, plaid_category, category_id, category_source)
             VALUES ((SELECT id FROM accounts LIMIT 1), '2026-10-01', -900, 'CORNER SPOT', 'plaid', 't1', 'FOOD_AND_DRINK', ?, 'auto')`, eatingOut);
    db.exec(`INSERT INTO transactions (account_id, date, amount_cents, name, source, plaid_txn_id, plaid_category, category_id, category_source)
             VALUES ((SELECT id FROM accounts LIMIT 1), '2026-10-01', -800, 'CORNER SPOT', 'plaid', 't2', 'FOOD_AND_DRINK', ?, 'user')`, eatingOut);
    const fastFood = { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_FAST_FOOD' };
    stubPlaid({
      chime: [page([
        plaidTxn('chime', 't1', '2026-10-01', 9, { name: 'CORNER SPOT', personal_finance_category: fastFood }),
        plaidTxn('chime', 't2', '2026-10-01', 8, { name: 'CORNER SPOT', personal_finance_category: fastFood }),
      ])],
    });

    const res = await api(env, 'POST', `/plaid/items/${itemId}/refresh-details`);
    expect(await res.json()).toEqual({ ok: true });
    await syncStep(env, { itemId, trigger: 'manual' });

    expect(db.rows('SELECT id FROM transactions')).toHaveLength(2);
    expect(row('t1').detailed).toBe('FOOD_AND_DRINK_FAST_FOOD');
    expect(row('t1').categoryId).not.toBe(eatingOut);
    expect(row('t1').categoryId).toBe(catId('Habits', 'Coffee & Fast Food'));
    expect(row('t2')).toMatchObject({ detailed: 'FOOD_AND_DRINK_FAST_FOOD', categoryId: eatingOut, source: 'user' });
  });

  it('a re-sent charge without a bank category keeps the one already stored', async () => {
    const { itemId } = await seedBank(db, env, 'chime');
    db.exec(`INSERT INTO transactions (account_id, date, amount_cents, name, source, plaid_txn_id, plaid_category, plaid_category_detailed)
             VALUES ((SELECT id FROM accounts LIMIT 1), '2026-10-01', -900, 'CORNER SPOT', 'plaid', 't1', 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_FAST_FOOD')`);
    stubPlaid({ chime: [page([plaidTxn('chime', 't1', '2026-10-01', 9, { name: 'CORNER SPOT' })])] });

    await syncStep(env, { itemId, trigger: 'manual' });

    expect(db.rows('SELECT plaid_category, plaid_category_detailed FROM transactions')).toEqual([
      { plaid_category: 'FOOD_AND_DRINK', plaid_category_detailed: 'FOOD_AND_DRINK_FAST_FOOD' },
    ]);
    expect(row('t1').categoryId).toBe(catId('Habits', 'Coffee & Fast Food'));
  });

  it('a modified charge without a bank category keeps the one already stored', async () => {
    const { itemId } = await seedBank(db, env, 'chime');
    const fastFood = { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_FAST_FOOD' };
    stubPlaid({ chime: [page([plaidTxn('chime', 't1', '2026-10-01', 9, { name: 'CORNER SPOT', personal_finance_category: fastFood })])] });
    await syncStep(env, { itemId, trigger: 'manual' });
    const before = row('t1').categoryId;
    expect(before).toBe(catId('Habits', 'Coffee & Fast Food'));

    stubPlaid({ chime: [page([], { modified: [plaidTxn('chime', 't1', '2026-10-01', 9.5, { name: 'CORNER SPOT' })] })] });
    await syncStep(env, { itemId, trigger: 'manual' });

    expect(db.rows('SELECT amount_cents, plaid_category, plaid_category_detailed FROM transactions')).toEqual([
      { amount_cents: -950, plaid_category: 'FOOD_AND_DRINK', plaid_category_detailed: 'FOOD_AND_DRINK_FAST_FOOD' },
    ]);
    expect(row('t1').categoryId).toBe(before);
  });

  describe('automatic details refresh, once per bank', () => {
    const item = (itemId: number) =>
      db.rows<{ cursor: string | null; historyComplete: number; refreshedAt: string | null }>(
        'SELECT cursor, history_complete AS historyComplete, details_refreshed_at AS refreshedAt FROM plaid_items WHERE id = ?',
        itemId,
      )[0]!;
    /** A bank linked before details refresh existed: synced, with a cursor, never refreshed. */
    async function oldBank(name: string) {
      const { itemId } = await seedBank(db, env, name, '2026-10-17T00:00:00Z');
      db.exec('UPDATE plaid_items SET cursor = ?, details_refreshed_at = NULL WHERE id = ?', `old-${name}`, itemId);
      return itemId;
    }
    const cursorsSent: (string | null)[] = [];
    function stubCursorPlaid() {
      cursorsSent.length = 0;
      vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
        if (new URL(url).pathname === '/transactions/sync') cursorsSent.push((JSON.parse(init.body) as { cursor?: string }).cursor ?? null);
        return Response.json(page([]));
      });
    }

    it('a cron step resets a never-refreshed bank once and stamps it', async () => {
      const itemId = await oldBank('chime');
      stubCursorPlaid();

      await syncStep(env, { trigger: 'cron' });
      expect(cursorsSent).toEqual([null]);
      const after = item(itemId);
      expect(after.refreshedAt).toEqual(expect.any(String));
      expect(after.cursor).toMatch(/^cursor-/);

      // History is whole again and stamped: later cron steps continue from the cursor.
      db.exec('UPDATE plaid_items SET last_synced_at = ? WHERE id = ?', '2026-01-01T00:00:00Z', itemId);
      const cursor = item(itemId).cursor;
      await syncStep(env, { trigger: 'cron' });
      expect(cursorsSent).toEqual([null, cursor]);
      expect(item(itemId).refreshedAt).toBe(after.refreshedAt);
    });

    it('a bank another sync holds is not reset', async () => {
      const itemId = await oldBank('chime');
      db.exec('UPDATE plaid_items SET sync_lock_until = ? WHERE id = ?', new Date(Date.now() + 30_000).toISOString(), itemId);
      stubCursorPlaid();

      await syncStep(env, { trigger: 'cron' });

      expect(cursorsSent).toEqual([]);
      expect(item(itemId)).toMatchObject({ cursor: 'old-chime', historyComplete: 1, refreshedAt: null });
    });

    it('a bank that needs signing in again is left alone', async () => {
      const itemId = await oldBank('chime');
      db.exec(`UPDATE plaid_items SET status = 'login_required' WHERE id = ?`, itemId);
      stubCursorPlaid();

      await syncStep(env, { trigger: 'cron' });

      expect(item(itemId)).toMatchObject({ cursor: 'old-chime', refreshedAt: null });
    });

    it('"Refresh bank details" stamps the bank too', async () => {
      const itemId = await oldBank('chime');
      await api(env, 'POST', `/plaid/items/${itemId}/refresh-details`);
      expect(item(itemId)).toMatchObject({ cursor: null, historyComplete: 0, refreshedAt: expect.any(String) });
    });

    it('a newly linked bank is stamped and never reset', async () => {
      vi.stubGlobal('fetch', async (url: string) => {
        const path = new URL(url).pathname;
        if (path === '/item/public_token/exchange') return Response.json({ access_token: 'access-new', item_id: 'item-new' });
        if (path === '/accounts/get') return Response.json({ accounts: [] });
        return Response.json(page([]));
      });
      await api(env, 'GET', '/me');
      const res = await api(env, 'POST', '/plaid/exchange', { publicToken: 'public-new', institutionId: 'ins_1', institutionName: 'New Bank' });
      expect(res.status).toBe(201);
      const { itemId } = (await res.json()) as { itemId: number };
      expect(item(itemId).refreshedAt).toEqual(expect.any(String));

      db.exec('UPDATE plaid_items SET cursor = ?, history_complete = 1 WHERE id = ?', 'linked-cursor', itemId);
      stubCursorPlaid();
      await syncStep(env, { trigger: 'cron' });
      expect(cursorsSent).toEqual(['linked-cursor']);
    });
  });

  it('refresh details is refused while a sync holds the bank', async () => {
    const { itemId } = await seedBank(db, env, 'chime');
    db.exec('UPDATE plaid_items SET cursor = ?, sync_lock_until = ? WHERE id = ?', 'c1', new Date(Date.now() + 30_000).toISOString(), itemId);
    const res = await api(env, 'POST', `/plaid/items/${itemId}/refresh-details`);
    expect(res.status).toBe(409);
    expect(db.rows<{ cursor: string }>('SELECT cursor FROM plaid_items WHERE id = ?', itemId)[0]!.cursor).toBe('c1');
  });

  it('splits are skipped', async () => {
    const { itemId, accountId } = await seedBank(db, env, 'chime');
    db.exec(
      `INSERT INTO transactions (account_id, date, amount_cents, name, source, plaid_txn_id, is_split, plaid_category_detailed)
       VALUES (?, '2026-10-01', -675, 'SHELL OIL 57444', 'plaid', 't1', 1, 'TRANSPORTATION_GAS')`,
      accountId,
    );
    stubPlaid({ chime: [page([], { modified: [shell('t1', 6.75)] })] });

    await syncStep(env, { itemId, trigger: 'manual' });

    expect(row('t1')).toMatchObject({ categoryId: null, source: null, isSplit: 1 });
  });

  it('a pending split that posts stays a split with no automatic category', async () => {
    const { itemId, accountId } = await seedBank(db, env, 'chime');
    db.exec(
      `INSERT INTO transactions (account_id, date, amount_cents, name, source, plaid_txn_id, pending, is_split)
       VALUES (?, '2026-10-01', -675, 'SHELL OIL 57444', 'plaid', 'p1', 1, 1)`,
      accountId,
    );
    const pendingId = db.rows<{ id: number }>("SELECT id FROM transactions WHERE plaid_txn_id = 'p1'")[0]!.id;
    db.exec('INSERT INTO splits (transaction_id, amount_cents) VALUES (?, -300), (?, -341)', pendingId, pendingId);
    stubPlaid({ chime: [page([shell('posted-1', 6.75, { pending_transaction_id: 'p1' })])] });

    await syncStep(env, { itemId, trigger: 'manual' });

    expect(row('posted-1')).toMatchObject({ isSplit: 1, categoryId: null, source: null, reason: null });
    expect(db.rows("SELECT rule_id AS ruleId FROM transactions WHERE plaid_txn_id = 'posted-1'")).toEqual([{ ruleId: null }]);
    expect(
      db.rows("SELECT s.amount_cents AS a FROM splits s JOIN transactions t ON t.id = s.transaction_id WHERE t.plaid_txn_id = 'posted-1' ORDER BY s.id"),
    ).toEqual([{ a: -300 }, { a: -341 }]);
  });

  it('a hand-set pending category merged into an imported copy drops the old reason', async () => {
    const { itemId, accountId } = await seedBank(db, env, 'chime');
    const groceries = catId('Everyday', 'Groceries');
    db.exec(
      `INSERT INTO transactions (account_id, date, amount_cents, name, source, plaid_txn_id, pending, category_id, category_source)
       VALUES (?, '2026-10-01', -675, 'SHELL OIL 57444', 'plaid', 'p1', 1, ?, 'user')`,
      accountId,
      groceries,
    );
    insertImported(accountId, '2026-10-01', -675, 'SHELL OIL 57444');
    db.exec(
      `UPDATE transactions SET category_id = ?, category_source = 'auto', category_reason = 'Under $25 at a gas station' WHERE source = 'import'`,
      catId('Habits', 'Habits'),
    );
    stubPlaid({ chime: [page([shell('posted-1', 6.75, { pending_transaction_id: 'p1' })])] });

    await syncStep(env, { itemId, trigger: 'manual' });

    expect(row('posted-1')).toMatchObject({ categoryId: groceries, source: 'user', reason: null });
  });

  it('charges on a personal card stay private, even when a built-in pattern matches', async () => {
    const { itemId, accountId } = await seedBank(db, env, 'chime');
    db.exec(`INSERT INTO members (id, email, name, default_private_account_id) VALUES (7, 'jo@example.com', 'Jo', ?)`, accountId);
    db.exec(
      `INSERT INTO categories (section_id, name, kind, fun_member_id) VALUES ((SELECT id FROM sections WHERE name = 'Fun & Wants'), 'Jo fun', 'expense', 7)`,
    );
    stubPlaid({ chime: [page([shell('t1', 6.75)])] });

    await syncStep(env, { itemId, trigger: 'manual' });

    expect(row('t1')).toMatchObject({ privateMemberId: 7, categoryId: catId('Fun & Wants', 'Jo fun') });
  });

  it('a kid-only rule still gets a category from the automatic layers', async () => {
    const { itemId } = await seedBank(db, env, 'chime');
    db.exec("INSERT INTO kids (id, name) VALUES (1, 'Ada')");
    db.exec(`INSERT INTO rules (position, match_field, match_text, kid_id) VALUES (1, 'any', 'SHELL', 1)`);
    stubPlaid({ chime: [page([shell('t1', 6.75)])] });

    await syncStep(env, { itemId, trigger: 'manual' });

    expect(row('t1')).toMatchObject({ kidId: 1, source: 'rule', categoryId: catId('Habits', 'Habits'), reason: 'Under $25 at a gas station' });
  });

  it('a payment on a credit card is still filed as a transfer', async () => {
    const { itemId, accountId } = await seedBank(db, env, 'chime');
    db.exec(`UPDATE accounts SET type = 'credit' WHERE id = ?`, accountId);
    stubPlaid({ chime: [page([plaidTxn('chime', 't1', '2026-10-01', -250, { name: 'ONLINE PAYMENT THANK YOU' })])] });

    await syncStep(env, { itemId, trigger: 'manual' });

    expect(row('t1')).toMatchObject({ categoryId: catId('Transfers', 'Transfers'), source: 'auto', reason: 'Card payment' });
  });

  describe('paired transfers', () => {
    const loan = { primary: 'LOAN_PAYMENTS', detailed: 'LOAN_PAYMENTS_OTHER_PAYMENT' };
    const transferIn = { primary: 'TRANSFER_IN', detailed: 'TRANSFER_IN_ACCOUNT_TRANSFER' };
    const shopping = { primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE' };
    const paired = () =>
      db.rows<{ plaidTxnId: string; pairedWith: string | null; kind: string | null; source: string | null }>(
        `SELECT t.plaid_txn_id AS plaidTxnId, p.plaid_txn_id AS pairedWith, c.kind, t.category_source AS source
           FROM transactions t LEFT JOIN transactions p ON p.id = t.transfer_pair_id LEFT JOIN categories c ON c.id = t.category_id
          ORDER BY t.id`,
      );

    async function syncPair(checkingCategory: { primary: string; detailed: string }) {
      const checking = await seedBank(db, env, 'chime');
      const card = await seedBank(db, env, 'capone');
      db.exec(`UPDATE accounts SET type = 'credit' WHERE id = ?`, card.accountId);
      stubPlaid({
        chime: [page([plaidTxn('chime', 'out', '2026-10-01', 250, { name: 'ONLINE PAYMENT TO CARD 4417', personal_finance_category: checkingCategory })])],
        capone: [page([plaidTxn('capone', 'in', '2026-10-02', -250, { name: 'PAYMENT RECEIVED', personal_finance_category: transferIn })])],
      });
      await syncStep(env, { itemId: checking.itemId, trigger: 'manual' });
      await syncStep(env, { itemId: card.itemId, trigger: 'manual' });
    }

    it('both halves of a synced card payment land in Transfers, even when the bank calls one a loan payment', async () => {
      await syncPair(loan);
      expect(paired()).toEqual([
        { plaidTxnId: 'out', pairedWith: 'in', kind: 'transfer', source: 'auto' },
        { plaidTxnId: 'in', pairedWith: 'out', kind: 'transfer', source: 'auto' },
      ]);
    });

    it('a half the bank filed as spending still pairs', async () => {
      await syncPair(shopping);
      expect(paired()).toEqual([
        { plaidTxnId: 'out', pairedWith: 'in', kind: 'transfer', source: 'auto' },
        { plaidTxnId: 'in', pairedWith: 'out', kind: 'transfer', source: 'auto' },
      ]);
    });

    it('your rule can still count a paired transfer as savings, while the bank layer on the other half gives Transfers', async () => {
      const savings = catId('Saving', 'Savings & Planned Costs');
      db.exec(`INSERT INTO rules (position, match_field, match_text, category_id) VALUES (1, 'name', 'TRANSFER TO SAVINGS', ?)`, savings);
      const ruleId = db.rows<{ id: number }>('SELECT MAX(id) AS id FROM rules')[0]!.id;
      const checking = await seedBank(db, env, 'chime');
      const vault = await seedBank(db, env, 'ally');
      db.exec(`UPDATE accounts SET type = 'savings' WHERE id = ?`, vault.accountId);
      const transferOut = { primary: 'TRANSFER_OUT', detailed: 'TRANSFER_OUT_SAVINGS' };
      stubPlaid({
        chime: [page([plaidTxn('chime', 'out', '2026-10-01', 100, { name: 'TRANSFER TO SAVINGS 0042', personal_finance_category: transferOut })])],
        ally: [page([plaidTxn('ally', 'in', '2026-10-01', -100, { name: 'TRANSFER FROM CHECKING', personal_finance_category: transferIn })])],
      });
      await syncStep(env, { itemId: checking.itemId, trigger: 'manual' });
      await syncStep(env, { itemId: vault.itemId, trigger: 'manual' });

      const expected = [
        { plaidTxnId: 'out', pairedWith: 'in', kind: 'savings', source: 'rule' },
        { plaidTxnId: 'in', pairedWith: 'out', kind: 'transfer', source: 'auto' },
      ];
      expect(paired()).toEqual(expected);
      expect(db.rows(`SELECT rule_id FROM transactions WHERE plaid_txn_id = 'out'`)).toEqual([{ rule_id: ruleId }]);

      await api(env, 'POST', '/categorize/all', {});
      expect(paired()).toEqual(expected);
    });

    it('when the bank removes one half, the other is unpaired and sorted again', async () => {
      await syncPair(shopping);
      expect(paired()[0]).toEqual({ plaidTxnId: 'out', pairedWith: 'in', kind: 'transfer', source: 'auto' });

      stubPlaid({ capone: [page([], { removed: [{ transaction_id: 'in' }] })] });
      const card = db.rows<{ id: number }>(`SELECT id FROM plaid_items WHERE item_id = 'item-capone'`)[0]!.id;
      await syncStep(env, { itemId: card, trigger: 'manual' });

      const survivor = db.rows<{ pair: number | null; kind: string | null; reason: string | null }>(
        `SELECT t.transfer_pair_id AS pair, c.kind, t.category_reason AS reason
           FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE t.plaid_txn_id = 'out'`,
      )[0]!;
      expect(survivor.pair).toBeNull();
      expect(survivor.kind).not.toBe('transfer');
      expect(survivor.reason).toMatch(/^Bank says: /);
      expect(db.rows(`SELECT transfer_pair_id AS pair FROM transactions WHERE plaid_txn_id = 'in'`)).toEqual([{ pair: null }]);
      expect(db.rows('SELECT a_id FROM transfer_unlinks')).toEqual([]);
    });

    it('recategorize-all keeps paired halves in Transfers, leaves hand-set ones, and unlinking re-sorts them', async () => {
      const { accountId } = await seedBank(db, env, 'chime');
      db.exec(`INSERT INTO accounts (name, type) VALUES ('Card', 'credit')`);
      const cardId = db.rows<{ id: number }>('SELECT MAX(id) AS id FROM accounts')[0]!.id;
      const loans = catId('Bills', 'Loans');
      const add = (account: number, cents: number, name: string, primary: string, categoryId: number | null, source: string | null) => {
        db.exec(
          `INSERT INTO transactions (account_id, date, amount_cents, name, source, plaid_category, category_id, category_source)
           VALUES (?, '2026-10-01', ?, ?, 'plaid', ?, ?, ?)`,
          account, cents, name, primary, categoryId, source,
        );
        return db.rows<{ id: number }>('SELECT MAX(id) AS id FROM transactions')[0]!.id;
      };
      const out = add(accountId, -25000, 'ONLINE PAYMENT TO CARD 4417', 'LOAN_PAYMENTS', loans, 'auto');
      const inflow = add(cardId, 25000, 'PAYMENT RECEIVED', 'TRANSFER_IN', null, null);
      const handOut = add(accountId, -9000, 'AUTO LOAN PAYMENT', 'LOAN_PAYMENTS', loans, 'user');
      const handIn = add(cardId, 9000, 'PAYMENT RECEIVED', 'TRANSFER_IN', null, null);
      db.exec('UPDATE transactions SET transfer_pair_id = ? WHERE id = ?', inflow, out);
      db.exec('UPDATE transactions SET transfer_pair_id = ? WHERE id = ?', out, inflow);
      db.exec('UPDATE transactions SET transfer_pair_id = ? WHERE id = ?', handIn, handOut);
      db.exec('UPDATE transactions SET transfer_pair_id = ? WHERE id = ?', handOut, handIn);

      await api(env, 'POST', '/categorize/all', {});
      const kindOf = (id: number) =>
        db.rows<{ kind: string | null; source: string | null }>(
          'SELECT c.kind, t.category_source AS source FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = ?',
          id,
        )[0]!;
      expect(kindOf(out)).toEqual({ kind: 'transfer', source: 'auto' });
      expect(kindOf(inflow)).toEqual({ kind: 'transfer', source: 'auto' });
      expect(kindOf(handOut)).toEqual({ kind: 'debt', source: 'user' });

      expect((await api(env, 'POST', `/transactions/${out}/unlink-transfer`, {})).status).toBe(200);
      expect(kindOf(out)).toEqual({ kind: 'debt', source: 'auto' });
    });
  });

  it('a rule with a category wins, with its reason', async () => {
    const { itemId } = await seedBank(db, env, 'chime');
    const gasCat = catId('Everyday', 'Gas');
    db.exec(`INSERT INTO rules (position, match_field, match_text, category_id) VALUES (1, 'any', 'SHELL', ?)`, gasCat);
    stubPlaid({ chime: [page([shell('t1', 6.75)])] });

    await syncStep(env, { itemId, trigger: 'manual' });

    expect(row('t1')).toMatchObject({ categoryId: gasCat, source: 'rule', reason: 'Your rule: SHELL' });
  });
});
