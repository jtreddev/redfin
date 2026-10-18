import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncStep } from '../src/worker/plaid/sync';
import type { Env } from '../src/worker/env';
import type { LiabilitiesResponse, PlaidAccount } from '../src/worker/plaid/client';
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
