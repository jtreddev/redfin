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
