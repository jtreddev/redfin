import { Hono } from 'hono';
import { monthOf, monthStart } from '../../shared/dates';
import { rewriteCategoryIds } from '../../shared/activityQuery';
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
import type { CategoryKind } from '../../shared/actuals';
import {
  chargesIn,
  crossesIncome,
  isSpecial,
  kindInGroup,
  loadCategoryInfo,
  mergeCounts,
  mergeStatements,
  type CategoryInfo,
} from '../services/categories';
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

core.patch('/me/prefs', async (c) => {
  const body = await readBody(c);
  const hideSetup = optBool(body.hideSetup, 'hideSetup');
  const powerTools = optBool(body.powerTools, 'powerTools');
  const hideAmounts = optBool(body.hideAmounts, 'hideAmounts');
  const updates = new Updates()
    .set('hide_setup', hideSetup === undefined ? undefined : hideSetup ? 1 : 0)
    .set('power_tools', powerTools === undefined ? undefined : powerTools ? 1 : 0)
    .set('hide_amounts', hideAmounts === undefined ? undefined : hideAmounts ? 1 : 0);
  if (updates.empty) throw badRequest('Nothing to update');
  await run(c.env.DB, `UPDATE members SET ${updates.sets.join(', ')}, updated_at = ? WHERE id = ?`, ...updates.params, nowIso(), c.get('viewer').memberId);
  return c.json({ ok: true });
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

core.post('/kids/reorder', async (c) => {
  const body = await readBody(c);
  if (!Array.isArray(body.ids) || body.ids.length > 200 || !body.ids.every((id) => Number.isInteger(id))) {
    throw badRequest('ids must be a list of kid ids');
  }
  const db = c.env.DB;
  const ids = body.ids as number[];
  const current = (await all<{ id: number }>(db, 'SELECT id FROM kids ORDER BY sort, id')).map((k) => k.id);
  const known = new Set(current);
  if (new Set(ids).size !== ids.length || !ids.every((id) => known.has(id))) {
    throw badRequest('ids must be distinct kids that exist');
  }
  // Kids not mentioned (e.g. hidden ones) keep their relative order after the listed ones.
  const order = [...ids, ...current.filter((id) => !ids.includes(id))];
  const now = nowIso();
  await batchAll(db, order.map((id, i) => stmt(db, 'UPDATE kids SET sort = ?, updated_at = ? WHERE id = ?', (i + 1) * 10, now, id)));
  return c.json({ ok: true });
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
      parentId: cat.parentId,
      name: cat.name,
      kind: cat.kind,
      kidScoped: cat.kidScoped === 1,
      funMemberId: cat.funMemberId,
      archived: cat.archived === 1,
      sort: cat.sort,
    })),
  });
});

/** A category that can hold sub-categories: top level, not Fun Money, not hidden, not `self`. */
async function validParent(db: D1Database, parentId: number, self: number | null): Promise<CategoryInfo> {
  const parent = await loadCategoryInfo(db, parentId);
  if (!parent) throw badRequest('That parent category doesn’t exist.');
  if (parent.id === self) throw badRequest('A category can’t be its own sub-category.');
  if (parent.parentId !== null) throw badRequest('Sub-categories can’t have sub-categories.');
  if (parent.funMemberId != null) throw badRequest('Fun Money can’t have sub-categories.');
  if (parent.archived) throw badRequest(`Show ${parent.name} first.`);
  return parent;
}

/** The next sort value among a group's top-level categories, or among a parent's children. */
async function nextSort(db: D1Database, sectionId: number, parentId: number | null): Promise<number> {
  const row = await first<{ sort: number }>(
    db,
    'SELECT COALESCE(MAX(sort), 0) + 10 AS sort FROM categories WHERE section_id = ? AND parent_id IS ?',
    sectionId,
    parentId,
  );
  return row?.sort ?? 10;
}

async function sectionName(db: D1Database, id: number): Promise<string> {
  const row = await first<{ name: string }>(db, 'SELECT name FROM sections WHERE id = ?', id);
  if (!row) throw badRequest('That group doesn’t exist.');
  return row.name;
}

function uniqueName(error: unknown): unknown {
  return String(error).includes('UNIQUE') ? new HttpError(409, 'That category already exists in this group.') : error;
}

core.post('/categories', async (c) => {
  const db = c.env.DB;
  const body = await readBody(c);
  const name = reqStr(body.name, 'name', 60);
  const parentId = optInt(body.parentId, 'parentId', { min: 1 }) ?? null;
  const requestedSection = optInt(body.sectionId, 'sectionId', { min: 1 }) ?? null;
  const requestedKind = oneOf(body.kind, 'kind', ['income', 'expense', 'savings', 'debt', 'transfer'] as const) ?? null;
  let sectionId: number;
  let kind: CategoryKind;
  if (parentId !== null) {
    const parent = await validParent(db, parentId, null);
    if (requestedSection !== null && requestedSection !== parent.sectionId) throw badRequest('A sub-category is in its parent’s group.');
    if (isSpecial({ sectionName: parent.sectionName, name })) throw badRequest(`${name} is one the app relies on, so it stays a top-level category.`);
    sectionId = parent.sectionId;
    kind = parent.kind;
  } else {
    if (requestedSection === null) throw badRequest('sectionId is required');
    sectionId = requestedSection;
    // Kind follows the group (debt is allowed where spending is).
    kind = kindInGroup(await sectionName(db, sectionId), requestedKind);
  }
  try {
    const row = await first(
      db,
      'INSERT INTO categories (section_id, parent_id, name, kind, kid_scoped, sort) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      sectionId,
      parentId,
      name,
      kind,
      optBool(body.kidScoped, 'kidScoped') ? 1 : 0,
      await nextSort(db, sectionId, parentId),
    );
    return c.json(row, 201);
  } catch (error) {
    throw uniqueName(error);
  }
});

core.patch('/categories/:id', async (c) => {
  const db = c.env.DB;
  const id = paramId(c);
  const body = await readBody(c);
  const category = await loadCategoryInfo(db, id);
  if (!category) throw notFound();
  if (category.funMemberId != null && body.name !== undefined) throw badRequest('Fun money categories follow the person’s name.');

  const name = optStr(body.name, 'name', 60) ?? undefined;
  const archived = optBool(body.archived, 'archived');
  const kidScoped = optBool(body.kidScoped, 'kidScoped');
  const confirm = optBool(body.confirm, 'confirm') === true;
  const requestedSection = optInt(body.sectionId, 'sectionId', { min: 1 }) ?? undefined;
  const parentId = body.parentId === undefined ? category.parentId : (optInt(body.parentId, 'parentId', { min: 1 }) ?? null);

  // Under a parent it's in the parent's group; otherwise in the group asked for.
  let sectionId = requestedSection ?? category.sectionId;
  let parent: CategoryInfo | null = null;
  if (parentId !== null) {
    parent = parentId === category.parentId ? await loadCategoryInfo(db, parentId) : await validParent(db, parentId, id);
    if (!parent) throw badRequest('That parent category doesn’t exist.');
    if (parentId !== category.parentId && isSpecial(category)) {
      throw badRequest(`The app relies on ${category.name}, so it stays a top-level category.`);
    }
    if (parentId !== category.parentId && category.children > 0) {
      throw badRequest(`${category.name} has sub-categories, so it can’t become one.`);
    }
    if (requestedSection !== undefined && requestedSection !== parent.sectionId) {
      throw badRequest('A sub-category stays in its parent’s group. Take it out of its parent first.');
    }
    sectionId = parent.sectionId;
  }
  const moved = sectionId !== category.sectionId || parentId !== category.parentId;
  if (moved && category.funMemberId != null) throw badRequest('Fun Money stays where it is.');
  if (isSpecial(category) && (sectionId !== category.sectionId || (name !== undefined && name !== category.name))) {
    throw badRequest(`The app looks for ${category.name} by its name and group, so it keeps them.`);
  }

  // Kind follows the group: a new child takes its parent's kind; a move to another group, that group's.
  let kind = category.kind;
  if (parent && parentId !== category.parentId) kind = parent.kind;
  else if (sectionId !== category.sectionId) kind = kindInGroup(await sectionName(db, sectionId), category.kind);

  if (crossesIncome(category.kind, kind)) {
    // Decided on what the viewer can see, so a partner's private charges are never hinted at.
    const charges = await chargesIn(db, id, c.get('viewer').memberId);
    if (charges.visible > 0 && !confirm) {
      return c.json(
        {
          error: `This moves ${category.name} between income and spending, which changes past months’ totals.`,
          needsConfirm: true,
          transactionCount: charges.visible,
          kind,
        },
        409,
      );
    }
  }

  if (archived === true && category.funMemberId != null) throw badRequest('Fun money follows its person, so it stays.');
  if (archived === true && isSpecial(category)) throw badRequest(`The app relies on ${category.name}, so it can’t be hidden.`);
  if (archived === false && parent?.archived) throw badRequest(`Show ${parent.name} first.`);

  const updates = new Updates()
    .set('name', name)
    .set('archived', archived === undefined ? undefined : archived ? 1 : 0)
    .set('kid_scoped', kidScoped === undefined ? undefined : kidScoped ? 1 : 0);
  if (moved) updates.set('section_id', sectionId).set('parent_id', parentId).set('sort', await nextSort(db, sectionId, parentId));
  if (kind !== category.kind) updates.set('kind', kind);
  if (updates.empty) throw badRequest('Nothing to update');

  const statements = [stmt(db, `UPDATE categories SET ${updates.sets.join(', ')} WHERE id = ?`, ...updates.params, id)];
  // Sub-categories go where their parent goes, and are hidden with it.
  if (category.children > 0 && (sectionId !== category.sectionId || kind !== category.kind)) {
    statements.push(stmt(db, 'UPDATE categories SET section_id = ?, kind = ? WHERE parent_id = ?', sectionId, kind, id));
  }
  if (category.children > 0 && archived === true) statements.push(stmt(db, 'UPDATE categories SET archived = 1 WHERE parent_id = ?', id));
  try {
    await db.batch(statements);
  } catch (error) {
    throw uniqueName(error);
  }
  return c.json({ ok: true });
});

/** Orders a group's top-level categories (or one parent's sub-categories). Ones left out keep their order after. */
core.post('/categories/reorder', async (c) => {
  const db = c.env.DB;
  const body = await readBody(c);
  const sectionId = reqInt(body.sectionId, 'sectionId', { min: 1 });
  const parentId = optInt(body.parentId, 'parentId', { min: 1 }) ?? null;
  if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 200) throw badRequest('ids must be a list of categories');
  const ids = body.ids.map((v: unknown) => reqInt(v, 'ids', { min: 1 }));
  if (new Set(ids).size !== ids.length) throw badRequest('List each category once.');
  const siblings = await all<{ id: number }>(
    db,
    'SELECT id FROM categories WHERE section_id = ? AND parent_id IS ? ORDER BY sort, name',
    sectionId,
    parentId,
  );
  const known = new Set(siblings.map((s) => s.id));
  if (!ids.every((i) => known.has(i))) throw badRequest('Those categories aren’t all in that group.');
  const listed = new Set(ids);
  const order = [...ids, ...siblings.map((s) => s.id).filter((i) => !listed.has(i))];
  // One statement (the D1 free plan caps queries per request): sort = (position + 1) × 10.
  const json = JSON.stringify(order);
  await run(
    db,
    `UPDATE categories SET sort = (SELECT (CAST(j.key AS INTEGER) + 1) * 10 FROM json_each(?) j WHERE j.value = categories.id)
      WHERE id IN (SELECT value FROM json_each(?))`,
    json,
    json,
  );
  return c.json({ ok: true });
});

/** Folds this category into another; `?preview=1` returns the counts without changing anything. */
core.post('/categories/:id/merge', async (c) => {
  const db = c.env.DB;
  const id = paramId(c);
  const body = await readBody(c);
  const intoId = reqInt(body.intoId, 'intoId', { min: 1 });
  const preview = c.req.query('preview') === '1';
  const confirm = optBool(body.confirm, 'confirm') === true;
  const viewerId = c.get('viewer').memberId;

  const [from, into] = await Promise.all([loadCategoryInfo(db, id), loadCategoryInfo(db, intoId)]);
  if (!from) throw notFound();
  if (!into) throw badRequest('That category doesn’t exist.');
  if (from.id === into.id) throw badRequest('Pick a different category to merge into.');
  if (from.funMemberId != null || into.funMemberId != null) throw badRequest('Fun Money can’t be merged.');
  if (into.archived) throw badRequest(`Show ${into.name} first.`);
  if (into.parentId === from.id) throw badRequest(`${into.name} is one of ${from.name}’s sub-categories.`);
  if (from.children > 0 && into.parentId !== null) {
    throw badRequest(`${from.name} has sub-categories, so it can only merge into a top-level category.`);
  }
  if (isSpecial(from)) throw badRequest(`The app relies on ${from.name}, so it can’t be merged away.`);
  if (from.children > 0 && from.sectionId !== into.sectionId) {
    // Its sub-categories move to the target's group, where a name may already be taken.
    const taken = await first<{ name: string }>(
      db,
      `SELECT k.name FROM categories k
        WHERE k.parent_id = ? AND EXISTS (SELECT 1 FROM categories o WHERE o.section_id = ? AND o.name = k.name)`,
      id,
      into.sectionId,
    );
    if (taken) throw new HttpError(409, `${into.sectionName} already has a category named ${taken.name}. Rename one first.`);
  }

  // Decided on what the viewer can see, so a partner's private charges are never hinted at.
  const charges = crossesIncome(from.kind, into.kind) ? await chargesIn(db, id, viewerId) : null;
  const needsConfirm = charges !== null && charges.visible > 0;
  const counts = await mergeCounts(db, id, viewerId);
  // A preview always answers with the counts; it says whether the merge will need confirming.
  if (preview) return c.json({ preview, intoId, counts, needsConfirm });
  if (needsConfirm && !confirm) {
    return c.json(
      {
        error: 'This moves charges between income and spending, which changes past months’ totals.',
        needsConfirm: true,
        transactionCount: charges.visible,
      },
      409,
    );
  }
  // Saved searches are query strings (categoryId=3,5), not columns: re-point them in the same batch, everyone's.
  const saved = await all<{ id: number; query: string }>(db, "SELECT id, query FROM saved_searches WHERE query LIKE '%categor%'");
  const rewrites = saved
    .map((s) => ({ id: s.id, query: rewriteCategoryIds(s.query, id, into.id) }))
    .filter((s): s is { id: number; query: string } => s.query !== null);
  const statements = mergeStatements(db, id, into, viewerId, nowIso());
  if (rewrites.length) {
    statements.push(
      stmt(
        db,
        `UPDATE saved_searches SET query = (SELECT json_extract(j.value, '$.query') FROM json_each(?) j
                                              WHERE json_extract(j.value, '$.id') = saved_searches.id)
          WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?))`,
        JSON.stringify(rewrites),
        JSON.stringify(rewrites),
      ),
    );
  }
  try {
    await db.batch(statements);
  } catch (error) {
    throw uniqueName(error);
  }
  return c.json({ preview, intoId, counts, needsConfirm });
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
