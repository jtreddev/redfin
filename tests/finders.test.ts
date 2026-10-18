import { beforeEach, describe, expect, it } from 'vitest';
import { addDays, todayIn, type ISODate } from '../src/shared/dates';
import { findPaychecks, type DepositInput } from '../src/shared/paycheckFinder';
import { payDatesBetween } from '../src/shared/paySchedule';
import { detectRecurring } from '../src/shared/recurring';
import { normalizeMerchant } from '../src/shared/rules';
import type { Env } from '../src/worker/env';
import { api } from './helpers/api';
import { TestD1 } from './helpers/d1';
import { testEnv } from './helpers/plaid';

const TODAY = '2026-10-17';
let nextId = 1;

function deposit(date: ISODate, dollars: number, name = 'ACME CORP PAYROLL ACH CREDIT 0042817', extra: Partial<DepositInput> = {}): DepositInput {
  return { id: nextId++, date, amountCents: Math.round(dollars * 100), name, merchant: normalizeMerchant(name), accountId: 1, plaidCategory: 'INCOME', ...extra };
}

function every(days: number, from: ISODate, until: ISODate = TODAY): ISODate[] {
  const dates: ISODate[] = [];
  for (let d = from; d <= until; d = addDays(d, days)) dates.push(d);
  return dates;
}

describe('findPaychecks', () => {
  it('finds a biweekly paycheck that Chime pays two days early', () => {
    // Paydays are Fridays; the money lands Wednesday.
    const deposits = every(14, '2026-04-03').map((friday, i) => deposit(addDays(friday, -2), 2143.18 + (i % 3 === 0 ? 61.5 : 0)));
    const [found, ...rest] = findPaychecks(deposits, { today: TODAY });
    expect(rest).toEqual([]);
    expect(found).toMatchObject({ frequency: 'biweekly', netPayCents: 214318, accountId: 1, semimonthlyDays: null });
    // ACH is in the description, and it's still treated as a paycheck.
    expect(found!.matchText).toBe('ACME CORP PAYROLL');
    expect(found!.nextDate).toBe(addDays(deposits[deposits.length - 1]!.date, 14));
  });

  it('tells twice a month (15th and last day, weekends moved to Friday) from every two weeks', () => {
    const schedule = { frequency: 'semimonthly' as const, anchorDate: TODAY, semimonthlyDays: [15, 31] as [number, number] };
    const deposits = payDatesBetween(schedule, '2026-04-01', TODAY).map((date) => deposit(date, 1875));
    const [found] = findPaychecks(deposits, { today: TODAY });
    expect(found).toMatchObject({ frequency: 'semimonthly', semimonthlyDays: [15, 31], nextDate: '2026-10-30' });
  });

  it('tells weekly from biweekly', () => {
    const [found] = findPaychecks(every(7, '2026-06-05').map((date) => deposit(date, 640)), { today: TODAY });
    expect(found?.frequency).toBe('weekly');
  });

  it('keeps a monthly payday on the 31st', () => {
    const schedule = { frequency: 'monthly' as const, anchorDate: '2026-01-31' };
    const deposits = payDatesBetween(schedule, '2026-03-01', TODAY).map((date) => deposit(date, 4200, 'STATE PENSION FUND DIR DEP'));
    const [found] = findPaychecks(deposits, { today: TODAY });
    expect(found).toMatchObject({ frequency: 'monthly', anchorDate: '2026-08-31', nextDate: '2026-10-30' });
  });

  it('suggests one source for the total when a paycheck is split across two accounts', () => {
    const deposits = every(14, '2026-05-01').flatMap((date) => [deposit(date, 1500, undefined, { accountId: 1 }), deposit(date, 400, undefined, { accountId: 2 })]);
    const found = findPaychecks(deposits, { today: TODAY });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ netPayCents: 190000, accountId: null });
  });

  it('keeps two paychecks apart when both come through the same payroll company', () => {
    // Plaid names the payer "Gusto" for both; the descriptions name the employers.
    const yours = every(14, '2026-04-03').map((date) => deposit(date, 2143.18, 'ACME INC PAYROLL 8812', { merchant: 'GUSTO' }));
    const theirs = every(14, '2026-04-10').map((date) => deposit(date, 1210, 'RIVER CLINIC PAYROLL 1194', { merchant: 'GUSTO' }));
    const found = findPaychecks([...yours, ...theirs], { today: TODAY });
    expect(found.map((s) => `${s.matchText} ${s.frequency} ${s.netPayCents}`)).toEqual([
      'ACME INC PAYROLL biweekly 214318',
      'RIVER CLINIC PAYROLL biweekly 121000',
    ]);
  });

  it('splits one payer by amount when the descriptions are identical', () => {
    const big = every(14, '2026-04-03').map((date) => deposit(date, 2400, 'GUSTO PAY 123456'));
    const small = every(14, '2026-04-10').map((date) => deposit(date, 600, 'GUSTO PAY 654321'));
    const found = findPaychecks([...big, ...small], { today: TODAY });
    expect(found.map((s) => `${s.frequency} ${s.netPayCents}`)).toEqual(['biweekly 240000', 'biweekly 60000']);
  });

  it('skips interest, irregular deposits, and paychecks that stopped', () => {
    const interest = every(30, '2026-01-31').map((date) => deposit(date, 1.23, 'INTEREST PAYMENT'));
    const zelle = ['2026-05-03', '2026-05-29', '2026-07-14', '2026-08-02', '2026-09-21'].map((date, i) => deposit(date, 75 + i * 40, 'ZELLE FROM SAM'));
    const oldJob = every(14, '2026-01-02', '2026-06-26').map((date) => deposit(date, 1600, 'OLD JOB INC PAYROLL'));
    expect(findPaychecks([...interest, ...zelle, ...oldJob], { today: TODAY })).toEqual([]);
  });
});

describe('GET /income-sources/suggestions', () => {
  let db: TestD1;
  let env: Env;
  const YOU = 'you@example.com';
  const PARTNER = 'partner@example.com';

  beforeEach(() => {
    db = new TestD1();
    env = testEnv(db);
  });

  function paychecks(accountId: number, name: string, dollars: number, privateMemberId: number | null = null) {
    const today = todayIn('America/Chicago');
    for (let d = addDays(today, -150); d <= today; d = addDays(d, 14)) {
      db.exec(
        `INSERT INTO transactions (account_id, date, amount_cents, name, normalized_merchant, source, private_member_id)
         VALUES (?, ?, ?, ?, ?, 'plaid', ?)`,
        accountId, d, dollars * 100, name, normalizeMerchant(name), privateMemberId,
      );
    }
  }

  const suggestions = async (email: string) =>
    ((await (await api(env, 'GET', '/income-sources/suggestions', undefined, email)).json()) as { matchText: string; netPayCents: number }[]).map(
      (s) => `${s.matchText} ${s.netPayCents}`,
    );

  it('suggests your paychecks, keeps your partner’s private ones to them, and drops ones you already added', async () => {
    await api(env, 'GET', '/me', undefined, YOU);
    await api(env, 'GET', '/me', undefined, PARTNER);
    const partnerId = db.rows<{ id: number }>('SELECT id FROM members WHERE email = ?', PARTNER)[0]!.id;
    db.exec(`INSERT INTO accounts (name, type) VALUES ('Checking', 'checking')`);
    paychecks(1, 'ACME CORP PAYROLL ACH CREDIT', 2100);
    paychecks(1, 'SIDE GIG LLC DIRECT DEP', 300, partnerId);

    expect(await suggestions(YOU)).toEqual(['ACME CORP PAYROLL 210000']);
    expect(await suggestions(PARTNER)).toEqual(['ACME CORP PAYROLL 210000', 'SIDE GIG LLC 30000']);

    const today = todayIn('America/Chicago');
    const added = await api(env, 'POST', '/income-sources', {
      name: 'Acme', netPayCents: 210000, frequency: 'biweekly', anchorDate: today, matchText: 'ACME CORP PAYROLL',
    }, YOU);
    expect(added.status).toBe(201);
    expect(await suggestions(YOU)).toEqual([]);
  });
});

describe('bills finder', () => {
  it('keeps two subscriptions from the same merchant apart', () => {
    let id = 1;
    const charges = every(30, '2026-03-02').flatMap((date) => [
      { id: id++, date, amountCents: -99, merchant: 'APPLE COM BILL' },
      { id: id++, date: addDays(date, 4), amountCents: -999, merchant: 'APPLE COM BILL' },
    ]);
    const found = detectRecurring(charges, { today: TODAY });
    expect(found.map((s) => `${s.merchant} ${s.cadence} ${s.expectedAmountCents}`).sort()).toEqual([
      'APPLE COM BILL $1 monthly -99',
      'APPLE COM BILL monthly -999',
    ]);
  });

  describe('POST /recurring/detect', () => {
    let db: TestD1;
    let env: Env;

    beforeEach(async () => {
      db = new TestD1();
      env = testEnv(db);
      await api(env, 'GET', '/me');
      db.exec(`INSERT INTO accounts (name, type) VALUES ('Checking', 'checking')`);
    });

    const charge = (date: ISODate, cents: number, name: string) =>
      db.exec(
        `INSERT INTO transactions (account_id, date, amount_cents, name, normalized_merchant, source) VALUES (1, ?, ?, ?, ?, 'plaid')`,
        date, cents, name, normalizeMerchant(name),
      );
    const bills = () => db.rows<{ merchant: string; status: string }>('SELECT merchant, status FROM recurring_bills ORDER BY merchant');

    it('finds yearly bills from the full two years of history', async () => {
      const today = todayIn('America/Chicago');
      charge(addDays(today, -600), -13900, 'AMAZON PRIME MEMBERSHIP');
      charge(addDays(today, -235), -13900, 'AMAZON PRIME MEMBERSHIP');
      await api(env, 'POST', '/recurring/detect');
      expect(bills()).toEqual([{ merchant: 'AMAZON PRIME MEMBERSHIP', status: 'suggested' }]);
    });

    it('keeps a confirmed bill on the same subscription when another one from that merchant gets more charges', async () => {
      const today = todayIn('America/Chicago');
      // A $9.99 plan you confirmed, and a $0.99 plan that has been charging longer.
      for (let k = 1; k <= 4; k++) charge(addDays(today, -30 * k), -999, 'APPLE.COM/BILL');
      for (let k = 1; k <= 9; k++) charge(addDays(today, -30 * k - 3), -99, 'APPLE.COM/BILL');
      db.exec(
        `INSERT INTO recurring_bills (merchant, name, cadence, expected_amount_cents, status) VALUES (?, 'Apple', 'monthly', -999, 'confirmed')`,
        normalizeMerchant('APPLE.COM/BILL'),
      );
      await api(env, 'POST', '/recurring/detect');
      const rows = db.rows<{ status: string; cents: number }>(
        'SELECT status, expected_amount_cents AS cents FROM recurring_bills ORDER BY expected_amount_cents',
      );
      expect(rows).toEqual([
        { status: 'confirmed', cents: -999 },
        { status: 'suggested', cents: -99 },
      ]);
    });

    it('drops old suggestions that stopped, but keeps ones you confirmed or dismissed', async () => {
      db.exec(
        `INSERT INTO recurring_bills (merchant, name, cadence, expected_amount_cents, status) VALUES
           ('OLD GYM', 'Old Gym', 'monthly', -4000, 'suggested'),
           ('NETFLIX', 'Netflix', 'monthly', -1549, 'confirmed'),
           ('LOTTERY', 'Lottery', 'weekly', -200, 'dismissed')`,
      );
      await api(env, 'POST', '/recurring/detect');
      expect(bills()).toEqual([
        { merchant: 'LOTTERY', status: 'dismissed' },
        { merchant: 'NETFLIX', status: 'confirmed' },
      ]);
    });
  });
});

describe('marking a charge as a bill', () => {
  let db: TestD1;
  let env: Env;
  const YOU = 'you@example.com';
  const PARTNER = 'partner@example.com';

  beforeEach(async () => {
    db = new TestD1();
    env = testEnv(db);
    await api(env, 'GET', '/me', undefined, YOU);
    await api(env, 'GET', '/me', undefined, PARTNER);
    db.exec(`INSERT INTO accounts (name, type) VALUES ('Checking', 'checking')`);
  });

  const charge = (daysAgo: number, cents: number, name: string, privateMemberId: number | null = null) => {
    db.exec(
      `INSERT INTO transactions (account_id, date, amount_cents, name, normalized_merchant, source, private_member_id)
       VALUES (1, ?, ?, ?, ?, 'plaid', ?)`,
      addDays(todayIn('America/Chicago'), -daysAgo), cents, name, normalizeMerchant(name), privateMemberId,
    );
    return db.rows<{ id: number }>('SELECT MAX(id) AS id FROM transactions')[0]!.id;
  };
  const bills = () =>
    db.rows<{ merchant: string; cadence: string; cents: number; status: string; p: number | null }>(
      'SELECT merchant, cadence, expected_amount_cents AS cents, status, private_member_id AS p FROM recurring_bills ORDER BY merchant',
    );
  const mark = (id: number, body: Record<string, unknown>, email = YOU) => api(env, 'PUT', `/transactions/${id}/bill`, body, email);

  it('guesses how often and how much from the other charges, even when the amount changes', async () => {
    // An electric bill the finder skips: it swings more than 10% month to month.
    [80, 120, 95, 140].forEach((dollars, k) => charge(5 + 30 * k, -dollars * 100, 'CITY POWER & LIGHT AUTOPAY'));
    const id = charge(200, -9000, 'CITY POWER & LIGHT AUTOPAY');
    const res = (await (await api(env, 'GET', `/transactions/${id}/bill`, undefined, YOU)).json()) as { bill: unknown; guess: { cadence: string; amountCents: number } };
    expect(res.bill).toBeNull();
    expect(res.guess).toMatchObject({ cadence: 'monthly', amountCents: 9500 });
  });

  it('saves a confirmed bill under the key the finder uses, and the finder leaves it alone', async () => {
    for (let k = 0; k < 4; k++) charge(5 + 30 * k, -1549, 'NETFLIX.COM');
    const id = charge(130, -1549, 'NETFLIX.COM');
    expect((await mark(id, { isBill: true, cadence: 'monthly', amountCents: 1549 })).status).toBe(200);
    await api(env, 'POST', '/recurring/detect', undefined, YOU);
    expect(bills()).toEqual([{ merchant: normalizeMerchant('NETFLIX.COM'), cadence: 'monthly', cents: -1549, status: 'confirmed', p: null }]);
    // Upcoming bills see it.
    const row = db.rows<{ next: string }>('SELECT next_date AS next FROM recurring_bills')[0]!;
    expect(row.next > addDays(todayIn('America/Chicago'), -1)).toBe(true);
  });

  it('works for loan payments the finder skips as transfers', async () => {
    const id = charge(3, -38612, 'CAPITAL ONE AUTO PAYMENT');
    db.exec('UPDATE transactions SET transfer_pair_id = 999 WHERE id = ?', id);
    expect((await mark(id, { isBill: true, cadence: 'monthly', amountCents: 38612 })).status).toBe(200);
    expect(bills()).toHaveLength(1);
  });

  it('turning it off dismisses the bill so the finder won’t suggest it again', async () => {
    for (let k = 0; k < 4; k++) charge(5 + 30 * k, -1549, 'NETFLIX.COM');
    const id = charge(130, -1549, 'NETFLIX.COM');
    await mark(id, { isBill: true, cadence: 'monthly', amountCents: 1549 });
    await mark(id, { isBill: false });
    await api(env, 'POST', '/recurring/detect', undefined, YOU);
    expect(bills().map((b) => b.status)).toEqual(['dismissed']);
  });

  it('keeps a second subscription from the same merchant separate', async () => {
    const big = charge(4, -999, 'APPLE.COM/BILL');
    const small = charge(9, -99, 'APPLE.COM/BILL');
    await mark(big, { isBill: true, cadence: 'monthly', amountCents: 999 });
    expect((await mark(small, { isBill: true, cadence: 'monthly', amountCents: 99 })).status).toBe(200);
    expect(bills().map((b) => `${b.merchant} ${b.cents}`)).toEqual(['APPLE COM BILL -999', 'APPLE COM BILL $1 -99']);
  });

  it('turning it off works even after you changed the usual amount', async () => {
    const id = charge(3, -9000, 'CITY WATER UTIL');
    const saved = (await (await mark(id, { isBill: true, cadence: 'monthly', amountCents: 20000 })).json()) as { bill: { id: number } };
    await mark(id, { isBill: false, billId: saved.bill.id });
    expect(bills().map((b) => b.status)).toEqual(['dismissed']);
  });

  it('a bill that swings a lot stays one bill', async () => {
    const low = charge(40, -4500, 'CITY WATER UTIL');
    const high = charge(10, -11000, 'CITY WATER UTIL');
    await mark(low, { isBill: true, cadence: 'monthly', amountCents: 4500 });
    const res = (await (await api(env, 'GET', `/transactions/${high}/bill`, undefined, YOU)).json()) as { bill: { status: string } | null };
    expect(res.bill?.status).toBe('confirmed');
    await mark(high, { isBill: true, cadence: 'monthly', amountCents: 7500 });
    expect(bills()).toEqual([expect.objectContaining({ merchant: normalizeMerchant('CITY WATER UTIL'), cents: -7500 })]);
  });

  it('needs to be told whether it is a bill', async () => {
    const id = charge(3, -1549, 'NETFLIX.COM');
    await mark(id, { isBill: true, cadence: 'monthly', amountCents: 1549 });
    expect((await mark(id, {})).status).toBe(400);
    expect(bills().map((b) => b.status)).toEqual(['confirmed']);
  });

  it('marking your fun money charge leaves the shared bill from that merchant shared', async () => {
    const you = db.rows<{ id: number }>('SELECT id FROM members WHERE email = ?', YOU)[0]!.id;
    await mark(charge(20, -1599, 'HULU'), { isBill: true, cadence: 'monthly', amountCents: 1599 });
    await mark(charge(5, -1599, 'HULU', you), { isBill: true, cadence: 'monthly', amountCents: 1599 });
    expect(bills().map((b) => `${b.merchant} ${b.p === null ? 'shared' : 'private'}`)).toEqual(['HULU shared', 'HULU $16 private']);
  });

  it('a fun money charge makes a private bill, and your partner can’t mark it', async () => {
    const you = db.rows<{ id: number }>('SELECT id FROM members WHERE email = ?', YOU)[0]!.id;
    const id = charge(2, -1099, 'SPOTIFY USA', you);
    expect((await mark(id, { isBill: true, cadence: 'monthly', amountCents: 1099 }, PARTNER)).status).toBe(404);
    await mark(id, { isBill: true, cadence: 'monthly', amountCents: 1099 });
    expect(bills()).toEqual([expect.objectContaining({ status: 'confirmed', p: you })]);
    const partnerSees = (await (await api(env, 'GET', '/recurring', undefined, PARTNER)).json()) as unknown[];
    expect(partnerSees).toEqual([]);
  });
});

describe('bills finder with changing amounts', () => {
  it('finds a monthly utility bill whose amount swings, but not weekly grocery runs', () => {
    let id = 1;
    const power = [82, 131, 96, 148, 117, 88].map((dollars, k) => ({ id: id++, date: addDays(TODAY, -5 - 30 * k), amountCents: -dollars * 100, merchant: 'CITY POWER' }));
    const groceries = [64, 91, 120, 75, 102, 58, 88, 110].map((dollars, k) => ({ id: id++, date: addDays(TODAY, -2 - 7 * k), amountCents: -dollars * 100, merchant: 'KROGER' }));
    const found = detectRecurring([...power, ...groceries], { today: TODAY });
    expect(found.map((s) => `${s.merchant} ${s.cadence}`)).toEqual(['CITY POWER monthly']);
  });
});

describe('finders on real-world rhythms', () => {
  const at = (gaps: number[], start: ISODate) => gaps.reduce<ISODate[]>((dates, gap) => [...dates, addDays(dates[dates.length - 1]!, gap)], [start]);
  const charges = (dates: ISODate[], cents: number | number[], merchant: string, from = 1) =>
    dates.map((date, i) => ({ id: from + i, date, amountCents: Array.isArray(cents) ? cents[i]! : cents, merchant }));

  it('finds a weekly paycheck after a few weeks, before two months of history', () => {
    const [found] = findPaychecks(every(7, addDays(TODAY, -45)).map((date) => deposit(date, 1450.25, 'DIRECT DEPOSIT ACME PAYROLL')), { today: TODAY });
    expect(found).toMatchObject({ frequency: 'weekly', netPayCents: 145025 });
  });

  it('finds a phone bill paid by hand: a week late, then early', () => {
    const dates = at([31, 29, 31, 45, 36, 24, 17], addDays(TODAY, -240));
    const found = detectRecurring(charges(dates, [-8500, -8500, -8500, -7300, -7900, -9100, -8200, -8000], 'PHONE CO'), { today: TODAY });
    expect(found.map((s) => `${s.merchant} ${s.cadence}`)).toEqual(['PHONE CO monthly']);
  });

  it('finds a loan payment with months paid from somewhere else', () => {
    const dates = at([30, 29, 32, 124, 35], addDays(TODAY, -265));
    expect(detectRecurring(charges(dates, -8650, 'LOAN SERVICER'), { today: TODAY }).map((s) => s.cadence)).toEqual(['monthly']);
  });

  it('finds a mortgage that is steady lately after a messy stretch', () => {
    const dates = at([14, 14, 14, 14, 182, 14, 44, 26, 28, 18, 13, 12, 14, 14], addDays(TODAY, -436));
    expect(detectRecurring(charges(dates, -61000, 'HOME LOANS'), { today: TODAY }).map((s) => s.cadence)).toEqual(['biweekly']);
  });

  it('still skips places you just go often', () => {
    const pizza = charges(at([12, 8, 16, 21, 13, 1, 12, 15, 9], addDays(TODAY, -110)), -2400, 'PIZZA PLACE');
    const burgers = charges(at([24, 35, 30, 16, 23, 3, 2, 24, 35, 30], addDays(TODAY, -225)), -1250, 'BURGER PLACE', 100);
    expect(detectRecurring([...pizza, ...burgers], { today: TODAY })).toEqual([]);
  });
});
