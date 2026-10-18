import { Hono } from 'hono';
import { ledgerEntries } from '../../shared/actuals';
import { draftNextBudget, summarizeMonth, type CheckinLine, type OverspendDecision } from '../../shared/checkin';
import { GROUPS } from '../../shared/categorySet';
import { addMonths, minDate, monthEnd, monthOf, monthStart, type ISODate, type MonthKey } from '../../shared/dates';
import { planPayoff } from '../../shared/debt';
import { goalProgress } from '../../shared/goals';
import { toCsv } from '../../shared/import/csv';
import { PRIVACY_SQL } from '../../shared/privacy';
import { likeAnywhere, parseSearch } from '../../shared/search';
import { detectRecurring, guessCadence, median, nextOccurrence, sameBill, type Cadence } from '../../shared/recurring';
import type { AppEnv } from '../env';
import { all, batchAll, first, nowIso, run, stmt, Updates, type Param } from '../lib/db';
import {
  badRequest,
  HttpError,
  notFound,
  oneOf,
  optBool,
  optDate,
  optInt,
  optNumber,
  optStr,
  paramId,
  readBody,
  reqDate,
  reqInt,
  reqMonth,
  reqStr,
} from '../lib/http';
import { loadCategories } from '../services/context';
import { loadLedger } from '../services/ledger';
import { funMoneyBalances, loadMonth } from '../services/planner';
import { visibleTxn } from './transactions';

export const planning = new Hono<AppEnv>();

const titleCase = (text: string) => text.toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase());

function mostCommon<T>(values: readonly T[]): T | null {
  const counts = new Map<T, number>();
  let best: T | null = null;
  let bestCount = 0;
  for (const v of values) {
    const n = (counts.get(v) ?? 0) + 1;
    counts.set(v, n);
    if (n > bestCount) {
      best = v;
      bestCount = n;
    }
  }
  return best;
}

// ───────────────────────── Recurring bills ─────────────────────────

const RECURRING_SELECT = `SELECT r.id, r.merchant, r.name, r.cadence, r.expected_amount_cents AS expectedAmountCents,
  r.last_date AS lastDate, r.next_date AS nextDate, r.category_id AS categoryId, c.name AS categoryName,
  r.account_id AS accountId, r.status, r.confidence, r.private_member_id AS privateMemberId
  FROM recurring_bills r LEFT JOIN categories c ON c.id = r.category_id
  LEFT JOIN categories pc ON pc.id = c.parent_id`;

/**
 * Bills, optionally searched (`q`: name, merchant, category, an amount or a size like ">50") and filtered
 * by `status` (suggested | confirmed | dismissed | all). Without a status, dismissed ones stay out
 * unless `all=1`.
 */
planning.get('/recurring', async (c) => {
  const status = oneOf(c.req.query('status'), 'status', ['suggested', 'confirmed', 'dismissed', 'all'] as const);
  const where = ['(r.private_member_id IS NULL OR r.private_member_id = ?)'];
  const params: Param[] = [c.get('viewer').memberId];
  if (status && status !== 'all') {
    where.push('r.status = ?');
    params.push(status);
  } else if (!status && c.req.query('all') !== '1') {
    where.push("r.status != 'dismissed'");
  }
  const search = parseSearch((c.req.query('q') ?? '').slice(0, 100));
  if (search.text) {
    const like = likeAnywhere(search.text.slice(0, 60));
    // A sub-category's bills are found by its parent's name too.
    const textMatch = `r.name LIKE ? ESCAPE '\\' OR r.merchant LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR pc.name LIKE ? ESCAPE '\\'`;
    params.push(like, like, like, like);
    if (search.amount) {
      where.push(`(${textMatch} OR ABS(r.expected_amount_cents) BETWEEN ? AND ?)`);
      params.push(search.amount.minCents, search.amount.maxCents);
    } else {
      where.push(`(${textMatch})`);
    }
  }
  if (search.minCents !== null) {
    where.push('ABS(r.expected_amount_cents) >= ?');
    params.push(search.minCents);
  }
  if (search.maxCents !== null) {
    where.push('ABS(r.expected_amount_cents) <= ?');
    params.push(search.maxCents);
  }
  return c.json(
    await all(
      c.env.DB,
      `${RECURRING_SELECT}
        WHERE ${where.join(' AND ')}
        ORDER BY CASE r.status WHEN 'suggested' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END, r.next_date`,
      ...params,
    ),
  );
});

planning.post('/recurring/detect', async (c) => {
  const db = c.env.DB;
  const today = c.get('today');
  const rows = await all<{ id: number; date: ISODate; amountCents: number; merchant: string; categoryId: number | null; privateMemberId: number | null; accountId: number }>(
    db,
    `SELECT t.id, t.date, t.amount_cents AS amountCents, COALESCE(t.normalized_merchant, t.name) AS merchant,
            t.category_id AS categoryId, t.private_member_id AS privateMemberId, t.account_id AS accountId
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.deleted_at IS NULL AND t.is_ignored = 0 AND t.transfer_pair_id IS NULL AND t.pending = 0
        AND t.amount_cents < 0 AND (c.kind IS NULL OR c.kind != 'transfer') AND t.date >= ?`,
    // Plaid sends up to two years; yearly bills need two charges to be found.
    monthStart(addMonths(monthOf(today), -25)),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const saved = await all<{ merchant: string; cadence: string; cents: number }>(
    db,
    'SELECT merchant, cadence, expected_amount_cents AS cents FROM recurring_bills',
  );
  const suggestions = detectRecurring(rows, { today, saved: new Map(saved.map((b) => [`${b.merchant}|${b.cadence}`, b.cents])) });
  const now = nowIso();

  // Suggestions that weren't found again (a cancelled subscription) go; confirmed and dismissed bills stay.
  const found = new Set(suggestions.map((s) => `${s.merchant}|${s.cadence}`));
  const suggested = await all<{ id: number; merchant: string; cadence: string }>(
    db,
    `SELECT id, merchant, cadence FROM recurring_bills WHERE status = 'suggested'`,
  );
  await batchAll(
    db,
    suggested
      .filter((b) => !found.has(`${b.merchant}|${b.cadence}`))
      .map((b) => stmt(db, 'DELETE FROM recurring_bills WHERE id = ?', b.id)),
  );

  await batchAll(
    db,
    suggestions.map((s) => {
      const txns = s.transactionIds.map((id) => byId.get(id)).filter((t): t is NonNullable<typeof t> => Boolean(t));
      const privateIds = new Set(txns.map((t) => t.privateMemberId));
      const privateMemberId = privateIds.size === 1 ? ([...privateIds][0] ?? null) : null;
      return stmt(
        db,
        `INSERT INTO recurring_bills (merchant, name, cadence, expected_amount_cents, last_date, next_date, category_id,
                                      account_id, confidence, private_member_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (merchant, cadence) DO UPDATE SET expected_amount_cents = excluded.expected_amount_cents,
           last_date = excluded.last_date, next_date = excluded.next_date, confidence = excluded.confidence,
           category_id = COALESCE(recurring_bills.category_id, excluded.category_id), account_id = excluded.account_id,
           private_member_id = excluded.private_member_id, updated_at = ?`,
        s.merchant,
        titleCase(s.merchant),
        s.cadence,
        s.expectedAmountCents,
        s.lastDate,
        s.nextDate,
        mostCommon(txns.map((t) => t.categoryId).filter((id): id is number => id !== null)),
        mostCommon(txns.map((t) => t.accountId)),
        s.confidence,
        privateMemberId,
        now,
      );
    }),
  );
  return c.json({ found: suggestions.length });
});

// Marking a charge as a bill by hand, for bills the finder misses (changing amounts, loan payments, short history).

const CADENCES = ['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'] as const;

interface BillRow {
  id: number;
  merchant: string;
  name: string;
  cadence: Cadence;
  cents: number;
  status: 'suggested' | 'confirmed' | 'dismissed';
  privateMemberId: number | null;
}

/** A transaction's bill key, the same one detection uses. */
async function billKey(db: D1Database, txnId: number) {
  const row = await first<{ merchant: string }>(db, 'SELECT COALESCE(normalized_merchant, name) AS merchant FROM transactions WHERE id = ?', txnId);
  return row?.merchant ?? '';
}

/** Every bill under this merchant, including "MERCHANT $9" for a second subscription; private ones included so keys don't collide. */
const billsUnder = (db: D1Database, merchant: string) =>
  all<BillRow>(
    db,
    `SELECT id, merchant, name, cadence, expected_amount_cents AS cents, status, private_member_id AS privateMemberId
       FROM recurring_bills WHERE merchant = ? OR substr(merchant, 1, length(?) + 2) = ? || ' $'`,
    merchant,
    merchant,
    merchant,
  );

/**
 * The bill this charge belongs to: the one the app named, else the closest in amount. Only bills shared or
 * private the same way as the charge, so marking never moves a bill between the two of you.
 */
function billFor(bills: readonly BillRow[], txn: { amountCents: number; privateMemberId: number | null }, billId?: number): BillRow | null {
  const mine = bills.filter((b) => b.privateMemberId === txn.privateMemberId);
  const named = mine.find((b) => b.id === billId);
  if (named) return named;
  // With one bill from this merchant, a big swing (a summer power bill) is still that bill.
  const ratio = mine.length === 1 ? 4 : 2;
  const amountCents = txn.amountCents;
  const candidates = mine.filter((b) => sameBill(b.cents, amountCents, ratio));
  candidates.sort((a, b) => Math.abs(Math.abs(a.cents) - Math.abs(amountCents)) - Math.abs(Math.abs(b.cents) - Math.abs(amountCents)));
  return candidates[0] ?? null;
}

/** This merchant's charges of about this size that you can see, newest first. */
const similarCharges = async (db: D1Database, merchant: string, amountCents: number, viewerId: number, since: ISODate) =>
  (
    await all<{ date: ISODate; cents: number }>(
      db,
      `SELECT t.date, t.amount_cents AS cents FROM transactions t
        WHERE COALESCE(t.normalized_merchant, t.name) = ? AND t.amount_cents < 0 AND t.deleted_at IS NULL
          AND t.pending = 0 AND t.date >= ? AND ${PRIVACY_SQL}
        ORDER BY t.date DESC`,
      merchant,
      since,
      viewerId,
    )
  ).filter((t) => sameBill(t.cents, amountCents));

const billJson = (b: BillRow) => ({ id: b.id, name: b.name, cadence: b.cadence, amountCents: Math.abs(b.cents), status: b.status });

planning.get('/transactions/:id/bill', async (c) => {
  const db = c.env.DB;
  const viewerId = c.get('viewer').memberId;
  const txn = await visibleTxn(db, paramId(c), viewerId);
  if (txn.amountCents >= 0) return c.json({ bill: null, guess: null });
  const merchant = await billKey(db, txn.id);
  const bill = billFor(await billsUnder(db, merchant), txn);
  const charges = await similarCharges(db, merchant, txn.amountCents, viewerId, monthStart(addMonths(monthOf(c.get('today')), -25)));
  return c.json({
    bill: bill ? billJson(bill) : null,
    guess: {
      name: txn.merchantName ?? titleCase(merchant),
      cadence: guessCadence(charges.map((t) => t.date)),
      // Recent charges, so a bill that changes month to month gets a typical amount.
      amountCents: Math.abs(median(charges.slice(0, 6).map((t) => t.cents))) || Math.abs(txn.amountCents),
    },
  });
});

planning.put('/transactions/:id/bill', async (c) => {
  const db = c.env.DB;
  const viewerId = c.get('viewer').memberId;
  const txn = await visibleTxn(db, paramId(c), viewerId);
  if (txn.amountCents >= 0) throw badRequest('Only money going out can be a bill');
  const body = await readBody(c);
  const merchant = await billKey(db, txn.id);
  const bills = await billsUnder(db, merchant);
  const existing = billFor(bills, txn, optInt(body.billId, 'billId', { min: 1 }) ?? undefined);

  const isBill = optBool(body.isBill, 'isBill');
  if (isBill === undefined) throw badRequest('isBill is required');
  if (!isBill) {
    // Dismissed rather than deleted, so "Find them" doesn't suggest it again.
    if (existing) await run(db, `UPDATE recurring_bills SET status = 'dismissed', updated_at = ? WHERE id = ?`, nowIso(), existing.id);
    return c.json({ bill: null });
  }

  const cadence = oneOf(body.cadence, 'cadence', CADENCES) ?? existing?.cadence ?? 'monthly';
  const amount = reqInt(body.amountCents, 'amountCents', { min: 1 });
  const name = optStr(body.name, 'name', 80) ?? existing?.name ?? txn.merchantName ?? titleCase(merchant);
  const today = c.get('today');
  const [latest] = await similarCharges(db, merchant, txn.amountCents, viewerId, monthStart(addMonths(monthOf(today), -25)));
  const lastDate = latest && latest.date > txn.date ? latest.date : txn.date;

  // Keep the existing bill's key; a second bill from the same merchant gets "MERCHANT $9", as detection does.
  let key = existing?.merchant ?? merchant;
  if (bills.some((b) => b.id !== existing?.id && b.merchant === key && b.cadence === cadence)) key = `${merchant} $${Math.round(amount / 100)}`;
  const now = nowIso();
  await batchAll(db, [
    ...(existing && (existing.merchant !== key || existing.cadence !== cadence) ? [stmt(db, 'DELETE FROM recurring_bills WHERE id = ?', existing.id)] : []),
    stmt(
      db,
      `INSERT INTO recurring_bills (merchant, name, cadence, expected_amount_cents, last_date, next_date, category_id,
                                    account_id, status, private_member_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)
       ON CONFLICT (merchant, cadence) DO UPDATE SET name = excluded.name, expected_amount_cents = excluded.expected_amount_cents,
         last_date = excluded.last_date, next_date = excluded.next_date,
         category_id = COALESCE(excluded.category_id, recurring_bills.category_id), account_id = excluded.account_id,
         status = 'confirmed', private_member_id = excluded.private_member_id, updated_at = ?`,
      key,
      name,
      cadence,
      -amount,
      lastDate,
      nextOccurrence(lastDate, cadence),
      txn.categoryId,
      txn.accountId,
      txn.privateMemberId,
      now,
    ),
  ]);
  const saved = await first<BillRow>(
    db,
    `SELECT id, merchant, name, cadence, expected_amount_cents AS cents, status, private_member_id AS privateMemberId
       FROM recurring_bills WHERE merchant = ? AND cadence = ?`,
    key,
    cadence,
  );
  return c.json({ bill: saved ? billJson(saved) : null });
});

planning.patch('/recurring/:id', async (c) => {
  const db = c.env.DB;
  const id = paramId(c);
  const bill = await first(db, 'SELECT id FROM recurring_bills WHERE id = ? AND (private_member_id IS NULL OR private_member_id = ?)', id, c.get('viewer').memberId);
  if (!bill) throw notFound();
  const body = await readBody(c);
  const updates = new Updates()
    .set('status', oneOf(body.status, 'status', ['suggested', 'confirmed', 'dismissed'] as const))
    .set('name', optStr(body.name, 'name', 80) ?? undefined)
    .set('category_id', optInt(body.categoryId, 'categoryId', { min: 1 }))
    .set('expected_amount_cents', optInt(body.expectedAmountCents, 'expectedAmountCents'))
    .set('next_date', optDate(body.nextDate, 'nextDate'))
    .set('cadence', oneOf(body.cadence, 'cadence', ['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'] as const));
  if (updates.empty) throw badRequest('Nothing to update');
  await run(db, `UPDATE recurring_bills SET ${updates.sets.join(', ')}, updated_at = ? WHERE id = ?`, ...updates.params, nowIso(), id);
  return c.json({ ok: true });
});

// ───────────────────────── Goals ─────────────────────────

interface GoalRow {
  id: number;
  name: string;
  targetCents: number;
  targetDate: ISODate | null;
  categoryId: number | null;
  categoryName: string | null;
  startingSavedCents: number;
  sort: number;
  archived: number;
  createdAt: string;
}

async function goalsWithProgress(db: D1Database, today: ISODate, includeArchived = false) {
  const goals = await all<GoalRow>(
    db,
    `SELECT g.id, g.name, g.target_cents AS targetCents, g.target_date AS targetDate, g.category_id AS categoryId,
            c.name AS categoryName, g.starting_saved_cents AS startingSavedCents, g.sort, g.archived, g.created_at AS createdAt
       FROM goals g LEFT JOIN categories c ON c.id = g.category_id
      ${includeArchived ? '' : 'WHERE g.archived = 0'}
      ORDER BY g.archived, g.sort, g.id`,
  );
  if (!goals.length) return [];

  const currentMonth = monthOf(today);
  const months: MonthKey[] = [-3, -2, -1, 0].map((n) => addMonths(currentMonth, n));
  const from = goals.reduce((earliest, g) => minDate(earliest, g.createdAt.slice(0, 10)), monthStart(months[0] ?? currentMonth));
  const entries = ledgerEntries(await loadLedger(db, from, today));

  return goals.map((g) => {
    const mine = g.categoryId === null ? [] : entries.filter((e) => e.categoryId === g.categoryId);
    const flow = (list: typeof mine) => list.reduce((sum, e) => sum + (e.kind === 'income' ? e.amountCents : -e.amountCents), 0);
    const savedCents = g.startingSavedCents + flow(mine.filter((e) => e.date >= g.createdAt.slice(0, 10)));
    // Months before the goal existed don't count against it.
    const createdMonth = g.createdAt.slice(0, 7);
    const contributionsByMonth = months
      .filter((m) => m >= createdMonth)
      .map((m) => flow(mine.filter((e) => monthOf(e.date) === m)));
    return {
      ...g,
      archived: g.archived === 1,
      savedCents,
      contributionsByMonth,
      progress: goalProgress({ targetCents: g.targetCents, savedCents, targetDate: g.targetDate, contributionsByMonth }, today),
    };
  });
}

planning.get('/goals', async (c) => {
  return c.json(await goalsWithProgress(c.env.DB, c.get('today'), c.req.query('all') === '1'));
});

planning.post('/goals', async (c) => {
  const db = c.env.DB;
  const body = await readBody(c);
  const name = reqStr(body.name, 'name', 60);
  let categoryId = optInt(body.categoryId, 'categoryId', { min: 1 }) ?? null;
  if (categoryId === null) {
    // Give the goal its own savings category so money filed there counts toward it.
    const created = await first<{ id: number }>(
      db,
      `INSERT INTO categories (section_id, name, kind, sort)
       SELECT id, ?, 'savings', (SELECT COALESCE(MAX(sort), 0) + 10 FROM categories WHERE section_id = sections.id)
         FROM sections WHERE name = ?
       ON CONFLICT (section_id, name) DO UPDATE SET archived = 0
       RETURNING id`,
      name,
      GROUPS.saving,
    );
    categoryId = created?.id ?? null;
  }
  const row = await first(
    db,
    `INSERT INTO goals (name, target_cents, target_date, category_id, starting_saved_cents, sort)
     VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 10 FROM goals)) RETURNING id`,
    name,
    reqInt(body.targetCents, 'targetCents', { min: 1 }),
    optDate(body.targetDate, 'targetDate') ?? null,
    categoryId,
    optInt(body.startingSavedCents, 'startingSavedCents', { min: 0 }) ?? 0,
  );
  return c.json(row, 201);
});

planning.patch('/goals/:id', async (c) => {
  const id = paramId(c);
  const body = await readBody(c);
  const archived = optBool(body.archived, 'archived');
  const updates = new Updates()
    .set('name', optStr(body.name, 'name', 60) ?? undefined)
    .set('target_cents', optInt(body.targetCents, 'targetCents', { min: 1 }) ?? undefined)
    .set('target_date', optDate(body.targetDate, 'targetDate'))
    .set('category_id', optInt(body.categoryId, 'categoryId', { min: 1 }))
    .set('starting_saved_cents', optInt(body.startingSavedCents, 'startingSavedCents', { min: 0 }) ?? undefined)
    .set('archived', archived === undefined ? undefined : archived ? 1 : 0);
  if (updates.empty) throw badRequest('Nothing to update');
  const result = await run(c.env.DB, `UPDATE goals SET ${updates.sets.join(', ')}, updated_at = ? WHERE id = ?`, ...updates.params, nowIso(), id);
  if (!result.meta.changes) throw notFound();
  return c.json({ ok: true });
});

// ───────────────────────── Debts ─────────────────────────

interface DebtRow {
  id: number;
  name: string;
  accountId: number | null;
  accountName: string | null;
  balanceCents: number;
  aprPercent: number;
  minPaymentCents: number;
  dueDay: number | null;
  source: 'manual' | 'plaid';
  updatedAt: string;
}

const DEBT_SELECT = `SELECT d.id, d.name, d.account_id AS accountId, a.name AS accountName, d.balance_cents AS balanceCents,
  d.apr_percent AS aprPercent, d.min_payment_cents AS minPaymentCents, d.due_day AS dueDay, d.source, d.updated_at AS updatedAt
  FROM debts d LEFT JOIN accounts a ON a.id = d.account_id WHERE d.archived = 0`;

planning.get('/debts', async (c) => {
  return c.json(await all<DebtRow>(c.env.DB, `${DEBT_SELECT} ORDER BY d.balance_cents`));
});

planning.get('/debts/plan', async (c) => {
  const extra = Math.max(0, Number(c.req.query('extra')) || 0);
  const debts = (await all<DebtRow>(c.env.DB, DEBT_SELECT)).filter((d) => d.balanceCents > 0);
  const inputs = debts.map((d) => ({ id: d.id, name: d.name, balanceCents: d.balanceCents, aprPercent: d.aprPercent, minPaymentCents: d.minPaymentCents }));
  return c.json({
    extraCents: Math.round(extra),
    snowball: planPayoff(inputs, 'snowball', Math.round(extra)),
    avalanche: planPayoff(inputs, 'avalanche', Math.round(extra)),
  });
});

planning.post('/debts', async (c) => {
  const body = await readBody(c);
  const row = await first(
    c.env.DB,
    `INSERT INTO debts (name, account_id, balance_cents, apr_percent, min_payment_cents, due_day)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    reqStr(body.name, 'name', 60),
    optInt(body.accountId, 'accountId', { min: 1 }) ?? null,
    reqInt(body.balanceCents, 'balanceCents', { min: 0 }),
    optNumber(body.aprPercent, 'aprPercent', { min: 0, max: 100 }) ?? 0,
    optInt(body.minPaymentCents, 'minPaymentCents', { min: 0 }) ?? 0,
    optInt(body.dueDay, 'dueDay', { min: 1, max: 31 }) ?? null,
  );
  return c.json(row, 201);
});

planning.patch('/debts/:id', async (c) => {
  const id = paramId(c);
  const body = await readBody(c);
  const archived = optBool(body.archived, 'archived');
  const updates = new Updates()
    .set('name', optStr(body.name, 'name', 60) ?? undefined)
    .set('balance_cents', optInt(body.balanceCents, 'balanceCents', { min: 0 }) ?? undefined)
    .set('apr_percent', optNumber(body.aprPercent, 'aprPercent', { min: 0, max: 100 }) ?? undefined)
    .set('min_payment_cents', optInt(body.minPaymentCents, 'minPaymentCents', { min: 0 }) ?? undefined)
    .set('due_day', optInt(body.dueDay, 'dueDay', { min: 1, max: 31 }))
    .set('archived', archived === undefined ? undefined : archived ? 1 : 0);
  if (updates.empty) throw badRequest('Nothing to update');
  const result = await run(c.env.DB, `UPDATE debts SET ${updates.sets.join(', ')}, updated_at = ? WHERE id = ?`, ...updates.params, nowIso(), id);
  if (!result.meta.changes) throw notFound();
  return c.json({ ok: true });
});

// ───────────────────────── Kids ─────────────────────────

planning.get('/kids/report', async (c) => {
  const db = c.env.DB;
  const today = c.get('today');
  const viewer = c.get('viewer');
  const from = c.req.query('from') ? reqDate(c.req.query('from'), 'from') : monthStart(monthOf(today));
  const to = c.req.query('to') ? reqDate(c.req.query('to'), 'to') : monthEnd(monthOf(today));

  const [kids, categories, budgets] = await Promise.all([
    all<{ id: number; name: string; color: string }>(db, 'SELECT id, name, color FROM kids WHERE archived = 0 ORDER BY sort, id'),
    loadCategories(db),
    monthOf(from) === monthOf(to)
      ? all<{ kidId: number; categoryId: number; budgetCents: number }>(
          db,
          'SELECT kid_id AS kidId, category_id AS categoryId, budget_cents AS budgetCents FROM kid_budgets WHERE month = ?',
          monthOf(from),
        )
      : Promise.resolve([]),
  ]);
  const categoryById = new Map(categories.map((cat) => [cat.id, cat]));
  const entries = ledgerEntries(await loadLedger(db, from, to)).filter(
    (e) => e.kind !== 'income' && (e.privateMemberId === null || e.privateMemberId === viewer.memberId),
  );

  const report = kids.map((kid) => {
    const mine = entries.filter((e) => e.kidId === kid.id);
    const byCategory = new Map<number | null, number>();
    for (const e of mine) byCategory.set(e.categoryId, (byCategory.get(e.categoryId) ?? 0) - e.amountCents);
    const kidBudgets = budgets.filter((b) => b.kidId === kid.id);
    return {
      ...kid,
      totalCents: mine.reduce((sum, e) => sum - e.amountCents, 0),
      budgetCents: kidBudgets.reduce((sum, b) => sum + b.budgetCents, 0),
      byCategory: [...byCategory.entries()]
        .map(([categoryId, cents]) => ({
          categoryId,
          name: categoryId === null ? 'Uncategorized' : (categoryById.get(categoryId)?.name ?? 'Unknown'),
          cents,
          budgetCents: kidBudgets.find((b) => b.categoryId === categoryId)?.budgetCents ?? 0,
        }))
        .sort((a, b) => b.cents - a.cents),
    };
  });

  const untagged = entries.filter((e) => e.kidId === null && e.categoryId !== null && categoryById.get(e.categoryId)?.kidScoped === 1);
  return c.json({
    from,
    to,
    kids: report,
    untaggedCents: untagged.reduce((sum, e) => sum - e.amountCents, 0),
    untaggedCount: new Set(untagged.map((e) => e.txnId)).size,
    budgets,
  });
});

planning.put('/kids/budgets', async (c) => {
  const body = await readBody(c);
  await run(
    c.env.DB,
    `INSERT INTO kid_budgets (kid_id, category_id, month, budget_cents) VALUES (?, ?, ?, ?)
     ON CONFLICT (kid_id, category_id, month) DO UPDATE SET budget_cents = excluded.budget_cents`,
    reqInt(body.kidId, 'kidId', { min: 1 }),
    reqInt(body.categoryId, 'categoryId', { min: 1 }),
    reqMonth(body.month),
    reqInt(body.budgetCents, 'budgetCents', { min: 0 }),
  );
  return c.json({ ok: true });
});

/** A year of childcare and medical costs for one kid, for taxes (dependent care FSA, credits, HSA). */
planning.get('/kids/:id/tax-summary.csv', async (c) => {
  const db = c.env.DB;
  const kidId = paramId(c);
  const year = Number(c.req.query('year')) || Number(c.get('today').slice(0, 4));
  const kid = await first<{ name: string }>(db, 'SELECT name FROM kids WHERE id = ?', kidId);
  if (!kid) throw notFound();
  const rows = await all<{ date: string; name: string; category: string; amountCents: number; notes: string | null }>(
    db,
    `SELECT t.date, COALESCE(t.merchant_name, t.name) AS name, c.name AS category,
            COALESCE(s.amount_cents, t.amount_cents) AS amountCents, t.notes
       FROM transactions t
       LEFT JOIN splits s ON s.transaction_id = t.id AND t.is_split = 1
       JOIN categories c ON c.id = COALESCE(s.category_id, t.category_id)
      WHERE t.deleted_at IS NULL AND t.is_ignored = 0 AND t.date BETWEEN ? AND ?
        AND COALESCE(s.kid_id, t.kid_id) = ?
        AND c.name IN ('Childcare', 'Kids Medical', 'Medical & Prescriptions')
        AND (t.private_member_id IS NULL OR t.private_member_id = ?)
      ORDER BY t.date`,
    `${year}-01-01`,
    `${year}-12-31`,
    kidId,
    c.get('viewer').memberId,
  );
  const total = rows.reduce((sum, r) => sum - r.amountCents, 0);
  const csv = toCsv([
    ['Date', 'Description', 'Category', 'Amount', 'Notes'],
    ...rows.map((r) => [r.date, r.name, r.category, (-r.amountCents / 100).toFixed(2), r.notes ?? '']),
    ['', 'Total', '', (total / 100).toFixed(2), ''],
  ]);
  return c.body(csv, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${kid.name.replace(/[^\w-]+/g, '_')}-${year}-tax-summary.csv"`,
  });
});

// ───────────────────────── Fun money ─────────────────────────

planning.get('/fun', async (c) => {
  const db = c.env.DB;
  const viewer = c.get('viewer');
  const household = c.get('household');
  const today = c.get('today');
  const balances = await funMoneyBalances(db, household, today, viewer.memberId);
  const recent = await all(
    db,
    `SELECT t.id, t.date, COALESCE(t.merchant_name, t.name) AS name, t.amount_cents AS amountCents
       FROM transactions t
      WHERE t.deleted_at IS NULL AND t.is_ignored = 0 AND t.private_member_id = ? AND t.date >= ?
      ORDER BY t.date DESC, t.id DESC LIMIT 50`,
    viewer.memberId,
    household.funMoneyStartDate ?? monthStart(monthOf(today)),
  );
  return c.json({
    startDate: household.funMoneyStartDate ?? monthStart(monthOf(today)),
    balances: balances.map((b) =>
      b.isViewer ? b : { memberId: b.memberId, name: b.name, color: b.color, balanceCents: b.balanceCents, allowancePerPaydayCents: b.allowancePerPaydayCents, isViewer: false },
    ),
    recent,
  });
});

planning.post('/fun/adjustments', async (c) => {
  const body = await readBody(c);
  const memberId = c.get('viewer').memberId;
  const amountCents = reqInt(body.amountCents, 'amountCents');
  if (amountCents === 0) throw badRequest('Amount can’t be zero');
  await run(
    c.env.DB,
    'INSERT INTO fun_adjustments (member_id, amount_cents, date, note) VALUES (?, ?, ?, ?)',
    memberId,
    amountCents,
    c.get('today'),
    optStr(body.note, 'note', 200) ?? null,
  );
  return c.json({ ok: true }, 201);
});

// ───────────────────────── Monthly check-in ─────────────────────────

interface CheckinRow {
  id: number;
  month: MonthKey;
  status: 'draft' | 'agreed' | 'complete';
  step: number;
  notes: string | null;
  itemsJson: string;
  snapshotJson: string | null;
  agreedByJson: string;
  completedAt: string | null;
  updatedAt: string;
}

const CHECKIN_SELECT = `SELECT id, month, status, step, notes, items_json AS itemsJson, snapshot_json AS snapshotJson,
  agreed_by_json AS agreedByJson, completed_at AS completedAt, updated_at AS updatedAt FROM checkins`;

function checkinToApi(row: CheckinRow) {
  return {
    id: row.id,
    month: row.month,
    status: row.status,
    step: row.step,
    notes: row.notes,
    items: JSON.parse(row.itemsJson) as Record<string, unknown>,
    agreedBy: JSON.parse(row.agreedByJson) as number[],
    completedAt: row.completedAt,
    updatedAt: row.updatedAt,
  };
}

async function loadCheckin(db: D1Database, month: MonthKey): Promise<CheckinRow> {
  await run(db, 'INSERT OR IGNORE INTO checkins (month) VALUES (?)', month);
  const row = await first<CheckinRow>(db, `${CHECKIN_SELECT} WHERE month = ?`, month);
  if (!row) throw new Error('Could not load check-in');
  return row;
}

/** viewerId null: shared data only, for the snapshot both of you see once the check-in is finished. */
async function checkinData(db: D1Database, month: MonthKey, today: ISODate, viewerId: number | null) {
  const data = await loadMonth(db, month);
  const lines: CheckinLine[] = data.rows
    // Top-level rows only: a parent's row already holds its sub-categories' money.
    .filter((r) => r.parentId === null && r.kind !== 'transfer' && (r.budgetCents > 0 || r.actualCents > 0))
    .map((r) => ({
      categoryId: r.categoryId,
      name: r.name,
      section: r.sectionName,
      kind: r.kind === 'income' ? 'income' : 'expense',
      budgetCents: r.budgetCents,
      actualCents: r.actualCents,
      ...(r.plannedCostsCents ? { plannedCostsCents: r.plannedCostsCents } : {}),
    }));
  if (data.uncategorized.outCents > 0) {
    lines.push({ categoryId: -1, name: 'Not categorized yet', section: '', kind: 'expense', budgetCents: 0, actualCents: data.uncategorized.outCents });
  }

  const nextMonth = addMonths(month, 1);
  const [goals, nextLines, bigRecurring] = await Promise.all([
    goalsWithProgress(db, today),
    all<{ name: string; budgetCents: number; dueDay: number | null; timing: string }>(
      db,
      `SELECT c.name, b.budget_cents AS budgetCents, b.due_day AS dueDay, b.timing
         FROM budget_lines b JOIN categories c ON c.id = b.category_id WHERE b.month = ?`,
      nextMonth,
    ),
    all<{ name: string; nextDate: string; amountCents: number; cadence: string }>(
      db,
      `SELECT name, next_date AS nextDate, expected_amount_cents AS amountCents, cadence FROM recurring_bills
        WHERE status = 'confirmed' AND cadence IN ('quarterly', 'yearly') AND next_date BETWEEN ? AND ?
          AND (private_member_id IS NULL OR private_member_id = ?)`,
      monthStart(nextMonth),
      monthEnd(nextMonth),
      viewerId,
    ),
  ]);

  const upcoming = [
    ...(nextLines.length ? nextLines : data.rows.filter((r) => r.lineId !== null).map((r) => ({ name: r.name, budgetCents: r.budgetCents, dueDay: r.dueDay, timing: r.timing })))
      .filter((l) => l.timing === 'due_day' && l.budgetCents >= 20000)
      .map((l) => ({ name: l.name, amountCents: l.budgetCents, when: l.dueDay ? `${nextMonth}-${String(l.dueDay).padStart(2, '0')}` : nextMonth, kind: 'bill' })),
    ...bigRecurring.map((r) => ({ name: r.name, amountCents: Math.abs(r.amountCents), when: r.nextDate, kind: r.cadence })),
  ].sort((a, b) => b.amountCents - a.amountCents);

  return { summary: summarizeMonth(lines), lines, goals, upcoming, nextMonth, nextMonthHasBudget: nextLines.length > 0 };
}

planning.get('/checkins/:month', async (c) => {
  const db = c.env.DB;
  const month = reqMonth(c.req.param('month'));
  const [row, members] = await Promise.all([
    loadCheckin(db, month),
    all<{ id: number; name: string; color: string }>(db, 'SELECT id, name, color FROM members ORDER BY id'),
  ]);
  if (row.status === 'complete' && row.snapshotJson) {
    return c.json({ checkin: checkinToApi(row), members, frozen: true, ...JSON.parse(row.snapshotJson) });
  }
  const data = await checkinData(db, month, c.get('today'), c.get('viewer').memberId);
  return c.json({ checkin: checkinToApi(row), members, frozen: false, ...data });
});

function sanitizeDecisions(value: unknown): Record<string, OverspendDecision> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, OverspendDecision> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d+$/.test(key) || !raw || typeof raw !== 'object') continue;
    const d = raw as Record<string, unknown>;
    const cents = optInt(d.newBudgetCents, 'newBudgetCents', { min: 0 }) ?? undefined;
    if (d.kind === 'keep') out[key] = { kind: 'keep' };
    else if (d.kind === 'raise') out[key] = cents === undefined ? { kind: 'raise' } : { kind: 'raise', newBudgetCents: cents };
    else if (d.kind === 'set' && cents !== undefined) out[key] = { kind: 'set', newBudgetCents: cents };
  }
  return out;
}

planning.patch('/checkins/:month', async (c) => {
  const db = c.env.DB;
  const month = reqMonth(c.req.param('month'));
  const row = await loadCheckin(db, month);
  if (row.status === 'complete') throw new HttpError(409, 'This check-in is already finished.');
  const body = await readBody(c);

  const updates = new Updates()
    .set('step', optInt(body.step, 'step', { min: 0, max: 20 }) ?? undefined)
    .set('notes', optStr(body.notes, 'notes', 5000));
  if (body.items !== undefined) {
    if (!body.items || typeof body.items !== 'object') throw badRequest('items must be an object');
    const items = { ...(body.items as Record<string, unknown>), decisions: sanitizeDecisions((body.items as Record<string, unknown>).decisions) };
    const json = JSON.stringify(items);
    if (json.length > 20_000) throw badRequest('Check-in notes are too long');
    if (json !== row.itemsJson) {
      // Changing what was agreed means you both agree again.
      updates.set('items_json', json).set('agreed_by_json', '[]').set('status', 'draft');
    }
  }
  if (updates.empty) return c.json(checkinToApi(row));
  await run(db, `UPDATE checkins SET ${updates.sets.join(', ')}, updated_at = ? WHERE id = ?`, ...updates.params, nowIso(), row.id);
  return c.json(checkinToApi(await loadCheckin(db, month)));
});

planning.post('/checkins/:month/agree', async (c) => {
  const db = c.env.DB;
  const month = reqMonth(c.req.param('month'));
  const row = await loadCheckin(db, month);
  if (row.status === 'complete') throw new HttpError(409, 'This check-in is already finished.');
  const agreed = new Set(JSON.parse(row.agreedByJson) as number[]);
  if (optBool((await readBody(c)).agree, 'agree') === false) agreed.delete(c.get('viewer').memberId);
  else agreed.add(c.get('viewer').memberId);
  const memberCount = (await first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM members'))?.n ?? 1;
  await run(
    db,
    'UPDATE checkins SET agreed_by_json = ?, status = ?, updated_at = ? WHERE id = ?',
    JSON.stringify([...agreed]),
    agreed.size >= memberCount ? 'agreed' : 'draft',
    nowIso(),
    row.id,
  );
  return c.json(checkinToApi(await loadCheckin(db, month)));
});

planning.post('/checkins/:month/complete', async (c) => {
  const db = c.env.DB;
  const month = reqMonth(c.req.param('month'));
  const viewer = c.get('viewer');
  const row = await loadCheckin(db, month);
  if (row.status === 'complete') throw new HttpError(409, 'This check-in is already finished.');
  if (row.status !== 'agreed') throw new HttpError(409, 'You both need to tap Agree first.');

  const data = await checkinData(db, month, c.get('today'), null);
  const decisions = sanitizeDecisions((JSON.parse(row.itemsJson) as Record<string, unknown>).decisions);
  const nextMonth = data.nextMonth;
  const now = nowIso();

  const statements: D1PreparedStatement[] = [];
  if (!data.nextMonthHasBudget) {
    statements.push(
      stmt(
        db,
        `INSERT OR IGNORE INTO budget_lines (month, category_id, budget_cents, timing, due_day, notes, updated_by_member_id)
         SELECT ?, category_id, budget_cents, timing, due_day, notes, ? FROM budget_lines WHERE month = ?`,
        nextMonth,
        viewer.memberId,
        month,
      ),
    );
  }
  const changed = draftNextBudget(
    data.lines.filter((l) => l.categoryId > 0 && decisions[String(l.categoryId)]),
    decisions as Record<number, OverspendDecision>,
  );
  const plannedByCategory = new Map(data.lines.map((l) => [l.categoryId, l.plannedCostsCents ?? 0]));
  for (const line of changed) {
    // Decisions are about the whole line; the typed line is that minus the planned-cost set-asides.
    const handCents = Math.max(0, line.budgetCents - (plannedByCategory.get(line.categoryId) ?? 0));
    statements.push(
      stmt(
        db,
        `INSERT INTO budget_lines (month, category_id, budget_cents, updated_by_member_id) VALUES (?, ?, ?, ?)
         ON CONFLICT (month, category_id) DO UPDATE SET budget_cents = excluded.budget_cents,
           updated_by_member_id = excluded.updated_by_member_id, updated_at = ?`,
        nextMonth,
        line.categoryId,
        handCents,
        viewer.memberId,
        now,
      ),
    );
  }
  statements.push(
    stmt(
      db,
      `UPDATE checkins SET status = 'complete', snapshot_json = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
      JSON.stringify({ ...data, nextMonthHasBudget: true }),
      now,
      now,
      row.id,
    ),
  );
  await batchAll(db, statements);
  return c.json({ ok: true, budgetChanges: changed.length });
});
