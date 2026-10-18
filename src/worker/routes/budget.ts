import { Hono } from 'hono';
import { addDays, addMonths, monthOf, monthStart, type ISODate } from '../../shared/dates';
import { SUGGESTED_BUDGET } from '../../shared/defaults';
import { findPaychecks, type DepositInput } from '../../shared/paycheckFinder';
import { payDatesBetween } from '../../shared/paySchedule';
import { PRIVACY_SQL } from '../../shared/privacy';
import type { AppEnv } from '../env';
import { all, batchAll, first, nowIso, run, stmt, Updates } from '../lib/db';
import {
  badRequest,
  notFound,
  oneOf,
  optBool,
  optDate,
  optInt,
  optStr,
  paramId,
  readBody,
  reqDate,
  reqInt,
  reqMonth,
  reqStr,
} from '../lib/http';
import { INCOME_SOURCE_SELECT, loadCategories, loadIngestContext, scheduleOf, type IncomeSourceRow } from '../services/context';
import { reclassify, STORED_SELECT, type StoredTxn } from '../services/ingest';
import { buildPlanner, forecastJson, funMoneyBalances, loadMonth, upcomingBills } from '../services/planner';
import { toApi as txnToApi, TXN_SELECT, type TxnRow } from './transactions';

/**
 * Spending charges from the last 60 days with no category ("Needs a look" on Home).
 * Bind the earliest date, then the viewer's member id.
 */
const NEEDS_LOOK_WHERE = `t.amount_cents < 0 AND t.category_id IS NULL AND t.is_ignored = 0 AND t.transfer_pair_id IS NULL
  AND t.pending = 0 AND t.deleted_at IS NULL AND t.is_split = 0 AND t.date >= ? AND ${PRIVACY_SQL}`;

export const budget = new Hono<AppEnv>();

budget.get('/budget', async (c) => {
  const db = c.env.DB;
  const month = reqMonth(c.req.query('month') ?? monthOf(c.get('today')));
  const [data, previous] = await Promise.all([
    loadMonth(db, month),
    first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM budget_lines WHERE month = ?', addMonths(month, -1)),
  ]);
  const sum = (kinds: string[], key: 'budgetCents' | 'actualCents') =>
    // Top-level rows only: a parent's row already holds its sub-categories' money.
    data.rows.filter((r) => r.parentId === null && kinds.includes(r.kind)).reduce((total, r) => total + r[key], 0);
  return c.json({
    month,
    rows: data.rows,
    uncategorized: { inCents: data.uncategorized.inCents, outCents: data.uncategorized.outCents, count: data.uncategorized.count },
    totals: {
      incomeBudgetCents: sum(['income'], 'budgetCents'),
      incomeActualCents: sum(['income'], 'actualCents') + data.uncategorized.inCents,
      outBudgetCents: sum(['expense', 'savings', 'debt'], 'budgetCents'),
      outActualCents: sum(['expense', 'savings', 'debt'], 'actualCents') + data.uncategorized.outCents,
    },
    hasLines: data.rows.some((r) => r.lineId !== null),
    previousMonthHasLines: (previous?.n ?? 0) > 0,
  });
});

budget.put('/budget/lines', async (c) => {
  const body = await readBody(c);
  const month = reqMonth(body.month);
  const categoryId = reqInt(body.categoryId, 'categoryId', { min: 1 });
  const timing = oneOf(body.timing, 'timing', ['due_day', 'even'] as const) ?? 'even';
  const dueDay = optInt(body.dueDay, 'dueDay', { min: 1, max: 31 }) ?? null;
  if (timing === 'due_day' && dueDay === null) throw badRequest('Pick the day it’s due.');
  const row = await first(
    c.env.DB,
    `INSERT INTO budget_lines (month, category_id, budget_cents, timing, due_day, notes, updated_by_member_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (month, category_id) DO UPDATE SET budget_cents = excluded.budget_cents, timing = excluded.timing,
       due_day = excluded.due_day, notes = excluded.notes, updated_by_member_id = excluded.updated_by_member_id,
       updated_at = ?
     RETURNING id`,
    month,
    categoryId,
    reqInt(body.budgetCents, 'budgetCents', { min: 0 }),
    timing,
    timing === 'due_day' ? dueDay : null,
    optStr(body.notes, 'notes', 300) ?? null,
    c.get('viewer').memberId,
    nowIso(),
  );
  return c.json(row);
});

budget.delete('/budget/lines/:id', async (c) => {
  const result = await run(c.env.DB, 'DELETE FROM budget_lines WHERE id = ?', paramId(c));
  if (!result.meta.changes) throw notFound();
  return c.json({ ok: true });
});

budget.post('/budget/copy', async (c) => {
  const body = await readBody(c);
  const from = reqMonth(body.from, 'from');
  const to = reqMonth(body.to, 'to');
  const result = await run(
    c.env.DB,
    `INSERT OR IGNORE INTO budget_lines (month, category_id, budget_cents, timing, due_day, notes, updated_by_member_id)
     SELECT ?, category_id, budget_cents, timing, due_day, notes, ? FROM budget_lines WHERE month = ?`,
    to,
    c.get('viewer').memberId,
    from,
  );
  return c.json({ copied: result.meta.changes });
});

budget.post('/budget/suggested', async (c) => {
  const db = c.env.DB;
  const month = reqMonth((await readBody(c)).month);
  const categories = await loadCategories(db);
  const viewer = c.get('viewer');
  const statements = SUGGESTED_BUDGET.flatMap((s) => {
    const category = categories.find((cat) => cat.sectionName === s.section && cat.name === s.category);
    if (!category) return [];
    return [
      stmt(
        db,
        `INSERT OR IGNORE INTO budget_lines (month, category_id, budget_cents, timing, due_day, updated_by_member_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        month,
        category.id,
        s.dollars * 100,
        s.timing,
        s.dueDay ?? null,
        viewer.memberId,
      ),
    ];
  });
  const results = await batchAll(db, statements);
  return c.json({ added: results.reduce((n, r) => n + (r.meta.changes ?? 0), 0) });
});

budget.get('/planner', async (c) => {
  const db = c.env.DB;
  const today = c.get('today');
  const month = reqMonth(c.req.query('month') ?? monthOf(today));
  const planner = await buildPlanner(db, month, c.get('household'), today);
  const bills = await upcomingBills(db, planner, today, c.get('viewer').memberId, 45);
  return c.json({
    month,
    today,
    startingBalance: planner.startingBalance,
    safe: planner.safe,
    lowBalanceCents: c.get('household').lowBalanceCents,
    forecast: forecastJson(planner.forecast),
    lines: planner.data.rows
      .filter((r) => planner.forecast.remainingByLine.has(r.categoryId))
      .map((r) => ({ categoryId: r.categoryId, name: r.name, sectionName: r.sectionName, kind: r.kind, timing: r.timing, dueDay: r.dueDay, budgetCents: r.budgetCents, actualCents: r.actualCents })),
    sources: planner.data.sources.map((s) => ({ id: s.id, name: s.name })),
    bills: bills.filter((b) => monthOf(b.date) === month),
  });
});

budget.get('/home', async (c) => {
  const db = c.env.DB;
  const today = c.get('today');
  const viewer = c.get('viewer');
  const household = c.get('household');
  const month = monthOf(today);

  const since = addDays(today, -60);
  const [planner, fun, uncategorized, items, previousCheckin, previousActivity, needsLookCount, needsLookRows] = await Promise.all([
    buildPlanner(db, month, household, today),
    funMoneyBalances(db, household, today, viewer.memberId),
    first<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM transactions t
        WHERE t.deleted_at IS NULL AND t.is_ignored = 0 AND t.category_id IS NULL AND t.is_split = 0
          AND t.transfer_pair_id IS NULL AND ${PRIVACY_SQL}`,
      viewer.memberId,
    ),
    all<{ id: number; institutionName: string | null; status: string; lastSyncedAt: string | null; errorMessage: string | null }>(
      db,
      `SELECT id, institution_name AS institutionName, status, last_synced_at AS lastSyncedAt, error_message AS errorMessage
         FROM plaid_items ORDER BY id`,
    ),
    first<{ status: string }>(db, 'SELECT status FROM checkins WHERE month = ?', addMonths(month, -1)),
    first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM transactions WHERE date LIKE ? AND deleted_at IS NULL', `${addMonths(month, -1)}-%`),
    first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM transactions t WHERE ${NEEDS_LOOK_WHERE}`, since, viewer.memberId),
    all<TxnRow>(db, `${TXN_SELECT} WHERE ${NEEDS_LOOK_WHERE} ORDER BY t.date DESC, t.id DESC LIMIT 5`, since, viewer.memberId),
  ]);
  const bills = await upcomingBills(db, planner, today, viewer.memberId);
  const position = planner.forecast.currentWeekPosition;
  const week = position === null ? null : planner.forecast.weeks[position] ?? null;

  return c.json({
    today,
    month,
    safe: planner.safe,
    week,
    weeks: planner.forecast.weeks.map((w) => ({ index: w.index, start: w.start, end: w.end, endBalance: w.endBalance, status: w.status, isCurrent: w.isCurrent, isPast: w.isPast })),
    lowBalanceCents: household.lowBalanceCents,
    startingBalance: planner.startingBalance,
    extraPaychecks: planner.forecast.extraPaychecks,
    bills: bills.slice(0, 5),
    fun: fun.map((f) =>
      f.isViewer
        ? f
        : { memberId: f.memberId, name: f.name, color: f.color, balanceCents: f.balanceCents, isViewer: false },
    ),
    uncategorizedCount: uncategorized?.n ?? 0,
    needsLook: { count: needsLookCount?.n ?? 0, items: needsLookRows.map((r) => txnToApi(r)) },
    banks: items,
    lastSyncedAt: items.map((i) => i.lastSyncedAt).filter(Boolean).sort().at(-1) ?? null,
    checkin:
      (previousActivity?.n ?? 0) > 0 && previousCheckin?.status !== 'complete'
        ? { month: addMonths(month, -1), status: previousCheckin?.status ?? 'not_started' }
        : null,
  });
});

function sourceToApi(row: IncomeSourceRow, today: ISODate) {
  const schedule = scheduleOf(row);
  return {
    id: row.id,
    memberId: row.memberId,
    name: row.name,
    netPayCents: row.netPayCents,
    frequency: row.frequency,
    anchorDate: row.anchorDate,
    semimonthlyDays: schedule.semimonthlyDays ?? null,
    matchText: row.matchText,
    accountId: row.accountId,
    drivesAllowance: row.drivesAllowance === 1,
    active: row.active === 1,
    nextPayDates: payDatesBetween(schedule, today, addDays(today, 45)).slice(0, 3),
  };
}

/** Recognize paychecks in recent deposits after income settings change. */
async function rematchPaychecks(db: D1Database) {
  const since = new Date(Date.now() - 75 * 86_400_000).toISOString().slice(0, 10);
  const rows = await all<StoredTxn>(db, `${STORED_SELECT} WHERE t.amount_cents > 0 AND t.deleted_at IS NULL AND t.date >= ? LIMIT 1000`, since);
  return reclassify(db, await loadIngestContext(db), rows);
}

budget.get('/income-sources', async (c) => {
  const rows = await all<IncomeSourceRow>(c.env.DB, `${INCOME_SOURCE_SELECT} ORDER BY active DESC, id`);
  return c.json(rows.map((r) => sourceToApi(r, c.get('today'))));
});

/**
 * Paychecks found in deposit history, for "Find my paychecks". Nothing is saved: you pick
 * one, check whose it is, and save it like any income source. Deposits already recognized
 * as a paycheck, transfers between your accounts, and the partner's private rows are left out.
 */
budget.get('/income-sources/suggestions', async (c) => {
  const db = c.env.DB;
  const today = c.get('today');
  const deposits = await all<DepositInput>(
    db,
    `SELECT t.id, t.date, t.amount_cents AS amountCents, t.name, t.merchant_name AS merchantName,
            COALESCE(t.normalized_merchant, t.name) AS merchant, t.account_id AS accountId, t.plaid_category AS plaidCategory
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.amount_cents > 0 AND t.deleted_at IS NULL AND t.is_ignored = 0 AND t.pending = 0
        AND t.transfer_pair_id IS NULL AND (c.kind IS NULL OR c.kind != 'transfer')
        AND COALESCE(t.plaid_category, '') != 'TRANSFER_IN' AND t.income_source_id IS NULL
        AND t.date >= ? AND ${PRIVACY_SQL}`,
    monthStart(addMonths(monthOf(today), -9)),
    c.get('viewer').memberId,
  );
  // Recent paychecks are tagged; older ones from a source you already have aren't, so skip those too.
  // Same text and a similar amount: a second job paid the same way still shows up.
  const sources = await all<{ matchText: string; netPayCents: number }>(
    db,
    'SELECT match_text AS matchText, net_pay_cents AS netPayCents FROM income_sources WHERE match_text IS NOT NULL',
  );
  const known = sources.map((s) => ({ text: s.matchText.toUpperCase().trim(), cents: s.netPayCents })).filter((k) => k.text);
  const suggestions = findPaychecks(deposits, { today }).filter(
    (s) =>
      !known.some(
        (k) => (s.matchText.includes(k.text) || k.text.includes(s.matchText)) && Math.abs(s.netPayCents - k.cents) <= k.cents * 0.4,
      ),
  );
  return c.json(suggestions);
});

function readSource(body: Record<string, unknown>, partial: boolean) {
  const frequency = oneOf(body.frequency, 'frequency', ['weekly', 'biweekly', 'semimonthly', 'monthly'] as const);
  const days = Array.isArray(body.semimonthlyDays) ? body.semimonthlyDays : undefined;
  return {
    name: partial ? optStr(body.name, 'name', 60) ?? undefined : reqStr(body.name, 'name', 60),
    netPayCents: partial ? optInt(body.netPayCents, 'netPayCents', { min: 0 }) ?? undefined : reqInt(body.netPayCents, 'netPayCents', { min: 0 }),
    frequency: partial ? frequency : frequency ?? 'weekly',
    anchorDate: partial ? optDate(body.anchorDate, 'anchorDate') ?? undefined : reqDate(body.anchorDate, 'anchorDate'),
    semimonthlyDay1: days ? optInt(days[0], 'semimonthlyDays[0]', { min: 1, max: 31 }) : undefined,
    semimonthlyDay2: days ? optInt(days[1], 'semimonthlyDays[1]', { min: 1, max: 31 }) : undefined,
    matchText: optStr(body.matchText, 'matchText', 80),
    accountId: optInt(body.accountId, 'accountId', { min: 1 }),
    memberId: optInt(body.memberId, 'memberId', { min: 1 }),
    drivesAllowance: optBool(body.drivesAllowance, 'drivesAllowance'),
    active: optBool(body.active, 'active'),
  };
}

budget.post('/income-sources', async (c) => {
  const db = c.env.DB;
  const s = readSource(await readBody(c), false);
  const row = await first<{ id: number }>(
    db,
    `INSERT INTO income_sources (member_id, name, net_pay_cents, frequency, anchor_date, semimonthly_day1, semimonthly_day2,
                                 match_text, account_id, drives_allowance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    s.memberId ?? c.get('viewer').memberId,
    s.name,
    s.netPayCents,
    s.frequency,
    s.anchorDate,
    s.semimonthlyDay1 ?? null,
    s.semimonthlyDay2 ?? null,
    s.matchText ?? null,
    s.accountId ?? null,
    s.drivesAllowance ?? true,
  );
  const rematched = await rematchPaychecks(db);
  return c.json({ id: row?.id, rematched }, 201);
});

budget.patch('/income-sources/:id', async (c) => {
  const db = c.env.DB;
  const id = paramId(c);
  const s = readSource(await readBody(c), true);
  const updates = new Updates()
    .set('name', s.name)
    .set('net_pay_cents', s.netPayCents)
    .set('frequency', s.frequency)
    .set('anchor_date', s.anchorDate)
    .set('semimonthly_day1', s.semimonthlyDay1)
    .set('semimonthly_day2', s.semimonthlyDay2)
    .set('match_text', s.matchText)
    .set('account_id', s.accountId)
    .set('member_id', s.memberId)
    .set('drives_allowance', s.drivesAllowance === undefined ? undefined : s.drivesAllowance ? 1 : 0)
    .set('active', s.active === undefined ? undefined : s.active ? 1 : 0);
  if (updates.empty) throw badRequest('Nothing to update');
  const result = await run(db, `UPDATE income_sources SET ${updates.sets.join(', ')}, updated_at = ? WHERE id = ?`, ...updates.params, nowIso(), id);
  if (!result.meta.changes) throw notFound();
  return c.json({ ok: true, rematched: await rematchPaychecks(db) });
});

budget.delete('/income-sources/:id', async (c) => {
  const db = c.env.DB;
  const result = await run(db, 'DELETE FROM income_sources WHERE id = ?', paramId(c));
  if (!result.meta.changes) throw notFound();
  return c.json({ ok: true, rematched: await rematchPaychecks(db) });
});
