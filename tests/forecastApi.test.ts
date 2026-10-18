import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/worker/env';
import { buildTrends } from '../src/shared/trends';
import { projectToPayday, type Projection, type ProjectionInput } from '../src/shared/projection';
import { loadTrendsInput, monthsBack } from '../src/worker/services/trends';
import { api } from './helpers/api';
import { TestD1 } from './helpers/d1';
import { testEnv } from './helpers/plaid';

const YOU = 'you@example.com';
const PARTNER = 'partner@example.com';

interface ForecastBody {
  today: string;
  input: ProjectionInput;
  projection: Projection;
  hasSetAsides: boolean;
  hasBalance: boolean;
}

describe('GET /api/forecast', () => {
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
    db.exec(`INSERT INTO accounts (id, name, type, current_balance_cents, hidden) VALUES (3, 'Old', 'checking', 99999, 1)`);
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

  function bill(name: string, nextDate: string, cents: number, privateMemberId: number | null = null, status = 'confirmed') {
    db.exec(
      `INSERT INTO recurring_bills (merchant, name, cadence, expected_amount_cents, next_date, status, private_member_id)
       VALUES (?, ?, 'monthly', ?, ?, ?, ?)`,
      name.toLowerCase(),
      name,
      -cents,
      nextDate,
      status,
      privateMemberId,
    );
  }

  const forecast = async (email = YOU) => {
    const res = await api(env, 'GET', '/forecast', undefined, email);
    expect(res.status).toBe(200);
    return (await res.json()) as ForecastBody;
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
    bill('Streaming', '2026-10-21', 1500, you);
    bill('Gym', '2026-10-22', 3000, partner);
    bill('Maybe', '2026-10-20', 7000, null, 'suggested');
    bill('Water', '2026-10-25', 4000); // after payday
  }

  it('projects cash to the day before payday, with private bills only for their owner', async () => {
    seedHousehold();
    const bills = category('Bills');
    await api(env, 'PUT', '/budget/lines', { month: '2026-10', categoryId: bills, budgetCents: 50000, timing: 'due_day', dueDay: 10 });

    const mine = await forecast();
    expect(mine.input.startBalanceCents).toBe(300000);
    expect(mine.input.payday).toEqual({ date: '2026-10-23', amountCents: 250000, name: 'Paycheck' });
    expect(mine.input.dailySpend).toEqual({ everyday: 1000, habits: 500, fun: 300 });
    expect(mine.projection.points.map((p) => p.date)).toEqual(['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22']);
    // The overdue budget bill lands tomorrow.
    expect(mine.projection.events.map((e) => [e.name, e.date, e.amountCents, e.kind])).toEqual([
      [expect.any(String), '2026-10-19', 50000, 'budget'],
      ['Internet', '2026-10-20', 6000, 'bill'],
      ['Streaming', '2026-10-21', 1500, 'bill'],
    ]);
    expect(mine.projection.spendTotalCents).toBe(4 * 1800);
    expect(mine.projection.dayBeforeCents).toBe(300000 - 7200 - 50000 - 6000 - 1500);
    // The client re-runs the same function on the inputs and gets the same answer.
    expect(projectToPayday(mine.input)).toEqual(mine.projection);

    const theirs = await forecast(PARTNER);
    const names = theirs.projection.events.map((e) => e.name);
    expect(names).toContain('Gym');
    expect(names).not.toContain('Streaming');
    expect(mine.projection.events.map((e) => e.name)).not.toContain('Gym');
    expect(theirs.input.dailySpend).toEqual(mine.input.dailySpend);
    expect(JSON.stringify(theirs)).not.toContain('CHARGE');
    expect(JSON.stringify(mine)).not.toContain('CHARGE');
  });

  describe('a payday next month', () => {
    let rent: number;
    beforeEach(() => {
      // Paid on the 3rd; rent is due on the 1st and October's is already paid.
      db.exec("INSERT INTO income_sources (name, net_pay_cents, frequency, anchor_date) VALUES ('Paycheck', 250000, 'monthly', '2026-09-03')");
      rent = category('Bills');
      charge('2026-10-01', -150000, { category_id: rent });
    });
    const rentEvents = (body: ForecastBody) => body.projection.events.filter((e) => e.amountCents >= 150000);

    it('carries this month’s due-day lines into next month when it has no budget yet', async () => {
      await api(env, 'PUT', '/budget/lines', { month: '2026-10', categoryId: rent, budgetCents: 150000, timing: 'due_day', dueDay: 1 });
      const body = await forecast();
      expect(body.input.payday?.date).toBe('2026-11-03');
      expect(rentEvents(body).map((e) => [e.date, e.amountCents, e.kind])).toEqual([['2026-11-01', 150000, 'budget']]);
    });

    it('counts rent once when a confirmed bill in the same category is due too', async () => {
      await api(env, 'PUT', '/budget/lines', { month: '2026-10', categoryId: rent, budgetCents: 150000, timing: 'due_day', dueDay: 1 });
      db.exec(
        `INSERT INTO recurring_bills (merchant, name, cadence, expected_amount_cents, next_date, status, category_id)
         VALUES ('landlord', 'Landlord', 'monthly', -150000, '2026-11-01', 'confirmed', ?)`,
        rent,
      );
      const body = await forecast();
      expect(rentEvents(body).map((e) => [e.name, e.date, e.kind])).toEqual([['Landlord', '2026-11-01', 'bill']]);
    });

    it('uses next month’s budget once it exists', async () => {
      await api(env, 'PUT', '/budget/lines', { month: '2026-10', categoryId: rent, budgetCents: 150000, timing: 'due_day', dueDay: 1 });
      await api(env, 'PUT', '/budget/lines', { month: '2026-11', categoryId: rent, budgetCents: 160000, timing: 'due_day', dueDay: 2 });
      const body = await forecast();
      expect(rentEvents(body).map((e) => [e.date, e.amountCents])).toEqual([['2026-11-02', 160000]]);
    });
  });

  it('takes confirmed bills out of their group’s usual spending', async () => {
    seedHousehold();
    const fun = category('Fun & Wants', 'AND c.fun_member_id IS NULL');
    db.exec(
      `INSERT INTO recurring_bills (merchant, name, cadence, expected_amount_cents, next_date, status, category_id)
       VALUES ('streamco', 'Video', 'monthly', -1520, '2026-10-30', 'confirmed', ?)`,
      fun,
    );
    // Fun was 9,120 a month; less the 1,520 bill, 7,600 / 30.4 = 250 a day.
    expect((await forecast()).input.dailySpend).toEqual({ everyday: 1000, habits: 500, fun: 250 });
  });

  it('falls back to the end of the month with no payday, and starts from zero with no history', async () => {
    db.exec("INSERT INTO income_sources (name, net_pay_cents, frequency, anchor_date, active) VALUES ('Old job', 1, 'weekly', '2026-10-02', 0)");
    const body = await forecast();
    expect(body.input.payday).toBeNull();
    expect(body.projection.note).toMatch(/No payday set up/);
    expect(body.projection.lastDate).toBe('2026-10-31');
    expect(body.input.dailySpend).toEqual({ everyday: 0, habits: 0, fun: 0 });
    expect(body.projection.dayBeforeCents).toBe(300000);
    expect(body.hasSetAsides).toBe(false);
  });

  it('leaves planned-cost set-asides in the account', async () => {
    const savings = category('Saving', "AND c.name = 'Savings & Planned Costs'");
    await api(env, 'PUT', '/budget/lines', { month: '2026-10', categoryId: savings, budgetCents: 30000, timing: 'due_day', dueDay: 20 });
    expect((await api(env, 'POST', '/planned-costs', { name: 'Car repairs', monthlyCents: 10000 })).status).toBe(201);
    const body = await forecast();
    expect(body.hasSetAsides).toBe(true);
    expect(body.projection.events.find((e) => e.name === 'Savings & Planned Costs')?.amountCents).toBe(30000);
  });

  it('says when no cash account has a balance', async () => {
    db.exec('UPDATE accounts SET current_balance_cents = NULL');
    const body = await forecast();
    expect(body.hasBalance).toBe(false);
    db.exec('UPDATE accounts SET current_balance_cents = 100 WHERE id = 1');
    expect((await forecast()).hasBalance).toBe(true);
  });

  it('skips a payday whose deposit already came in', async () => {
    db.exec("INSERT INTO income_sources (id, name, net_pay_cents, frequency, anchor_date) VALUES (1, 'Weekly', 100000, 'weekly', '2026-10-02')");
    db.exec(
      "INSERT INTO transactions (account_id, date, amount_cents, name, source, income_source_id, pay_date) VALUES (1, '2026-10-21', 100000, 'PAY', 'plaid', 1, '2026-10-23')",
    );
    expect((await forecast()).input.payday?.date).toBe('2026-10-30');
  });

  it('stays quick with 3,000 transactions', async () => {
    seedHousehold();
    const everyday = category('Everyday');
    for (let i = 0; i < 3000; i++) {
      const day = String(1 + (i % 28)).padStart(2, '0');
      const month = ['2026-07', '2026-08', '2026-09', '2026-10'][i % 4]!;
      charge(`${month}-${day}`, -(500 + (i % 900)), { category_id: everyday });
    }
    await forecast(); // warm up

    // The pure work (what Workers bills as CPU; D1 time isn't) stays well under 10 ms.
    const input = await loadTrendsInput(env.DB, monthsBack('2026-10-18', 4), '2026-10-18');
    const body = await forecast();
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      buildTrends(input);
      projectToPayday(body.input);
      runs.push(performance.now() - start);
    }
    expect(Math.min(...runs)).toBeLessThan(5);

    // The whole route less its sqlite time (in-process here; I/O on D1, not CPU). Alone it measures about
    // 5 ms; the bound leaves room for the rest of the suite running in parallel.
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
        await forecast();
        totals.push(performance.now() - start - sqlite);
      }
      expect(Math.min(...totals)).toBeLessThan(20);
    } finally {
      proto.execute = execute;
    }
  });
});
