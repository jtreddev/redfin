import { Hono } from 'hono';
import { monthOf, monthStart } from '../../shared/dates';
import { findImportedTwin } from '../../shared/dedupe';
import type { AppEnv } from '../env';
import { all, batchAll, first, nowIso, run, stmt, Updates } from '../lib/db';
import {
  badRequest,
  HttpError,
  notFound,
  oneOf,
  optBool,
  optDate,
  optInt,
  optStr,
  paramId,
  readBody,
  reqInt,
  reqMonth,
  reqStr,
} from '../lib/http';
import { plaidConfigured } from '../plaid/client';
import { loadCategories } from '../services/context';

export const core = new Hono<AppEnv>();

const ACCOUNT_TYPES = ['checking', 'savings', 'credit', 'investment', 'loan', 'cash', 'other'] as const;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

core.get('/me', async (c) => {
  const db = c.env.DB;
  const [members, kids, counts] = await Promise.all([
    all(
      db,
      `SELECT id, name, email, color, fun_allowance_cents AS funAllowanceCents,
              default_private_account_id AS defaultPrivateAccountId
         FROM members ORDER BY id`,
    ),
    all(db, 'SELECT id, name, color, birth_date AS birthDate, sort FROM kids WHERE archived = 0 ORDER BY sort, id'),
    first<{ accounts: number; incomeSources: number; budgetLines: number }>(
      db,
      `SELECT (SELECT COUNT(*) FROM accounts) AS accounts,
              (SELECT COUNT(*) FROM income_sources WHERE active = 1) AS incomeSources,
              (SELECT COUNT(*) FROM budget_lines) AS budgetLines`,
    ),
  ]);
  return c.json({
    viewer: c.get('viewer'),
    today: c.get('today'),
    household: c.get('household'),
    members,
    kids,
    plaid: { configured: plaidConfigured(c.env), env: c.env.PLAID_ENV },
    setup: counts,
    devMode: Boolean(c.env.DEV_AUTH_BYPASS),
  });
});

core.patch('/household', async (c) => {
  const body = await readBody(c);
  const updates = new Updates()
    .set('name', optStr(body.name, 'name', 80) ?? undefined)
    .set('low_balance_cents', optInt(body.lowBalanceCents, 'lowBalanceCents', { min: 0 }) ?? undefined)
    .set('card_pay_mode', oneOf(body.cardPayMode, 'cardPayMode', ['when_made', 'when_paid'] as const))
    .set('fun_money_start_date', optDate(body.funMoneyStartDate, 'funMoneyStartDate'))
    .set('habit_cutoff_cents', optInt(body.habitCutoffCents, 'habitCutoffCents', { min: 0, max: 100_000 }) ?? undefined);
  if (body.timezone !== undefined) {
    const timezone = reqStr(body.timezone, 'timezone', 64);
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      throw badRequest('Unknown time zone');
    }
    updates.set('timezone', timezone);
  }
  if (updates.empty) throw badRequest('Nothing to update');
  await run(c.env.DB, `UPDATE household SET ${updates.sets.join(', ')}, updated_at = ? WHERE id = 1`, ...updates.params, nowIso());
  return c.json({ ok: true });
});

core.patch('/members/:id', async (c) => {
  const db = c.env.DB;
  const id = paramId(c);
  const viewer = c.get('viewer');
  const body = await readBody(c);
  const member = await first<{ id: number }>(db, 'SELECT id FROM members WHERE id = ?', id);
  if (!member) throw notFound();

  const name = optStr(body.name, 'name', 40);
  const color = optStr(body.color, 'color', 7);
  if (color && !HEX_COLOR.test(color)) throw badRequest('color must look like #3b6fd8');
  const allowance = optInt(body.funAllowanceCents, 'funAllowanceCents', { min: 0, max: 10_000_000 });
  const privateAccount = optInt(body.defaultPrivateAccountId, 'defaultPrivateAccountId', { min: 1 });
  if (privateAccount !== undefined && id !== viewer.memberId) {
    throw new HttpError(403, 'Only you can choose your own personal card.');
  }

  const updates = new Updates()
    .set('name', name ?? undefined)
    .set('color', color ?? undefined)
    .set('fun_allowance_cents', allowance ?? undefined)
    .set('default_private_account_id', privateAccount);
  if (updates.empty) throw badRequest('Nothing to update');

  const statements = [stmt(db, `UPDATE members SET ${updates.sets.join(', ')}, updated_at = ? WHERE id = ?`, ...updates.params, nowIso(), id)];
  if (name) {
    statements.push(stmt(db, 'UPDATE categories SET name = ? WHERE fun_member_id = ?', `${name}'s Fun Money`, id));
  }
  if (allowance) {
    statements.push(
      stmt(
        db,
        'UPDATE household SET fun_money_start_date = COALESCE(fun_money_start_date, ?) WHERE id = 1',
        monthStart(monthOf(c.get('today'))),
      ),
    );
  }
  await batchAll(db, statements);
  return c.json({ ok: true });
});

core.get('/kids', async (c) => {
  return c.json(
    await all(c.env.DB, 'SELECT id, name, color, birth_date AS birthDate, sort, archived FROM kids ORDER BY archived, sort, id'),
  );
});

core.post('/kids', async (c) => {
  const body = await readBody(c);
  const name = reqStr(body.name, 'name', 40);
  const color = optStr(body.color, 'color', 7) ?? '#e08a2c';
  if (!HEX_COLOR.test(color)) throw badRequest('color must look like #e08a2c');
  const row = await first(
    c.env.DB,
    `INSERT INTO kids (name, color, birth_date, sort) VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 10 FROM kids))
     RETURNING id, name, color, birth_date AS birthDate, sort`,
    name,
    color,
    optDate(body.birthDate, 'birthDate') ?? null,
  );
  return c.json(row, 201);
});

core.patch('/kids/:id', async (c) => {
  const id = paramId(c);
  const body = await readBody(c);
  const color = optStr(body.color, 'color', 7);
  if (color && !HEX_COLOR.test(color)) throw badRequest('color must look like #e08a2c');
  const archived = optBool(body.archived, 'archived');
  const updates = new Updates()
    .set('name', optStr(body.name, 'name', 40) ?? undefined)
    .set('color', color ?? undefined)
    .set('birth_date', optDate(body.birthDate, 'birthDate'))
    .set('sort', optInt(body.sort, 'sort') ?? undefined)
    .set('archived', archived === undefined ? undefined : archived ? 1 : 0);
  if (updates.empty) throw badRequest('Nothing to update');
  const result = await run(c.env.DB, `UPDATE kids SET ${updates.sets.join(', ')}, updated_at = ? WHERE id = ?`, ...updates.params, nowIso(), id);
  if (!result.meta.changes) throw notFound();
  return c.json({ ok: true });
});

core.get('/categories', async (c) => {
  const [sections, categories] = await Promise.all([
    all(c.env.DB, 'SELECT id, name, sort FROM sections ORDER BY sort'),
    loadCategories(c.env.DB),
  ]);
  return c.json({
    sections,
    categories: categories.map((cat) => ({
      id: cat.id,
      sectionId: cat.sectionId,
      sectionName: cat.sectionName,
      name: cat.name,
      kind: cat.kind,
      kidScoped: cat.kidScoped === 1,
      funMemberId: cat.funMemberId,
      archived: cat.archived === 1,
    })),
  });
});

core.post('/categories', async (c) => {
  const body = await readBody(c);
  const sectionId = reqInt(body.sectionId, 'sectionId', { min: 1 });
  const name = reqStr(body.name, 'name', 60);
  const kind = oneOf(body.kind, 'kind', ['income', 'expense', 'savings', 'debt', 'transfer'] as const) ?? 'expense';
  try {
    const row = await first(
      c.env.DB,
      `INSERT INTO categories (section_id, name, kind, kid_scoped, sort)
       VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 10 FROM categories WHERE section_id = ?))
       RETURNING id`,
      sectionId,
      name,
      kind,
      optBool(body.kidScoped, 'kidScoped') ? 1 : 0,
      sectionId,
    );
    return c.json(row, 201);
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new HttpError(409, 'That category already exists in this section.');
    throw error;
  }
});

core.patch('/categories/:id', async (c) => {
  const id = paramId(c);
  const body = await readBody(c);
  const category = await first<{ funMemberId: number | null }>(c.env.DB, 'SELECT fun_member_id AS funMemberId FROM categories WHERE id = ?', id);
  if (!category) throw notFound();
  if (category.funMemberId != null && body.name !== undefined) throw badRequest('Fun money categories follow the person’s name.');
  const archived = optBool(body.archived, 'archived');
  const kidScoped = optBool(body.kidScoped, 'kidScoped');
  const updates = new Updates()
    .set('name', optStr(body.name, 'name', 60) ?? undefined)
    .set('archived', archived === undefined ? undefined : archived ? 1 : 0)
    .set('kid_scoped', kidScoped === undefined ? undefined : kidScoped ? 1 : 0);
  if (updates.empty) throw badRequest('Nothing to update');
  await run(c.env.DB, `UPDATE categories SET ${updates.sets.join(', ')} WHERE id = ?`, ...updates.params, id);
  return c.json({ ok: true });
});

const ACCOUNT_SELECT = `SELECT a.id, a.name, a.institution, a.mask, a.type, a.is_cash AS isCash, a.hidden,
  a.plaid_item_id AS plaidItemId, a.current_balance_cents AS currentBalanceCents,
  a.available_balance_cents AS availableBalanceCents, a.credit_limit_cents AS creditLimitCents,
  a.balance_updated_at AS balanceUpdatedAt, a.owner_member_id AS ownerMemberId,
  p.status AS plaidStatus, p.institution_name AS plaidInstitution,
  (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id AND t.deleted_at IS NULL) AS transactionCount
  FROM accounts a LEFT JOIN plaid_items p ON p.id = a.plaid_item_id`;

core.get('/accounts', async (c) => {
  const rows = await all<Record<string, unknown>>(c.env.DB, `${ACCOUNT_SELECT} ORDER BY a.hidden, a.institution, a.name`);
  return c.json(rows.map((r) => ({ ...r, isCash: r.isCash === 1, hidden: r.hidden === 1 })));
});

core.post('/accounts', async (c) => {
  const body = await readBody(c);
  const type = oneOf(body.type, 'type', ACCOUNT_TYPES) ?? 'checking';
  const row = await first(
    c.env.DB,
    `INSERT INTO accounts (name, institution, mask, type, is_cash, current_balance_cents, balance_updated_at, owner_member_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    reqStr(body.name, 'name', 60),
    optStr(body.institution, 'institution', 60) ?? null,
    optStr(body.mask, 'mask', 8) ?? null,
    type,
    optBool(body.isCash, 'isCash') ?? !['credit', 'loan', 'investment'].includes(type),
    optInt(body.currentBalanceCents, 'currentBalanceCents') ?? null,
    body.currentBalanceCents != null ? nowIso() : null,
    optInt(body.ownerMemberId, 'ownerMemberId', { min: 1 }) ?? null,
  );
  return c.json(row, 201);
});

core.patch('/accounts/:id', async (c) => {
  const id = paramId(c);
  const body = await readBody(c);
  const account = await first<{ plaidItemId: number | null }>(c.env.DB, 'SELECT plaid_item_id AS plaidItemId FROM accounts WHERE id = ?', id);
  if (!account) throw notFound();
  const isCash = optBool(body.isCash, 'isCash');
  const hidden = optBool(body.hidden, 'hidden');
  const balance = optInt(body.currentBalanceCents, 'currentBalanceCents');
  if (balance !== undefined && account.plaidItemId) throw badRequest('Balances for linked accounts come from the bank.');
  const updates = new Updates()
    .set('name', optStr(body.name, 'name', 60) ?? undefined)
    .set('institution', optStr(body.institution, 'institution', 60))
    .set('mask', optStr(body.mask, 'mask', 8))
    .set('type', oneOf(body.type, 'type', ACCOUNT_TYPES))
    .set('is_cash', isCash === undefined ? undefined : isCash ? 1 : 0)
    .set('hidden', hidden === undefined ? undefined : hidden ? 1 : 0)
    .set('owner_member_id', optInt(body.ownerMemberId, 'ownerMemberId', { min: 1 }))
    .set('current_balance_cents', balance)
    .set('balance_updated_at', balance === undefined ? undefined : nowIso());
  if (updates.empty) throw badRequest('Nothing to update');
  await run(c.env.DB, `UPDATE accounts SET ${updates.sets.join(', ')}, updated_at = ? WHERE id = ?`, ...updates.params, nowIso(), id);
  return c.json({ ok: true });
});

core.delete('/accounts/:id', async (c) => {
  const id = paramId(c);
  const account = await first<{ plaidItemId: number | null }>(c.env.DB, 'SELECT plaid_item_id AS plaidItemId FROM accounts WHERE id = ?', id);
  if (!account) throw notFound();
  if (account.plaidItemId) throw badRequest('Disconnect the bank first (Accounts › bank › Disconnect).');
  await run(c.env.DB, 'DELETE FROM accounts WHERE id = ?', id);
  return c.json({ ok: true });
});

/**
 * Moves an import-only account's history into the matching linked account, dropping
 * rows the bank feed already has (same amount within 2 days) but keeping your edits.
 */
core.post('/accounts/:id/merge', async (c) => {
  const db = c.env.DB;
  const fromId = paramId(c);
  const intoId = reqInt((await readBody(c)).intoAccountId, 'intoAccountId', { min: 1 });
  if (fromId === intoId) throw badRequest('Pick a different account.');

  const rows = await all<{ id: number; date: string; amountCents: number; categoryId: number | null; categorySource: string | null; kidId: number | null; notes: string | null; privateMemberId: number | null }>(
    db,
    `SELECT id, date, amount_cents AS amountCents, category_id AS categoryId, category_source AS categorySource,
            kid_id AS kidId, notes, private_member_id AS privateMemberId
       FROM transactions WHERE account_id = ? AND deleted_at IS NULL`,
    fromId,
  );
  const targets = await all<{ id: number; date: string; amountCents: number; categorySource: string | null }>(
    db,
    `SELECT id, date, amount_cents AS amountCents, category_source AS categorySource
       FROM transactions WHERE account_id = ? AND deleted_at IS NULL AND source = 'plaid'`,
    intoId,
  );

  const claimed = new Set<number>();
  const now = nowIso();
  const statements: D1PreparedStatement[] = [];
  let duplicates = 0;
  for (const row of rows) {
    const twin = findImportedTwin(
      { accountId: intoId, date: row.date, amountCents: row.amountCents },
      targets.map((t) => ({ id: t.id, accountId: intoId, date: t.date, amountCents: t.amountCents })),
      2,
      claimed,
    );
    if (twin !== null) {
      claimed.add(twin);
      duplicates++;
      if (row.categorySource === 'user' || row.notes) {
        statements.push(
          stmt(
            db,
            `UPDATE transactions SET category_id = ?, category_source = 'user', kid_id = ?, private_member_id = ?,
               notes = COALESCE(notes, ?), updated_at = ? WHERE id = ? AND (category_source IS NULL OR category_source != 'user')`,
            row.categoryId,
            row.kidId,
            row.privateMemberId,
            row.notes,
            now,
            twin,
          ),
        );
      }
      statements.push(stmt(db, 'DELETE FROM transactions WHERE id = ?', row.id));
    } else {
      statements.push(
        stmt(db, 'UPDATE transactions SET account_id = ?, import_hash = NULL, updated_at = ? WHERE id = ?', intoId, now, row.id),
      );
    }
  }
  statements.push(stmt(db, 'DELETE FROM accounts WHERE id = ? AND plaid_item_id IS NULL', fromId));
  await batchAll(db, statements);
  return c.json({ moved: rows.length - duplicates, duplicates });
});

core.put('/months/:month', async (c) => {
  const month = reqMonth(c.req.param('month'));
  const cents = optInt((await readBody(c)).startingBalanceCents, 'startingBalanceCents');
  if (cents === undefined) throw badRequest('startingBalanceCents is required (null to clear)');
  await run(
    c.env.DB,
    `INSERT INTO month_settings (month, starting_balance_cents) VALUES (?, ?)
     ON CONFLICT (month) DO UPDATE SET starting_balance_cents = excluded.starting_balance_cents, updated_at = ?`,
    month,
    cents,
    nowIso(),
  );
  return c.json({ ok: true });
});
