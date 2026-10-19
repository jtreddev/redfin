import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonthsAhead, MonthsAheadInput } from '../src/shared/monthsAhead';
import { planAhead, type AheadInput, type AheadPlan } from '../src/shared/planAhead';
import type { ProjectionInput } from '../src/shared/projection';
import type { Env } from '../src/worker/env';
import { api } from './helpers/api';
import { TestD1 } from './helpers/d1';
import { testEnv } from './helpers/plaid';

const YOU = 'you@example.com';
const PARTNER = 'partner@example.com';

interface DebtBody {
  id: number;
  name: string;
  kind: string;
  accountId: number | null;
  source: string;
  balanceCents: number;
  aprPercent: number;
  minPaymentCents: number;
  minEstimated: boolean;
  paidInFull: boolean;
  billId: number | null;
  billName: string | null;
  categoryId: number | null;
  extraCents: number;
  suggestedBillId: number | null;
  balanceAsOf: string | null;
}

interface AheadBody {
  today: string;
  input: AheadInput;
  saved: AheadPlan;
  surprise: { suggestedCents: number; savedCents: number | null };
  debts: DebtBody[];
  goals: { id: number; name: string; monthlyCents: number | null }[];
  items: { id: number; name: string; amountCents: number; month: string; repeat: string; endMonth: string | null }[];
}

describe('Plan › Ahead API', () => {
  let db: TestD1;
  let env: Env;
  let partner: number;
  const category = (section: string, extra = '') =>
    db.rows<{ id: number }>(`SELECT c.id FROM categories c JOIN sections s ON s.id = c.section_id WHERE s.name = ? ${extra} ORDER BY c.id LIMIT 1`, section)[0]!.id;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T16:00:00Z'));
    db = new TestD1();
    env = testEnv(db);
    await api(env, 'GET', '/me', undefined, YOU);
    await api(env, 'GET', '/me', undefined, PARTNER);
    const member = (email: string) => db.rows<{ id: number }>('SELECT id FROM members WHERE email = ?', email)[0]!.id;
    partner = member(PARTNER);
    db.exec(`INSERT INTO accounts (id, name, type, current_balance_cents) VALUES (1, 'Checking', 'checking', 300000)`);
    db.exec("INSERT INTO income_sources (name, net_pay_cents, frequency, anchor_date) VALUES ('Paycheck', 500000, 'monthly', '2026-09-23')");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function charge(accountId: number, date: string, cents: number, extra: Record<string, unknown> = {}) {
    const cols = ['account_id', 'date', 'amount_cents', 'name', 'source', ...Object.keys(extra)];
    db.exec(
      `INSERT INTO transactions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      accountId,
      date,
      cents,
      (extra.name as string) ?? `CHARGE ${date}`,
      'plaid',
      ...(Object.values(extra) as (string | number | null)[]),
    );
  }

  function bill(name: string, nextDate: string, cents: number, opts: { privateMemberId?: number | null; categoryId?: number | null } = {}) {
    db.exec(
      `INSERT INTO recurring_bills (merchant, name, cadence, expected_amount_cents, next_date, status, private_member_id, category_id)
       VALUES (?, ?, 'monthly', ?, ?, 'confirmed', ?, ?)`,
      name.toLowerCase(),
      name,
      -cents,
      nextDate,
      opts.privateMemberId ?? null,
      opts.categoryId ?? null,
    );
    return db.rows<{ id: number }>('SELECT id FROM recurring_bills WHERE name = ?', name)[0]!.id;
  }

  const ahead = async (email = YOU) => {
    const res = await api(env, 'GET', '/ahead', undefined, email);
    expect(res.status).toBe(200);
    return (await res.json()) as AheadBody;
  };
  const debtRows = () =>
    db.rows<{ name: string; account_id: number | null; source: string; kind: string; balance_cents: number; min_payment_cents: number; min_estimated: number; paid_in_full: number }>(
      'SELECT name, account_id, source, kind, balance_cents, min_payment_cents, min_estimated, paid_in_full FROM debts ORDER BY id',
    );

  describe('auto-link', () => {
    beforeEach(() => {
      db.exec(`INSERT INTO accounts (id, name, type, current_balance_cents) VALUES (2, 'Rewards Card', 'credit', 300000)`);
      db.exec(`INSERT INTO accounts (id, name, type, current_balance_cents) VALUES (3, 'Car Loan', 'loan', 1200000)`);
      // Money the bank owes you isn't debt.
      db.exec(`INSERT INTO accounts (id, name, type, current_balance_cents) VALUES (4, 'Overpaid Card', 'credit', -4250)`);
      db.exec("INSERT INTO debts (name, balance_cents, apr_percent, min_payment_cents) VALUES ('car loan', 1000000, 6, 35000)");
    });

    it('links every card and loan once, by name or a new debt, with the balance from the account', async () => {
      await ahead();
      const rows = debtRows();
      expect(rows).toEqual([
        // Matched by name: keeps its rate and minimum, takes the account's balance.
        { name: 'car loan', account_id: 3, source: 'manual', kind: 'other', balance_cents: 1200000, min_payment_cents: 35000, min_estimated: 0, paid_in_full: 0 },
        // New: 1% of 300,000 = 3,000 (no rate yet), marked estimated.
        { name: 'Rewards Card', account_id: 2, source: 'plaid', kind: 'credit_card', balance_cents: 300000, min_payment_cents: 3000, min_estimated: 1, paid_in_full: 0 },
        { name: 'Overpaid Card', account_id: 4, source: 'plaid', kind: 'credit_card', balance_cents: 0, min_payment_cents: 0, min_estimated: 1, paid_in_full: 0 },
      ]);
      // Twice in a row, and two at once: still one debt per account.
      await ahead();
      await Promise.all([ahead(), ahead(), api(env, 'GET', '/debts')]);
      expect(debtRows()).toEqual(rows);
    });

    it('links once when the first loads come in together', async () => {
      await Promise.all([ahead(), ahead(), api(env, 'GET', '/debts'), ahead(PARTNER)]);
      expect(debtRows().map((r) => [r.name, r.account_id])).toEqual([
        ['car loan', 3],
        ['Rewards Card', 2],
        ['Overpaid Card', 4],
      ]);
    });

    it('keeps an archived linked debt archived, and follows the balance and the estimate', async () => {
      await ahead();
      db.exec('UPDATE debts SET archived = 1 WHERE account_id = 3');
      db.exec('UPDATE accounts SET current_balance_cents = 500000 WHERE id = 2');
      const body = await ahead();
      expect(debtRows()).toHaveLength(3);
      expect(body.debts.map((d) => d.name)).toEqual(['Rewards Card', 'Overpaid Card']);
      const card = body.debts[0]!;
      expect(card).toMatchObject({ balanceCents: 500000, minPaymentCents: 5000, minEstimated: true, aprPercent: 0 });

      // A rate changes the estimate; a typed minimum stops it.
      expect((await api(env, 'PATCH', `/debts/${card.id}`, { aprPercent: 24 })).status).toBe(200);
      expect((await ahead()).debts[0]).toMatchObject({ minPaymentCents: 5000 + 10000, minEstimated: true });
      expect((await api(env, 'PATCH', `/debts/${card.id}`, { minPaymentCents: 12000 })).status).toBe(200);
      db.exec('UPDATE accounts SET current_balance_cents = 900000 WHERE id = 2');
      expect((await ahead()).debts[0]).toMatchObject({ balanceCents: 900000, minPaymentCents: 12000, minEstimated: false });
      // The balance comes from the account while it's linked.
      expect((await api(env, 'PATCH', `/debts/${card.id}`, { balanceCents: 1 })).status).toBe(400);
    });

    it('marks a card paid in full when each of the last 3 months’ payments cleared it', async () => {
      db.exec(`INSERT INTO accounts (id, name, type, current_balance_cents) VALUES (5, 'Clear Card', 'credit', 42000)`);
      // Each month's charges, paid off the month after.
      const charged = { '2026-06': 40000, '2026-07': 30000, '2026-08': 45000, '2026-09': 42000 };
      for (const [month, cents] of Object.entries(charged)) charge(5, `${month}-10`, -cents);
      charge(5, '2026-07-20', 40000);
      charge(5, '2026-08-20', 30000);
      charge(5, '2026-09-20', 45000);
      // The rewards card is paid only partly.
      for (const month of Object.keys(charged)) {
        charge(2, `${month}-10`, -50000);
        charge(2, `${month}-20`, 20000);
      }
      const body = await ahead();
      expect(body.debts.map((d) => [d.name, d.paidInFull])).toEqual([
        ['car loan', false],
        ['Rewards Card', false],
        ['Overpaid Card', false],
        ['Clear Card', true],
      ]);
      expect(body.input.debts.find((d) => d.name === 'Clear Card')?.paidInFull).toBe(true);
      // Out of payoff and the debt total.
      expect(planAhead(body.input, body.saved).debts.map((d) => d.name)).not.toContain('Clear Card');
      // Detection ran once; the toggle wins after.
      const id = body.debts.find((d) => d.name === 'Clear Card')!.id;
      expect((await api(env, 'PATCH', `/debts/${id}`, { paidInFull: false })).status).toBe(200);
      expect((await ahead()).debts.find((d) => d.name === 'Clear Card')?.paidInFull).toBe(false);
    });
  });

  describe('paid in full for debts linked before Plan › Ahead', () => {
    beforeEach(() => {
      db.exec(`INSERT INTO accounts (id, name, type, current_balance_cents) VALUES (5, 'Clear Card', 'credit', 42000)`);
      // Cleared each month: charges, paid off the month after.
      const charged = { '2026-06': 40000, '2026-07': 30000, '2026-08': 45000, '2026-09': 42000 };
      for (const [month, cents] of Object.entries(charged)) charge(5, `${month}-10`, -cents);
      charge(5, '2026-07-20', 40000);
      charge(5, '2026-08-20', 30000);
      charge(5, '2026-09-20', 45000);
      // Linked by an earlier sync, never checked.
      db.exec("INSERT INTO debts (name, account_id, balance_cents, min_payment_cents, source) VALUES ('Clear Card', 5, 42000, 2500, 'plaid')");
    });
    const row = () => db.rows('SELECT paid_in_full, paid_in_full_checked FROM debts WHERE account_id = 5');

    it('checks a linked card once on first load', async () => {
      await ahead();
      expect(row()).toEqual([{ paid_in_full: 1, paid_in_full_checked: 1 }]);
      // Checked: the user's toggle stands after.
      const id = db.rows<{ id: number }>('SELECT id FROM debts WHERE account_id = 5')[0]!.id;
      db.exec('UPDATE debts SET paid_in_full = 0 WHERE id = ?', id);
      await ahead();
      expect(row()).toEqual([{ paid_in_full: 0, paid_in_full_checked: 1 }]);
    });

    it('keeps a carried card being paid down in payoff', async () => {
      // $5,000 carried: $300 of charges and $500 paid each month.
      db.exec(`INSERT INTO accounts (id, name, type, current_balance_cents) VALUES (6, 'Carried Card', 'credit', 500000)`);
      for (const month of ['2026-06', '2026-07', '2026-08', '2026-09']) {
        charge(6, `${month}-10`, -30000);
        charge(6, `${month}-20`, 50000);
      }
      db.exec("INSERT INTO debts (name, account_id, balance_cents, min_payment_cents, source) VALUES ('Carried Card', 6, 500000, 15000, 'plaid')");
      const body = await ahead();
      expect(body.debts.find((d) => d.name === 'Carried Card')?.paidInFull).toBe(false);
      expect(planAhead(body.input, body.saved).debts.map((d) => d.name)).toContain('Carried Card');
      expect(db.rows('SELECT paid_in_full_checked FROM debts WHERE account_id = 6')).toEqual([{ paid_in_full_checked: 1 }]);
    });

    it('never re-detects a card the user toggled', async () => {
      const id = db.rows<{ id: number }>('SELECT id FROM debts WHERE account_id = 5')[0]!.id;
      expect((await api(env, 'PATCH', `/debts/${id}`, { paidInFull: false })).status).toBe(200);
      await ahead();
      await api(env, 'GET', '/debts');
      expect(row()).toEqual([{ paid_in_full: 0, paid_in_full_checked: 1 }]);
    });
  });

  describe('debts by hand', () => {
    it('adds any kind of debt with an estimated minimum, a term and a link', async () => {
      const loans = category('Bills');
      const res = await api(env, 'POST', '/debts', { name: 'Pay in 4', kind: 'bnpl', balanceCents: 40000, endMonth: '2027-01', categoryId: loans, dueDay: 3 });
      expect(res.status).toBe(201);
      const [d] = (await ahead()).debts;
      expect(d).toMatchObject({ name: 'Pay in 4', kind: 'bnpl', balanceCents: 40000, minPaymentCents: 2500, minEstimated: true, categoryId: loans, balanceAsOf: '2026-10-18' });
      expect((await api(env, 'POST', '/debts', { name: 'X', kind: 'boat', balanceCents: 1 })).status).toBe(400);
      expect((await api(env, 'PATCH', `/debts/${d!.id}`, { balanceCents: 30000, kind: 'family' })).status).toBe(200);
      expect((await ahead()).debts[0]).toMatchObject({ balanceCents: 30000, kind: 'family' });
    });

    it('suggests a bill to link by name, and never a partner’s private one', async () => {
      bill('Car Loan', '2026-11-03', 35000);
      bill('Student Loan', '2026-11-08', 20000, { privateMemberId: partner });
      await api(env, 'POST', '/debts', { name: 'Car loan', kind: 'car', balanceCents: 900000, minPaymentCents: 35000 });
      await api(env, 'POST', '/debts', { name: 'Student loan', kind: 'student', balanceCents: 900000, minPaymentCents: 20000 });
      const mine = await ahead(YOU);
      expect(mine.debts.map((d) => [d.name, d.suggestedBillId !== null])).toEqual([
        ['Car loan', true],
        ['Student loan', false],
      ]);
      expect(JSON.stringify(mine)).not.toContain('Student Loan');
      expect((await ahead(PARTNER)).debts.find((d) => d.name === 'Student loan')?.suggestedBillId).not.toBeNull();
    });
  });

  describe('counting debts and goals once', () => {
    it('counts a debt linked to a bill as the bill this month, then as min + extra', async () => {
      const id = bill('Car Loan', '2026-10-20', 35000);
      await api(env, 'POST', '/debts', { name: 'Car loan', kind: 'car', balanceCents: 900000, minPaymentCents: 35000, dueDay: 20, billId: id });
      await api(env, 'POST', '/debts', { name: 'Card', balanceCents: 100000, minPaymentCents: 5000, dueDay: 21 });
      const [debtId, cardId] = db.rows<{ id: number }>('SELECT id FROM debts ORDER BY id').map((r) => r.id);
      db.exec('UPDATE debts SET extra_cents = 10000 WHERE id = ?', debtId!);
      const body = await ahead();
      const carLoan = (month: string) => body.input.bills.filter((b) => b.name === 'Car Loan' && b.date.startsWith(month)).length;
      expect([carLoan('2026-10'), carLoan('2026-11'), carLoan('2027-03')]).toEqual([1, 0, 0]);
      expect(body.input.debts.map((d) => d.covered)).toEqual([true, false]);
      expect(body.saved.debtExtra).toEqual({ [debtId!]: 10000, [cardId!]: 0 });
      const r = planAhead(body.input, body.saved, 3);
      const carLines = (m: MonthsAhead['months'][number]) => m.ahead.lines.filter((l) => l.id === debtId).map((l) => l.amountCents);
      expect(r.projection.months.map(carLines)).toEqual([[], [45000], [45000], [45000]]);

      // Months ahead and Until payday count the saved plan the same way.
      const months = (await (await api(env, 'GET', '/forecast/months')).json()) as { input: MonthsAheadInput; projection: MonthsAhead };
      expect(months.projection.months[1]!.ahead.lines).toEqual([
        { kind: 'debt', id: debtId, name: 'Car loan', amountCents: 45000 },
        { kind: 'debt', id: cardId, name: 'Card', amountCents: 5000 },
      ]);
      expect(months.projection.months.slice(0, 4).map((m) => m.outCents)).toEqual(r.projection.months.map((m) => m.outCents));
      // Until payday (the 23rd): the loan once, as its bill; the card's minimum on its due day.
      const payday = (await (await api(env, 'GET', '/forecast')).json()) as { input: ProjectionInput };
      expect(payday.input.events.filter((e) => /car loan|card/i.test(e.name)).map((e) => [e.date, e.name, e.amountCents])).toEqual([
        ['2026-10-20', 'Car Loan', 35000],
        ['2026-10-21', 'Card', 5000],
      ]);
    });

    it('counts a goal’s saving line from next month as the goal’s monthly amount', async () => {
      const res = await api(env, 'POST', '/goals', { name: 'Trip', targetCents: 100000 });
      const goalId = ((await res.json()) as { id: number }).id;
      const fund = db.rows<{ c: number }>('SELECT category_id AS c FROM goals')[0]!.c;
      for (const month of ['2026-10', '2026-11']) await api(env, 'PUT', '/budget/lines', { month, categoryId: fund, budgetCents: 20000, timing: 'even' });
      const body = await ahead();
      // The line stays in this month's saving; from November (and carried into December) it's the goal's.
      expect(body.input.saving['2026-10']).toBeGreaterThan(0);
      expect([body.input.saving['2026-11'], body.input.saving['2026-12']]).toEqual([0, 0]);
      expect(body.saved.goalMonthly).toEqual({ [goalId]: 20000 });
      const r = planAhead(body.input, body.saved, 3);
      const goalLines = (m: MonthsAhead['months'][number]) => m.ahead.lines.filter((l) => l.kind === 'goal').reduce((s, l) => s + l.amountCents, 0);
      expect(r.projection.months.slice(1).map((m) => m.byGroup.saving + goalLines(m))).toEqual([20000, 20000, 20000]);
      expect(goalLines(r.projection.months[0]!)).toBe(0);
    });
  });

  describe('save', () => {
    it('writes exactly the plan’s rows in one batch: next month’s set-aside, budget lines that exist, settings', async () => {
      const loans = category('Bills');
      // A cost with no categories isn't projected (its spending can't be told apart), so it has no slider.
      const car = ((await (await api(env, 'POST', '/planned-costs', { name: 'Car', monthlyCents: 10000, categoryIds: [category('Everyday')] })).json()) as { id: number }).id;
      const goalId = ((await (await api(env, 'POST', '/goals', { name: 'Trip', targetCents: 100000 })).json()) as { id: number }).id;
      const fund = db.rows<{ c: number }>('SELECT category_id AS c FROM goals')[0]!.c;
      await api(env, 'POST', '/debts', { name: 'Card', balanceCents: 500000, minPaymentCents: 15000, aprPercent: 22, dueDay: 12, categoryId: loans });
      await api(env, 'POST', '/debts', { name: 'Other', balanceCents: 100000, minPaymentCents: 5000 });
      const [card, other] = db.rows<{ id: number }>('SELECT id FROM debts ORDER BY id').map((r) => r.id);
      // October and November have budgets; December doesn't yet.
      for (const month of ['2026-10', '2026-11']) {
        await api(env, 'PUT', '/budget/lines', { month, categoryId: loans, budgetCents: 15000, timing: 'due_day', dueDay: 12 });
      }
      const before = await ahead();
      const snapshot = () => ({
        lines: db.rows('SELECT month, category_id, budget_cents, timing, due_day FROM budget_lines ORDER BY month, category_id'),
        amounts: db.rows('SELECT planned_cost_id, month, monthly_cents FROM planned_cost_amounts ORDER BY month'),
        debts: db.rows('SELECT id, extra_cents, sort FROM debts ORDER BY id'),
        goals: db.rows('SELECT id, monthly_cents FROM goals'),
        household: db.rows('SELECT surprise_cents, debt_strategy FROM household'),
      });
      const was = snapshot();

      const batch = vi.spyOn(db, 'batch');
      const res = await api(env, 'POST', '/ahead/plan', {
        ...before.saved,
        debtExtra: { [card!]: 20000, [other!]: 0 },
        costMonthly: { [car]: 12500 },
        goalMonthly: { [goalId]: 5000 },
        surpriseCents: 15000,
        strategy: 'custom',
        order: [other, card],
      });
      expect(res.status).toBe(200);
      expect(batch).toHaveBeenCalledTimes(1);
      const now = snapshot();
      expect(now.debts).toEqual([
        { id: card, extra_cents: 20000, sort: 1 },
        { id: other, extra_cents: 0, sort: 0 },
      ]);
      expect(now.goals).toEqual([{ id: goalId, monthly_cents: 5000 }]);
      expect(now.household).toEqual([{ surprise_cents: 15000, debt_strategy: 'custom' }]);
      // This month's set-aside is left as is.
      expect(now.amounts).toEqual([...was.amounts, { planned_cost_id: car, month: '2026-11', monthly_cents: 12500 }]);
      // November (exists): the loans line is min + extra, the goal gets a line. October and December untouched.
      expect(now.lines).toEqual([
        ...was.lines.filter((l) => (l as { month: string }).month === '2026-10'),
        { month: '2026-11', category_id: loans, budget_cents: 35000, timing: 'due_day', due_day: 12 },
        { month: '2026-11', category_id: fund, budget_cents: 5000, timing: 'even', due_day: null },
      ].sort((a, b) => (a as { month: string }).month.localeCompare((b as { month: string }).month) || (a as { category_id: number }).category_id - (b as { category_id: number }).category_id));

      // Loaded again, the saved plan is what was saved.
      const after = await ahead();
      expect(after.saved).toMatchObject({ debtExtra: { [card!]: 20000, [other!]: 0 }, costMonthly: { [car]: 12500 }, goalMonthly: { [goalId]: 5000 }, surpriseCents: 15000, strategy: 'custom', order: [other, card] });
      expect(after.surprise.savedCents).toBe(15000);

      // A linked card's line uses its balance now, not a stored one; the debt row itself isn't written.
      db.exec(`INSERT INTO accounts (id, name, type, current_balance_cents) VALUES (6, 'Store Card', 'credit', 400000)`);
      await ahead();
      const store = db.rows<{ id: number }>('SELECT id FROM debts WHERE account_id = 6')[0]!.id;
      await api(env, 'PATCH', `/debts/${store}`, { categoryId: loans });
      db.exec('UPDATE accounts SET current_balance_cents = 600000 WHERE id = 6');
      const storeRow = () => db.rows('SELECT balance_cents, min_payment_cents, updated_at FROM debts WHERE id = ?', store);
      const stored = storeRow();
      await api(env, 'POST', '/ahead/plan', { debtExtra: { [store]: 1000 } });
      expect(db.rows("SELECT budget_cents FROM budget_lines WHERE month = '2026-11' AND category_id = ?", loans)).toEqual([
        // Card 15,000 + 20,000 extra; store card's estimate on 600,000 (6,000) + 1,000.
        { budget_cents: 35000 + 7000 },
      ]);
      expect(db.rows('SELECT extra_cents FROM debts WHERE id = ?', store)).toEqual([{ extra_cents: 1000 }]);
      expect(storeRow().map((r) => ({ ...r, updated_at: null }))).toEqual(stored.map((r) => ({ ...r, updated_at: null })));
      await api(env, 'POST', '/ahead/plan', { debtExtra: { [store]: 0 } });
      await api(env, 'PATCH', `/debts/${store}`, { categoryId: null });

      // A month created later carries the plan.
      expect((await api(env, 'POST', '/budget/copy', { from: '2026-10', to: '2026-12' })).status).toBe(200);
      expect(db.rows("SELECT category_id, budget_cents FROM budget_lines WHERE month = '2026-12' ORDER BY category_id")).toEqual(
        [{ category_id: loans, budget_cents: 35000 }, { category_id: fund, budget_cents: 5000 }].sort((a, b) => a.category_id - b.category_id),
      );

      // Back to the suggestion.
      await api(env, 'POST', '/ahead/plan', { ...after.saved, surpriseCents: null });
      expect(db.rows('SELECT surprise_cents FROM household')).toEqual([{ surprise_cents: null }]);
      expect((await api(env, 'POST', '/ahead/plan', { ...after.saved, strategy: 'random' })).status).toBe(400);
    });
  });

  describe('known items', () => {
    it('adds, lists, edits and deletes', async () => {
      const add = await api(env, 'POST', '/ahead/items', { name: 'Tax refund', amountCents: 120000, month: '2027-03' });
      expect(add.status).toBe(201);
      const { id } = (await add.json()) as { id: number };
      await api(env, 'POST', '/ahead/items', { name: 'Registration', amountCents: -18000, month: '2027-05', repeat: 'yearly' });
      expect((await api(env, 'POST', '/ahead/items', { name: 'Bad', amountCents: 0, month: '2027-05' })).status).toBe(400);
      expect((await api(env, 'POST', '/ahead/items', { name: 'Bad', amountCents: 5, month: '2027-05', repeat: 'monthly', endMonth: '2027-01' })).status).toBe(400);
      expect((await api(env, 'PATCH', `/ahead/items/${id}`, { amountCents: 130000, repeat: 'monthly', endMonth: '2027-06' })).status).toBe(200);
      const list = (await (await api(env, 'GET', '/ahead/items', undefined, PARTNER)).json()) as AheadBody['items'];
      expect(list.map((i) => [i.name, i.amountCents, i.month, i.repeat, i.endMonth])).toEqual([
        ['Tax refund', 130000, '2027-03', 'monthly', '2027-06'],
        ['Registration', -18000, '2027-05', 'yearly', null],
      ]);
      const body = await ahead();
      expect(body.input.items.map((i) => i.name)).toEqual(['Tax refund', 'Registration']);
      expect(planAhead(body.input, body.saved).projection.months[5]!.ahead.inCents).toBe(130000);
      expect((await api(env, 'DELETE', `/ahead/items/${id}`)).status).toBe(200);
      expect((await api(env, 'DELETE', `/ahead/items/${id}`)).status).toBe(404);
      expect((await ahead()).items.map((i) => i.name)).toEqual(['Registration']);
      const exported = (await (await api(env, 'GET', '/export/json')).json()) as { aheadItems: unknown[] };
      expect(exported.aheadItems).toHaveLength(1);
    });
  });

  describe('surprises', () => {
    it('suggests the median of the last 6 months’ unplanned spending of $100 and up', async () => {
      const everyday = category('Everyday');
      bill('Insurance', '2026-11-05', 30000);
      for (const [i, month] of ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].entries()) {
        charge(1, `${month}-05`, -(10000 + i * 5000), { category_id: everyday });
        charge(1, `${month}-06`, -9999, { category_id: everyday });
        charge(1, `${month}-07`, -30000, { name: 'INSURANCE' });
        charge(1, `${month}-08`, -40000, { private_member_id: partner });
      }
      const body = await ahead();
      // 100, 150, 200, 250, 300, 350: median 225.
      expect(body.surprise).toEqual({ suggestedCents: 22500, savedCents: null });
      expect(body.saved.surpriseCents).toBe(22500);
      expect(body.input.surpriseCents).toBe(22500);
    });
  });

  it('never shows a partner’s private bill', async () => {
    bill('Internet', '2026-10-20', 6000);
    bill('Gym', '2026-10-22', 3000, { privateMemberId: partner });
    const mine = await ahead(YOU);
    expect(mine.input.bills.map((b) => b.name)).toContain('Internet');
    expect(JSON.stringify(mine)).not.toContain('Gym');
    expect((await ahead(PARTNER)).input.bills.map((b) => b.name)).toContain('Gym');
  });
});
