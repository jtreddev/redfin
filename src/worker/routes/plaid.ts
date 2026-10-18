import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { all, first, nowIso, run } from '../lib/db';
import { HttpError, notFound, optBool, optInt, optStr, paramId, readBody, reqStr } from '../lib/http';
import { plaid, PlaidError, plaidConfigured, type PlaidAccount } from '../plaid/client';
import { decryptToken, encryptToken } from '../plaid/crypto';
import { syncStep, upsertPlaidAccounts } from '../plaid/sync';

export const plaidRoutes = new Hono<AppEnv>();

/** Plaid's free Trial plan allows 10 connected bank logins. */
const ITEM_LIMIT = 10;

function requireConfigured(c: { env: AppEnv['Bindings'] }) {
  if (!plaidConfigured(c.env)) {
    throw new HttpError(503, 'Bank sync isn’t set up yet: add PLAID_CLIENT_ID, PLAID_SECRET and TOKEN_ENC_KEY.');
  }
}

plaidRoutes.get('/plaid/status', async (c) => {
  const items = await all(
    c.env.DB,
    `SELECT p.id, p.institution_id AS institutionId, p.institution_name AS institutionName, p.status,
            p.error_code AS errorCode, p.error_message AS errorMessage, p.last_synced_at AS lastSyncedAt,
            p.has_more AS hasMore, p.history_complete AS historyComplete, p.created_at AS createdAt,
            (SELECT COUNT(*) FROM accounts a WHERE a.plaid_item_id = p.id) AS accountCount
       FROM plaid_items p ORDER BY p.id`,
  );
  return c.json({ configured: plaidConfigured(c.env), env: c.env.PLAID_ENV, itemLimit: ITEM_LIMIT, items });
});

plaidRoutes.post('/plaid/link-token', async (c) => {
  requireConfigured(c);
  const db = c.env.DB;
  const viewer = c.get('viewer');
  const itemId = optInt((await readBody(c)).itemId, 'itemId', { min: 1 });

  const base: Record<string, unknown> = {
    client_name: 'Family Budget',
    language: 'en',
    country_codes: ['US'],
    user: { client_user_id: `member-${viewer.memberId}` },
    ...(c.env.PLAID_REDIRECT_URI ? { redirect_uri: c.env.PLAID_REDIRECT_URI } : {}),
  };

  if (itemId) {
    // Update mode: reconnect an existing bank login without creating a new Item.
    const item = await first<{ accessTokenEnc: string }>(db, 'SELECT access_token_enc AS accessTokenEnc FROM plaid_items WHERE id = ?', itemId);
    if (!item) throw notFound('Bank connection not found');
    base.access_token = await decryptToken(c.env, item.accessTokenEnc);
  } else {
    const count = await first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM plaid_items');
    if ((count?.n ?? 0) >= ITEM_LIMIT) {
      throw new HttpError(409, `You’ve used all ${ITEM_LIMIT} free bank connections. Disconnect one first.`);
    }
    base.products = ['transactions'];
    base.optional_products = ['liabilities', 'investments'];
    base.transactions = { days_requested: 730 };
  }

  const response = await plaid<{ link_token: string; expiration: string }>(c.env, '/link/token/create', base);
  return c.json({ linkToken: response.link_token, expiration: response.expiration });
});

plaidRoutes.post('/plaid/exchange', async (c) => {
  requireConfigured(c);
  const body = await readBody(c);
  const result = await connectItem(c.env, {
    publicToken: reqStr(body.publicToken, 'publicToken', 200),
    institutionId: optStr(body.institutionId, 'institutionId', 60) ?? null,
    institutionName: optStr(body.institutionName, 'institutionName', 120) ?? null,
    memberId: c.get('viewer').memberId,
    allowDuplicate: optBool(body.allowDuplicate, 'allowDuplicate') ?? false,
  });
  return c.json(result, 201);
});

/**
 * Local testing only (Sandbox + DEV_AUTH_BYPASS on localhost): connects Plaid's fake
 * "First Platypus Bank" without the Link popup, so nobody types test passwords anywhere.
 */
plaidRoutes.post('/plaid/sandbox-connect', async (c) => {
  requireConfigured(c);
  const hostname = new URL(c.req.url).hostname;
  if (c.env.PLAID_ENV !== 'sandbox' || !c.env.DEV_AUTH_BYPASS || !['localhost', '127.0.0.1'].includes(hostname)) {
    throw notFound();
  }
  const created = await plaid<{ public_token: string }>(c.env, '/sandbox/public_token/create', {
    institution_id: 'ins_109508',
    initial_products: ['transactions'],
  });
  const result = await connectItem(c.env, {
    publicToken: created.public_token,
    institutionId: 'ins_109508',
    institutionName: 'First Platypus Bank (test)',
    memberId: c.get('viewer').memberId,
    allowDuplicate: true,
  });
  return c.json(result, 201);
});

async function connectItem(
  env: AppEnv['Bindings'],
  input: { publicToken: string; institutionId: string | null; institutionName: string | null; memberId: number; allowDuplicate: boolean },
): Promise<{ itemId: number; accounts: number }> {
  const db = env.DB;
  const { publicToken, institutionId, institutionName } = input;

  if (institutionId && !input.allowDuplicate) {
    const existing = await first<{ id: number }>(db, 'SELECT id FROM plaid_items WHERE institution_id = ?', institutionId);
    if (existing) {
      throw new HttpError(409, `${institutionName ?? 'That bank'} is already connected. Use Reconnect instead of adding it again.`);
    }
  }
  const count = await first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM plaid_items');
  if ((count?.n ?? 0) >= ITEM_LIMIT) {
    throw new HttpError(409, `You’ve used all ${ITEM_LIMIT} free bank connections. Disconnect one first.`);
  }

  const exchange = await plaid<{ access_token: string; item_id: string }>(env, '/item/public_token/exchange', {
    public_token: publicToken,
  });
  const item = await first<{ id: number }>(
    db,
    `INSERT INTO plaid_items (item_id, institution_id, institution_name, access_token_enc, created_by_member_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (item_id) DO UPDATE SET access_token_enc = excluded.access_token_enc, status = 'ok', updated_at = ?
     RETURNING id`,
    exchange.item_id,
    institutionId,
    institutionName,
    await encryptToken(env, exchange.access_token),
    input.memberId,
    nowIso(),
  );
  if (!item) throw new Error('Could not save the bank connection');

  const accounts = await plaid<{ accounts: PlaidAccount[] }>(env, '/accounts/get', { access_token: exchange.access_token });
  await upsertPlaidAccounts(db, item.id, institutionName, accounts.accounts);
  return { itemId: item.id, accounts: accounts.accounts.length };
}

/** After update-mode Link succeeds. */
plaidRoutes.post('/plaid/items/:id/reconnected', async (c) => {
  const result = await run(
    c.env.DB,
    `UPDATE plaid_items SET status = 'ok', error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?`,
    nowIso(),
    paramId(c),
  );
  if (!result.meta.changes) throw notFound();
  return c.json({ ok: true });
});

/**
 * Starts this bank's history over so Plaid re-sends every charge; re-sent charges get the bank's
 * newest category details (see applyAdded). Refused while a sync holds the bank.
 */
plaidRoutes.post('/plaid/items/:id/refresh-details', async (c) => {
  const db = c.env.DB;
  const id = paramId(c);
  const row = await first<{ id: number }>(
    db,
    `UPDATE plaid_items SET cursor = NULL, sync_start_cursor = NULL, has_more = 0, history_complete = 0, updated_at = ?
      WHERE id = ? AND (sync_lock_until IS NULL OR sync_lock_until < ?) RETURNING id`,
    nowIso(),
    id,
    nowIso(),
  );
  if (!row) {
    if (await first(db, 'SELECT id FROM plaid_items WHERE id = ?', id)) {
      throw new HttpError(409, 'A sync is running — try again in a minute');
    }
    throw notFound();
  }
  return c.json({ ok: true });
});

/** Disconnect: revokes access at Plaid; accounts and history stay (as import-only accounts). */
plaidRoutes.delete('/plaid/items/:id', async (c) => {
  const db = c.env.DB;
  const id = paramId(c);
  const item = await first<{ accessTokenEnc: string }>(db, 'SELECT access_token_enc AS accessTokenEnc FROM plaid_items WHERE id = ?', id);
  if (!item) throw notFound();
  try {
    await plaid(c.env, '/item/remove', { access_token: await decryptToken(c.env, item.accessTokenEnc) });
  } catch (error) {
    if (!(error instanceof PlaidError)) throw error;
  }
  await db.batch([
    db.prepare('UPDATE accounts SET plaid_item_id = NULL WHERE plaid_item_id = ?').bind(id),
    db.prepare('DELETE FROM plaid_items WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

/**
 * One sync step. The client repeats this (passing the time it started as `since`)
 * until `done`, so each bank gets synced once without any single request doing too much.
 */
plaidRoutes.post('/sync/step', async (c) => {
  requireConfigured(c);
  const body = await readBody(c);
  const itemId = optInt(body.itemId, 'itemId', { min: 1 }) ?? undefined;
  const since = optStr(body.since, 'since', 40) ?? undefined;
  // Banks that already failed during this "Sync now" run, so the loop moves on to the others.
  const excludeIds = Array.isArray(body.excludeIds)
    ? body.excludeIds.filter((id): id is number => Number.isInteger(id)).slice(0, 20)
    : [];
  const result = await syncStep(c.env, { itemId, since, excludeIds, trigger: 'manual' });
  return c.json(result);
});

plaidRoutes.get('/sync/runs', async (c) => {
  return c.json(
    await all(
      c.env.DB,
      `SELECT r.id, r.trigger, r.started_at AS startedAt, r.finished_at AS finishedAt, r.added, r.modified, r.removed,
              r.has_more AS hasMore, r.status, r.error, p.institution_name AS institutionName
         FROM sync_runs r LEFT JOIN plaid_items p ON p.id = r.plaid_item_id
        ORDER BY r.id DESC LIMIT 30`,
    ),
  );
});
