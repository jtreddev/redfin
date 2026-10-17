// Seeds banks and accounts, and stands in for Plaid's API, for sync tests.
import { vi } from 'vitest';
import type { PlaidTransaction, TransactionsSyncResponse } from '../../src/worker/plaid/client';
import { encryptToken } from '../../src/worker/plaid/crypto';
import type { Env } from '../../src/worker/env';
import { TestD1 } from './d1';

export function testEnv(db: TestD1): Env {
  return {
    DB: db.d1,
    ASSETS: undefined as unknown as Fetcher,
    PLAID_ENV: 'sandbox',
    PLAID_CLIENT_ID: 'client',
    PLAID_SECRET: 'secret',
    TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString('base64'),
  };
}

/** Adds a linked bank with one checking account; returns the row ids. */
export async function seedBank(db: TestD1, env: Env, name: string, lastSyncedAt: string | null = null) {
  const token = await encryptToken(env, `access-${name}`);
  db.exec(
    `INSERT INTO plaid_items (item_id, institution_name, access_token_enc, history_complete, last_synced_at, liabilities_updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
    `item-${name}`,
    name,
    token,
    lastSyncedAt,
    new Date().toISOString(),
  );
  const itemId = db.rows<{ id: number }>('SELECT id FROM plaid_items WHERE item_id = ?', `item-${name}`)[0]!.id;
  db.exec(
    `INSERT INTO accounts (name, institution, type, plaid_item_id, plaid_account_id) VALUES (?, ?, 'checking', ?, ?)`,
    `${name} checking`,
    name,
    itemId,
    `acct-${name}`,
  );
  const accountId = db.rows<{ id: number }>('SELECT id FROM accounts WHERE plaid_account_id = ?', `acct-${name}`)[0]!.id;
  return { itemId, accountId };
}

export function plaidTxn(bank: string, id: string, date: string, dollarsSpent: number, extra: Partial<PlaidTransaction> = {}): PlaidTransaction {
  return {
    transaction_id: id,
    pending_transaction_id: null,
    account_id: `acct-${bank}`,
    amount: dollarsSpent,
    date,
    authorized_date: null,
    name: `Store ${id}`,
    merchant_name: null,
    pending: false,
    ...extra,
  };
}

export function page(added: PlaidTransaction[], extra: Partial<TransactionsSyncResponse> = {}): TransactionsSyncResponse {
  return { added, modified: [], removed: [], next_cursor: `cursor-${Math.random()}`, has_more: false, ...extra };
}

type Reply = TransactionsSyncResponse | { status: number; error_code: string; error_type: string };

/**
 * Stubs fetch so /transactions/sync answers per bank (by access token).
 * A reply with `status` is sent as a Plaid error. The last reply for a bank repeats.
 */
export function stubPlaid(replies: Record<string, Reply[]>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { access_token: string };
    const bank = body.access_token.replace(/^access-/, '');
    calls.push(`${bank} ${new URL(url).pathname}`);
    const queue = replies[bank] ?? [];
    const reply = (queue.length > 1 ? queue.shift() : queue[0]) ?? page([]);
    if ('status' in reply) return Response.json({ error_code: reply.error_code, error_type: reply.error_type, error_message: 'boom' }, { status: reply.status });
    return Response.json(reply);
  });
  return calls;
}
