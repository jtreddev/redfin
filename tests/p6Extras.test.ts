import { beforeEach, describe, expect, it } from 'vitest';
import { splitAmounts } from '../src/client/format';
import { wentUp } from '../src/shared/billIncrease';
import { addDays, todayIn } from '../src/shared/dates';
import { normalizeMerchant } from '../src/shared/rules';
import { isSubscription, subscriptionCost } from '../src/shared/subscriptions';
import type { Env } from '../src/worker/env';
import { api } from './helpers/api';
import { TestD1 } from './helpers/d1';
import { testEnv } from './helpers/plaid';

const YOU = 'you@example.com';
const PARTNER = 'partner@example.com';

let db: TestD1;
let env: Env;
let you: number;

beforeEach(async () => {
  db = new TestD1();
  env = testEnv(db);
  await api(env, 'GET', '/me', undefined, YOU);
  await api(env, 'GET', '/me', undefined, PARTNER);
  you = db.rows<{ id: number }>('SELECT id FROM members WHERE email = ?', YOU)[0]!.id;
  db.exec(`INSERT INTO accounts (name, type) VALUES ('Checking', 'checking')`);
});

const json = async <T = any>(res: Response) => (await res.json()) as T;
const today = () => todayIn('America/Chicago');

/** A confirmed monthly bill, `cents` positive (stored negative, as detection does). */
function bill(name: string, cents: number, extra: { merchant?: string; cadence?: string; categoryId?: number | null; privateMemberId?: number | null; status?: string } = {}) {
  db.exec(
    `INSERT INTO recurring_bills (merchant, name, cadence, expected_amount_cents, status, category_id, private_member_id, last_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    extra.merchant ?? normalizeMerchant(name),
    name,
    extra.cadence ?? 'monthly',
    -cents,
    extra.status ?? 'confirmed',
    extra.categoryId ?? null,
    extra.privateMemberId ?? null,
    addDays(today(), -3),
  );
  return db.rows<{ id: number }>('SELECT MAX(id) AS id FROM recurring_bills')[0]!.id;
}

function charge(daysAgo: number, cents: number, name: string, privateMemberId: number | null = null) {
  db.exec(
    `INSERT INTO transactions (account_id, date, amount_cents, name, normalized_merchant, source, private_member_id)
     VALUES (1, ?, ?, ?, ?, 'plaid', ?)`,
    addDays(today(), -daysAgo),
    -cents,
    name,
    normalizeMerchant(name),
    privateMemberId,
  );
}

type Increase = { billId: number; name: string; usualCents: number; latestCents: number; date: string };
const increases = async (email = YOU) => (await json<{ billIncreases: Increase[] }>(await api(env, 'GET', '/home', undefined, email))).billIncreases;
const act = (id: number, action: string, email = YOU) => api(env, 'POST', `/bills/${id}/increase`, { action }, email);
const categoryId = (name: string) => db.rows<{ id: number }>('SELECT id FROM categories WHERE name = ? AND archived = 0', name)[0]!.id;

describe('bill went up', () => {
  it('flags a confirmed bill whose latest charge is at least $5 and 10% more', async () => {
    const id = bill('Internet Co', 6000);
    charge(35, 6000, 'Internet Co');
    charge(4, 7500, 'Internet Co');
    expect(await increases()).toEqual([{ billId: id, name: 'Internet Co', usualCents: 6000, latestCents: 7500, date: addDays(today(), -4) }]);
  });

  it('wentUp: both thresholds, in whole cents', () => {
    expect(wentUp(2000, 2499)).toBe(false);
    expect(wentUp(2000, 2500)).toBe(true);
    expect(wentUp(10000, 10990)).toBe(false);
    expect(wentUp(10000, 11000)).toBe(true);
    expect(wentUp(6000, 5000)).toBe(false);
  });

  it('needs at least $5 more: $4.99 is not enough, $5.00 is', async () => {
    bill('Music App', 2000);
    charge(2, 2499, 'Music App');
    expect(await increases()).toEqual([]);
    charge(1, 2500, 'Music App');
    expect((await increases()).map((i) => i.latestCents)).toEqual([2500]);
  });

  it('needs at least 10% more: 9.9% is not enough, 10% is', async () => {
    bill('Power Co', 10000);
    charge(2, 10990, 'Power Co');
    expect(await increases()).toEqual([]);
    charge(1, 11000, 'Power Co');
    expect((await increases()).map((i) => i.latestCents)).toEqual([11000]);
  });

  it('only looks at the last 45 days, and only at the latest charge', async () => {
    bill('Gym Place', 4000);
    charge(46, 6000, 'Gym Place');
    expect(await increases()).toEqual([]);
    // Went up, then came back down: nothing to flag.
    charge(20, 6000, 'Gym Place');
    charge(3, 4000, 'Gym Place');
    expect(await increases()).toEqual([]);
  });

  it('ignores suggested and dismissed bills, and charges that are a different bill (more than double)', async () => {
    bill('Stream One', 1000, { status: 'suggested' });
    charge(2, 1500, 'Stream One');
    bill('Stream Two', 1000, { status: 'dismissed' });
    charge(2, 1500, 'Stream Two');
    bill('Stream Three', 1000);
    charge(2, 2500, 'Stream Three');
    expect(await increases()).toEqual([]);
  });

  it('matches a second subscription from the same merchant by its own amount', async () => {
    const merchant = normalizeMerchant('APPLE.COM/BILL');
    bill('Apple big', 4000, { merchant });
    const small = bill('Apple small', 1000, { merchant: `${merchant} $10` });
    charge(5, 4000, 'APPLE.COM/BILL');
    charge(3, 1600, 'APPLE.COM/BILL');
    expect((await increases()).map((i) => [i.billId, i.latestCents])).toEqual([[small, 1600]]);
  });

  it('dismiss hides it until a bigger charge comes', async () => {
    const id = bill('Internet Co', 6000);
    charge(30, 7500, 'Internet Co');
    expect((await act(id, 'dismiss')).status).toBe(200);
    expect(await increases()).toEqual([]);
    expect(db.rows('SELECT increase_seen_cents AS seen, expected_amount_cents AS cents FROM recurring_bills')).toEqual([{ seen: 7500, cents: -6000 }]);
    charge(2, 7500, 'Internet Co');
    expect(await increases()).toEqual([]);
    charge(1, 8000, 'Internet Co');
    expect((await increases()).map((i) => i.latestCents)).toEqual([8000]);
  });

  it('update makes the latest charge the usual amount', async () => {
    const id = bill('Internet Co', 6000);
    charge(4, 7500, 'Internet Co');
    expect((await act(id, 'update')).status).toBe(200);
    expect(db.rows('SELECT expected_amount_cents AS cents FROM recurring_bills')).toEqual([{ cents: -7500 }]);
    expect(await increases()).toEqual([]);
    // A second time there's nothing to act on.
    expect((await act(id, 'update')).status).toBe(409);
    expect((await act(id, 'shrug')).status).toBe(400);
  });

  it('GET /recurring shows the increase on the bill', async () => {
    const id = bill('Internet Co', 6000);
    bill('Calm Bill', 3000);
    charge(4, 7500, 'Internet Co');
    const rows = await json<{ id: number; increase: { latestCents: number; date: string } | null }[]>(await api(env, 'GET', '/recurring'));
    expect(rows.find((r) => r.id === id)!.increase).toEqual({ latestCents: 7500, date: addDays(today(), -4) });
    expect(rows.find((r) => r.id !== id)!.increase).toBeNull();
  });

  it('keeps private bills private, and a private charge never moves a shared bill', async () => {
    const mine = bill('Game Pass', 1500, { privateMemberId: you });
    charge(3, 2000, 'Game Pass', you);
    const shared = bill('Internet Co', 6000);
    // Your own fun-money charge at the same place is not the household's bill.
    charge(2, 9000, 'Internet Co', you);
    expect((await increases(YOU)).map((i) => i.billId)).toEqual([mine]);
    expect(await increases(PARTNER)).toEqual([]);
    expect((await act(mine, 'update', PARTNER)).status).toBe(404);
    expect((await act(shared, 'update', YOU)).status).toBe(409);
    expect(db.rows('SELECT expected_amount_cents AS cents FROM recurring_bills WHERE id = ?', shared)).toEqual([{ cents: -6000 }]);
  });
});

describe('subscriptions', () => {
  it('counts confirmed monthly or yearly bills of $50 or less outside the core household bills', () => {
    const base = { status: 'confirmed', cadence: 'monthly', expectedAmountCents: -1599, categoryName: null, parentCategoryName: null };
    expect(isSubscription(base)).toBe(true);
    expect(isSubscription({ ...base, expectedAmountCents: -5000 })).toBe(true);
    expect(isSubscription({ ...base, expectedAmountCents: -5001 })).toBe(false);
    expect(isSubscription({ ...base, cadence: 'yearly', expectedAmountCents: -4900 })).toBe(true);
    expect(isSubscription({ ...base, cadence: 'yearly', expectedAmountCents: -13900 })).toBe(true);
    expect(isSubscription({ ...base, cadence: 'yearly', expectedAmountCents: -60100 })).toBe(false);
    expect(isSubscription({ ...base, cadence: 'weekly' })).toBe(false);
    expect(isSubscription({ ...base, status: 'suggested' })).toBe(false);
    expect(isSubscription({ ...base, categoryName: 'Phone' })).toBe(false);
    expect(isSubscription({ ...base, categoryName: 'Streaming', parentCategoryName: 'Subscriptions' })).toBe(true);
    expect(isSubscription({ ...base, categoryName: 'Water', parentCategoryName: 'Utilities' })).toBe(false);
  });

  it('costs a month and a year, a yearly one by its twelfth', () => {
    expect(subscriptionCost({ cadence: 'monthly', expectedAmountCents: -1599 })).toEqual({ monthCents: 1599, yearCents: 19188 });
    expect(subscriptionCost({ cadence: 'yearly', expectedAmountCents: -4800 })).toEqual({ monthCents: 400, yearCents: 4800 });
  });

  it('GET /recurring?subscriptions=1 lists only them, with private ones only for their owner', async () => {
    const stream = bill('Stream Co', 1599, { categoryId: categoryId('Subscriptions') });
    const yearly = bill('Cloud Box', 4800, { cadence: 'yearly' });
    const mine = bill('Game Pass', 1500, { privateMemberId: you });
    bill('Phone Co', 4500, { categoryId: categoryId('Phone') });
    bill('Gym Big', 8000);
    bill('Weekly Box', 1000, { cadence: 'weekly' });
    bill('Maybe Sub', 900, { status: 'suggested' });
    const ids = async (email: string) =>
      (await json<{ id: number }[]>(await api(env, 'GET', '/recurring?subscriptions=1', undefined, email))).map((b) => b.id).sort((a, b) => a - b);
    expect(await ids(YOU)).toEqual([stream, yearly, mine]);
    expect(await ids(PARTNER)).toEqual([stream, yearly]);
  });
});

describe('hide amounts', () => {
  it('is off by default and saved per person through the prefs route', async () => {
    expect((await json(await api(env, 'GET', '/me', undefined, YOU))).viewer.hideAmounts).toBe(false);
    expect((await api(env, 'PATCH', '/me/prefs', { hideAmounts: true }, YOU)).status).toBe(200);
    expect((await json(await api(env, 'GET', '/me', undefined, YOU))).viewer).toMatchObject({ hideAmounts: true, hideSetup: false, powerTools: false });
    expect((await json(await api(env, 'GET', '/me', undefined, PARTNER))).viewer.hideAmounts).toBe(false);
    await api(env, 'PATCH', '/me/prefs', { hideAmounts: false }, YOU);
    expect((await json(await api(env, 'GET', '/me', undefined, YOU))).viewer.hideAmounts).toBe(false);
    expect((await api(env, 'PATCH', '/me/prefs', { hideAmounts: 1 }, YOU)).status).toBe(400);
  });
});

describe('amounts in a helper’s sentence', () => {
  it('splits out each dollar amount, so each can show as Money', () => {
    expect(splitAmounts('3 charges · $1,412.60 out · -$5 in')).toEqual(['3 charges · ', '$1,412.60', ' out · ', '-$5', ' in']);
    expect(splitAmounts('Over by $40')).toEqual(['Over by ', '$40', '']);
    expect(splitAmounts('No budget set')).toEqual(['No budget set']);
  });
});
