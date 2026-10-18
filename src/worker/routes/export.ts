import { Hono } from 'hono';
import { toCsv } from '../../shared/import/csv';
import { PRIVACY_SQL } from '../../shared/privacy';
import type { AppEnv } from '../env';
import { all } from '../lib/db';

/**
 * Your data, in open formats. JSON holds everything except transactions, which are
 * exported per year as CSV (keeps each request small).
 */
export const exportRoutes = new Hono<AppEnv>();

const attachment = (filename: string) => ({ 'Content-Disposition': `attachment; filename="${filename}"` });

exportRoutes.get('/export/years', async (c) => {
  const rows = await all<{ year: string; n: number }>(
    c.env.DB,
    `SELECT substr(t.date, 1, 4) AS year, COUNT(*) AS n FROM transactions t
      WHERE t.deleted_at IS NULL AND ${PRIVACY_SQL} GROUP BY year ORDER BY year DESC`,
    c.get('viewer').memberId,
  );
  return c.json(rows);
});

exportRoutes.get('/export/json', async (c) => {
  const db = c.env.DB;
  const viewerId = c.get('viewer').memberId;
  const q = (sql: string, ...params: (string | number)[]) => all<Record<string, unknown>>(db, sql, ...params);
  const [household, members, kids, sections, categories, accounts, budgetLines, kidBudgets, incomeSources, rules, recurring, goals, debts, checkins, funAdjustments, monthSettings, plannedCosts, plannedCostAmounts, plannedCostCategories] =
    await Promise.all([
      q('SELECT * FROM household'),
      q('SELECT id, email, name, color, fun_allowance_cents, default_private_account_id FROM members'),
      q('SELECT * FROM kids'),
      q('SELECT * FROM sections'),
      q('SELECT * FROM categories'),
      q(`SELECT id, name, institution, mask, type, is_cash, current_balance_cents, available_balance_cents,
                credit_limit_cents, balance_updated_at, owner_member_id, hidden FROM accounts`),
      q('SELECT * FROM budget_lines ORDER BY month, category_id'),
      q('SELECT * FROM kid_budgets'),
      q('SELECT * FROM income_sources'),
      q('SELECT * FROM rules WHERE owner_member_id IS NULL OR owner_member_id = ? ORDER BY position', viewerId),
      q('SELECT * FROM recurring_bills WHERE private_member_id IS NULL OR private_member_id = ?', viewerId),
      q('SELECT * FROM goals'),
      q('SELECT * FROM debts'),
      q('SELECT id, month, status, notes, items_json, snapshot_json, agreed_by_json, completed_at FROM checkins'),
      q('SELECT * FROM fun_adjustments WHERE member_id = ?', viewerId),
      q('SELECT * FROM month_settings'),
      q('SELECT * FROM planned_costs ORDER BY sort, id'),
      q('SELECT * FROM planned_cost_amounts ORDER BY planned_cost_id, month'),
      q('SELECT * FROM planned_cost_categories ORDER BY planned_cost_id, category_id'),
    ]);
  const body = JSON.stringify({
    exportedAt: new Date().toISOString(),
    note: 'Transactions are exported separately as CSV, one file per year.',
    household: household[0] ?? null,
    members,
    kids,
    sections,
    categories,
    accounts,
    budgetLines,
    kidBudgets,
    incomeSources,
    rules,
    recurringBills: recurring,
    goals,
    debts,
    checkins,
    funAdjustments,
    monthSettings,
    plannedCosts,
    plannedCostAmounts,
    plannedCostCategories,
  });
  return c.body(body, 200, { 'Content-Type': 'application/json', ...attachment(`family-budget-${c.get('today')}.json`) });
});

exportRoutes.get('/export/transactions.csv', async (c) => {
  const year = /^\d{4}$/.test(c.req.query('year') ?? '') ? (c.req.query('year') as string) : c.get('today').slice(0, 4);
  const rows = await all<Record<string, string | number | null>>(
    c.env.DB,
    `SELECT t.id, t.date, a.name AS account, t.name, t.merchant_name AS merchant, t.amount_cents AS amountCents,
            c.name AS category, s2.name AS section, k.name AS kid, t.notes, t.private_member_id AS privateMemberId,
            t.is_ignored AS ignored, t.transfer_pair_id AS transferPairId, t.pending, t.source,
            (SELECT group_concat(COALESCE(sc.name, 'Uncategorized') || ' ' || printf('%.2f', sp.amount_cents / 100.0), '; ')
               FROM splits sp LEFT JOIN categories sc ON sc.id = sp.category_id WHERE sp.transaction_id = t.id) AS splits
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN sections s2 ON s2.id = c.section_id
       LEFT JOIN kids k ON k.id = t.kid_id
      WHERE t.deleted_at IS NULL AND t.date BETWEEN ? AND ? AND ${PRIVACY_SQL}
      ORDER BY t.date, t.id`,
    `${year}-01-01`,
    `${year}-12-31`,
    c.get('viewer').memberId,
  );
  const csv = toCsv([
    ['Date', 'Account', 'Description', 'Merchant', 'Amount', 'Category', 'Section', 'Kid', 'Notes', 'Private', 'Ignored', 'Transfer', 'Pending', 'Source', 'Splits', 'ID'],
    ...rows.map((r) => [
      r.date,
      r.account,
      r.name,
      r.merchant,
      ((r.amountCents as number) / 100).toFixed(2),
      r.category,
      r.section,
      r.kid,
      r.notes,
      r.privateMemberId ? 'yes' : '',
      r.ignored ? 'yes' : '',
      r.transferPairId ? 'yes' : '',
      r.pending ? 'yes' : '',
      r.source,
      r.splits,
      r.id,
    ]),
  ]);
  return c.body(`﻿${csv}`, 200, { 'Content-Type': 'text/csv; charset=utf-8', ...attachment(`transactions-${year}.csv`) });
});
