import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTrends } from '../src/shared/trends';
import { loadTrendsInput, monthsBack } from '../src/worker/services/trends';
import { projectMonths, type MonthsAhead, type MonthsAheadInput } from '../src/shared/monthsAhead';
import type { Env } from '../src/worker/env';
import { api } from './helpers/api';
import { TestD1 } from './helpers/d1';
import { testEnv } from './helpers/plaid';

const YOU = 'you@example.com';
const PARTNER = 'partner@example.com';

interface MonthsBody {
  today: string;
  input: MonthsAheadInput;
  projection: MonthsAhead;
  hasBalance: boolean;
  hasIncome: boolean;
}

describe('GET /api/forecast/months', () => {
  let db: TestD1;
  let env: Env;
  let you: number;
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
    you = member(YOU);
    partner = member(PARTNER);
    db.exec(`INSERT INTO accounts (id, name, type, current_balance_cents) VALUES (1, 'Checking', 'checking', 300000)`);
    db.exec(`INSERT INTO accounts (id, name, type, current_balance_cents) VALUES (2, 'Card', 'credit', -50000)`);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function charge(date: string, cents: number, extra: Record<string, unknown> = {}) {
    const cols = ['account_id', 'date', 'amount_cents', 'name', 'source', ...Object.keys(extra)];
    db.exec(
      `INSERT INTO transactions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      2,
      date,
      cents,
      `CHARGE ${date}`,
      'plaid',
      ...(Object.values(extra) as (string | number | null)[]),
    );
  }

  function bill(name: string, nextDate: string, cents: number, opts: { cadence?: string; privateMemberId?: number | null; categoryId?: number | null } = {}) {
    db.exec(
      `INSERT INTO recurring_bills (merchant, name, cadence, expected_amount_cents, next_date, status, private_member_id, category_id)
       VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?)`,
      name.toLowerCase(),
      name,
      opts.cadence ?? 'monthly',
      -cents,
      nextDate,
      opts.privateMemberId ?? null,
      opts.categoryId ?? null,
    );
  }

  const months = async (email = YOU) => {
    const res = await api(env, 'GET', '/forecast/months', undefined, email);
    expect(res.status).toBe(200);
    return (await res.json()) as MonthsBody;
  };

  function seedHousehold() {
    db.exec("INSERT INTO income_sources (name, net_pay_cents, frequency, anchor_date) VALUES ('Paycheck', 250000, 'monthly', '2026-09-23')");
    const everyday = category('Everyday');
    const habits = category('Habits');
    for (const month of ['2026-07', '2026-08', '2026-09']) {
      charge(`${month}-10`, -30400, { category_id: everyday });
      charge(`${month}-12`, -15200, { category_id: habits });
      // The partner's private fun money: it counts only as their fun total.
      charge(`${month}-14`, -9120, { private_member_id: partner });
    }
    bill('Internet', '2026-10-20', 6000);
    bill('Streaming', '2026-10-21', 1500, { privateMemberId: you });
    bill('Gym', '2026-10-22', 3000, { privateMemberId: partner });
    bill('Car insurance', '2027-03-04', 61200, { cadence: 'yearly' });
  }

  it('projects a year ahead, with private bills only for their owner', async () => {
    seedHousehold();
    const rent = category('Bills');
    await api(env, 'PUT', '/budget/lines', { month: '2026-10', categoryId: rent, budgetCents: 150000, timing: 'due_day', dueDay: 1 });
    charge('2026-10-01', -150000, { category_id: rent });

    const mine = await months();
    expect(mine.hasIncome).toBe(true);
    expect(mine.input.startBalanceCents).toBe(300000);
    // The client re-runs the same function on the inputs and gets the same answer.
    expect(projectMonths(mine.input, 12)).toEqual(mine.projection);
    const p = mine.projection;
    expect(p.months.map((m) => m.month)).toEqual([
      '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06', '2027-07', '2027-08', '2027-09', '2027-10',
    ]);
    // October's rent is paid; it carries forward into every later month.
    expect(p.months.map((m) => m.payDays)).toEqual(Array(13).fill(1));
    const nov = p.months[1]!;
    expect(nov.byGroup).toEqual({ bills: 150000 + 6000, everyday: 30400, habits: 15200, fun: 9120 + 1500, saving: 0 });
    expect(p.months[5]!.bigItems).toEqual([{ name: 'Car insurance', amountCents: 61200, note: null }]);

    const names = (body: MonthsBody) => [...new Set(body.input.bills.map((b) => b.name))];
    expect(names(mine)).toContain('Streaming');
    expect(names(mine)).not.toContain('Gym');
    expect(mine.input.bills.find((b) => b.name === 'Streaming')?.group).toBe('fun');

    const theirs = await months(PARTNER);
    expect(names(theirs)).toContain('Gym');
    expect(JSON.stringify(theirs)).not.toContain('Streaming');
    expect(JSON.stringify(mine)).not.toContain('Gym');
    expect(JSON.stringify(mine)).not.toContain('CHARGE');
    // The partner's private fun is in the usual fun total for both.
    expect(theirs.input.usual.fun).toBe(mine.input.usual.fun);
  });

  it('runs with no income sources: nothing comes in', async () => {
    const everyday = category('Everyday');
    charge('2026-09-10', -30400, { category_id: everyday });
    const body = await months();
    expect(body.hasIncome).toBe(false);
    expect(body.projection.totals.inCents).toBe(0);
    expect(body.projection.months[1]!.byGroup.everyday).toBe(30400);
    expect(body.projection.months[1]!.endCents).toBeLessThan(300000);
  });

  it('counts each month’s savings lines without their set-aside, and not again as bills', async () => {
    const savings = category('Saving', "AND c.name = 'Savings & Planned Costs'");
    expect((await api(env, 'POST', '/planned-costs', { name: 'Car repairs', monthlyCents: 10000 })).status).toBe(201);
    await api(env, 'PUT', '/budget/lines', { month: '2026-10', categoryId: savings, budgetCents: 30000, timing: 'due_day', dueDay: 2 });
    await api(env, 'PUT', '/budget/lines', { month: '2026-12', categoryId: savings, budgetCents: 50000, timing: 'even' });
    const body = await months();
    expect(body.projection.months.slice(0, 4).map((m) => m.byGroup.saving)).toEqual([30000, 30000, 50000, 30000]);
    expect(body.projection.months.slice(0, 4).map((m) => m.byGroup.bills)).toEqual([0, 0, 0, 0]);
  });

  it('expects planned-cost spending like last year, leaving private charges and its own bills out', async () => {
    const gifts = category('Fun & Wants', "AND c.name = 'Gifts'");
    const car = category('Everyday', "AND c.name = 'Car Upkeep'");
    charge('2025-06-01', -1000, { category_id: category('Everyday') }); // history starts over a year ago
    charge('2025-12-10', -54000, { category_id: gifts });
    charge('2025-12-12', -7000, { category_id: gifts, private_member_id: partner });
    charge('2026-03-04', -70000, { category_id: car });
    expect((await api(env, 'POST', '/planned-costs', { name: 'Holidays & gifts', monthlyCents: 5000, categoryIds: [gifts] })).status).toBe(201);
    expect((await api(env, 'POST', '/planned-costs', { name: 'Car', monthlyCents: 6000, categoryIds: [car] })).status).toBe(201);
    bill('Car insurance', '2027-03-04', 61200, { cadence: 'yearly', categoryId: car });

    const body = await months();
    const holidays = body.input.plannedCosts.find((c) => c.name === 'Holidays & gifts')!;
    expect(holidays.group).toBe('fun');
    expect(holidays.spendByMonth['2025-12']).toBe(54000);
    const dec = body.projection.months.find((m) => m.month === '2026-12')!;
    expect(dec.bigItems).toEqual([{ name: 'Holidays & gifts', amountCents: 54000, note: 'like last Dec' }]);
    const march = body.projection.months.find((m) => m.month === '2027-03')!;
    expect(march.byGroup.bills).toBe(61200);
    expect(march.byGroup.everyday).toBe(70000 - 61200);
    expect(body.projection.plannedCosts.find((c) => c.name === 'Holidays & gifts')).toMatchObject({ lowestMonth: '2026-12' });
  });

  describe('a due-day line and a confirmed bill in the same category', () => {
    let bills: number;
    beforeEach(() => {
      bills = category('Bills');
    });
    const rentEachMonth = (body: MonthsBody) => body.projection.months.map((m) => m.byGroup.bills);

    it('counts rent once a month, the line this month and the bill after', async () => {
      await api(env, 'PUT', '/budget/lines', { month: '2026-10', categoryId: bills, budgetCents: 150000, timing: 'due_day', dueDay: 25 });
      bill('Landlord', '2026-10-25', 150000, { categoryId: bills });
      const body = await months();
      expect(rentEachMonth(body)).toEqual(Array(13).fill(150000));
      const october = body.input.bills.filter((b) => b.date.startsWith('2026-10'));
      expect(october.map((b) => [b.cadence, b.amountCents])).toEqual([[null, 150000]]);
      expect(body.input.bills.filter((b) => b.date.startsWith('2027-03')).map((b) => b.name)).toEqual(['Landlord']);
    });

    it('counts rent once when the line is on the parent and the bill on a sub-category', async () => {
      const child = ((await (await api(env, 'POST', '/categories', { parentId: bills, name: 'Rent' })).json()) as { id: number }).id;
      await api(env, 'PUT', '/budget/lines', { month: '2026-10', categoryId: bills, budgetCents: 150000, timing: 'due_day', dueDay: 25 });
      bill('Landlord', '2026-10-25', 150000, { categoryId: child });
      expect(rentEachMonth(await months())).toEqual(Array(13).fill(150000));
    });
  });

  describe('other bills', () => {
    let utilities: number;
    beforeEach(() => {
      utilities = category('Bills', "AND c.name = 'Utilities'");
    });

    it('averages a Bills category over 12 months, less its confirmed quarterly bill, with no double count', async () => {
      // Electric varies and was never confirmed: $50 a month. Water is a confirmed $120 bill each quarter.
      for (let i = 0; i < 12; i++) {
        const month = `${2025 + Math.floor((9 + i) / 12)}-${String(((9 + i) % 12) + 1).padStart(2, '0')}`;
        charge(`${month}-08`, -5000, { category_id: utilities });
        if (i % 3 === 1) charge(`${month}-10`, -12000, { category_id: utilities });
      }
      bill('Water', '2026-11-10', 12000, { cadence: 'quarterly', categoryId: utilities });
      const body = await months();
      // (12 × 50 + 4 × 120) / 12 = 90 a month, less water's 40 a month: 50.
      expect(body.input.otherBillsCents).toBe(5000);
      const by = (month: string) => body.projection.months.find((m) => m.month === month)!;
      expect(by('2026-11').byGroup.bills).toBe(5000 + 12000);
      expect(by('2026-12').byGroup.bills).toBe(5000);
      expect(by('2026-11').otherBillsCents).toBe(5000);
      // Over the year: 12 × 50 + 4 × 120 = what went out last year.
      const year = body.projection.months.slice(1).reduce((sum, m) => sum + m.byGroup.bills, 0);
      expect(year).toBe(12 * 5000 + 4 * 12000);
    });

    it('averages over the months there are, and leaves out due-day lines and planned-cost categories', async () => {
      const insurance = category('Bills', "AND c.name = 'Insurance'");
      for (const month of ['2026-07', '2026-08', '2026-09']) {
        charge(`${month}-08`, -6000, { category_id: utilities });
        charge(`${month}-09`, -20000, { category_id: insurance });
      }
      await api(env, 'PUT', '/budget/lines', { month: '2026-10', categoryId: utilities, budgetCents: 4000, timing: 'due_day', dueDay: 28 });
      expect((await api(env, 'POST', '/planned-costs', { name: 'Insurance', monthlyCents: 20000, categoryIds: [insurance] })).status).toBe(201);
      // Utilities: 60 a month, 40 of it in the line.
      expect((await months()).input.otherBillsCents).toBe(2000);
    });
  });

  it('takes a due-day line in Everyday out of everyday’s usual', async () => {
    const everyday = category('Everyday');
    for (const month of ['2026-07', '2026-08', '2026-09']) charge(`${month}-05`, -30400, { category_id: everyday });
    await api(env, 'PUT', '/budget/lines', { month: '2026-10', categoryId: everyday, budgetCents: 30000, timing: 'due_day', dueDay: 5 });
    const nov = (await months()).projection.months[1]!;
    expect(nov.byGroup.everyday).toBe(400);
    expect(nov.byGroup.bills).toBe(30000);
  });

  it('counts a line on a sub-category once when the bill is on its parent', async () => {
    const parent = category('Bills');
    const child = ((await (await api(env, 'POST', '/categories', { parentId: parent, name: 'Rent' })).json()) as { id: number }).id;
    await api(env, 'PUT', '/budget/lines', { month: '2026-10', categoryId: child, budgetCents: 150000, timing: 'due_day', dueDay: 25 });
    bill('Landlord', '2026-10-25', 150000, { categoryId: parent });
    expect((await months()).projection.months.map((m) => m.byGroup.bills)).toEqual(Array(13).fill(150000));
  });

  it('keeps to a bounded number of D1 queries, however many later months have a budget', async () => {
    seedHousehold();
    const rent = category('Bills');
    const savings = category('Saving', "AND c.name = 'Savings & Planned Costs'");
    expect((await api(env, 'POST', '/planned-costs', { name: 'Car repairs', monthlyCents: 10000 })).status).toBe(201);
    await api(env, 'POST', '/goals', { name: 'Emergency fund', targetCents: 200000 });
    // Plan › Ahead: a debt linked to a line, a hand-kept one, a known item; the card links itself.
    await api(env, 'POST', '/debts', { name: 'Car loan', balanceCents: 900000, minPaymentCents: 35000, categoryId: rent });
    await api(env, 'POST', '/debts', { name: 'Family', kind: 'family', balanceCents: 100000 });
    await api(env, 'POST', '/ahead/items', { name: 'Tax refund', amountCents: 120000, month: '2027-03' });
    for (const month of ['2026-10', '2026-11', '2026-12', '2027-01']) {
      await api(env, 'PUT', '/budget/lines', { month, categoryId: rent, budgetCents: 150000, timing: 'due_day', dueDay: 1 });
      await api(env, 'PUT', '/budget/lines', { month, categoryId: savings, budgetCents: 30000, timing: 'even' });
    }
    const proto = Object.getPrototypeOf(db.prepare('SELECT 1')) as { execute: (...a: unknown[]) => unknown };
    const execute = proto.execute;
    let queries = 0;
    proto.execute = function (this: unknown, ...a: unknown[]) {
      queries++;
      return execute.apply(this, a);
    };
    try {
      const count = async (path: string) => {
        queries = 0;
        expect((await api(env, 'GET', path, undefined, YOU)).status).toBe(200);
        return queries;
      };
      expect(await count('/forecast/months')).toBeLessThanOrEqual(35);
      expect(await count('/forecast')).toBeLessThanOrEqual(35);
      expect(await count('/ahead')).toBeLessThanOrEqual(35);
    } finally {
      proto.execute = execute;
    }
    // Later months' own budgets still count.
    const body = await months();
    expect(body.projection.months.slice(1, 4).map((m) => m.byGroup.saving)).toEqual([30000, 30000, 30000]);
  });

  it('projects a goal from its recent contributions', async () => {
    const res = await api(env, 'POST', '/goals', { name: 'Emergency fund', targetCents: 200000 });
    const id = ((await res.json()) as { id: number }).id;
    db.exec("UPDATE goals SET created_at = '2026-06-01T00:00:00Z' WHERE id = ?", id);
    const fund = db.rows<{ categoryId: number }>('SELECT category_id AS categoryId FROM goals WHERE id = ?', id)[0]!.categoryId;
    for (const month of ['2026-07', '2026-08', '2026-09']) charge(`${month}-05`, -20000, { category_id: fund });
    const body = await months();
    // 60,000 saved, 140,000 to go at 20,000 a month: 7 months.
    expect(body.projection.goals).toEqual([{ name: 'Emergency fund', projectedMonth: '2027-05', done: false }]);
  });

  it('stays quick with 3,000 transactions and 30 bills', async () => {
    seedHousehold();
    const everyday = category('Everyday');
    for (let i = 0; i < 3000; i++) {
      const day = String(1 + (i % 28)).padStart(2, '0');
      const month = ['2025-11', '2026-01', '2026-03', '2026-05', '2026-07', '2026-08', '2026-09', '2026-10'][i % 8]!;
      charge(`${month}-${day}`, -(500 + (i % 900)), { category_id: everyday });
    }
    for (let i = 0; i < 26; i++) bill(`Bill ${i}`, `2026-10-${String(19 + (i % 10)).padStart(2, '0')}`, 1000 + i * 100, { cadence: i % 3 ? 'monthly' : 'weekly' });
    await months(); // warm up

    // The pure work (what Workers bills as CPU; D1 time isn't) stays well under 10 ms.
    const input = await loadTrendsInput(env.DB, monthsBack('2026-10-18', 13), '2026-10-18');
    const body = await months();
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      buildTrends(input);
      projectMonths(body.input, 12);
      runs.push(performance.now() - start);
    }
    expect(Math.min(...runs)).toBeLessThan(5);

    // The whole route less its sqlite time (in-process here; I/O on D1, not CPU).
    const proto = Object.getPrototypeOf(db.prepare('SELECT 1')) as { execute: (...a: unknown[]) => unknown };
    const execute = proto.execute;
    let sqlite = 0;
    proto.execute = function (this: unknown, ...a: unknown[]) {
      const t = performance.now();
      try {
        return execute.apply(this, a);
      } finally {
        sqlite += performance.now() - t;
      }
    };
    try {
      const totals: number[] = [];
      for (let i = 0; i < 5; i++) {
        sqlite = 0;
        const start = performance.now();
        await months();
        totals.push(performance.now() - start - sqlite);
      }
      expect(Math.min(...totals)).toBeLessThan(20);
    } finally {
      proto.execute = execute;
    }
  });
});
