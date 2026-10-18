import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/worker/env';
import { parseSearch } from '../src/shared/search';
import { api } from './helpers/api';
import { TestD1 } from './helpers/d1';
import { testEnv } from './helpers/plaid';

const YOU = 'you@example.com';
const PARTNER = 'partner@example.com';

type Txn = { id: number; name: string; amountCents: number; categoryId: number | null; kidId: number | null; isPrivate: boolean; isIgnored: boolean };
type Page = { transactions: Txn[]; hasMore: boolean; totals: { count: number; outCents: number; inCents: number } };

let db: TestD1;
let env: Env;
let you: number;
let partner: number;

const cat = (name: string) => db.rows<{ id: number }>('SELECT id FROM categories WHERE name = ? AND fun_member_id IS NULL', name)[0]!.id;
const funOf = (memberId: number) => db.rows<{ id: number }>('SELECT id FROM categories WHERE fun_member_id = ?', memberId)[0]!.id;

interface Seed {
  name: string;
  cents: number;
  merchant?: string | null;
  normalized?: string | null;
  memo?: string | null;
  notes?: string | null;
  categoryId?: number | null;
  source?: string | null;
  privateTo?: number | null;
  date?: string;
  ignored?: boolean;
  kidId?: number | null;
}

/** `cents` is the charge as the bank shows it: negative is money out. */
function add(s: Seed) {
  db.exec(
    `INSERT INTO transactions (account_id, date, amount_cents, name, merchant_name, normalized_merchant, memo, notes, source,
       category_id, category_source, private_member_id, is_ignored, kid_id)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, 'plaid', ?, ?, ?, ?, ?)`,
    s.date ?? '2026-10-05',
    s.cents,
    s.name,
    s.merchant ?? null,
    s.normalized ?? null,
    s.memo ?? null,
    s.notes ?? null,
    s.categoryId ?? null,
    s.source ?? (s.categoryId ? 'auto' : null),
    s.privateTo ?? null,
    s.ignored ? 1 : 0,
    s.kidId ?? null,
  );
  return db.rows<{ id: number }>('SELECT MAX(id) AS id FROM transactions')[0]!.id;
}

async function search(query: string, email = YOU): Promise<Page> {
  const res = await api(env, 'GET', `/transactions${query ? `?${query}` : ''}`, undefined, email);
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
}
const ids = (page: Page) => page.transactions.map((t) => t.id).sort((a, b) => a - b);
const q = (text: string) => `q=${encodeURIComponent(text)}`;

beforeEach(async () => {
  db = new TestD1();
  env = testEnv(db);
  await api(env, 'GET', '/me', undefined, YOU);
  await api(env, 'GET', '/me', undefined, PARTNER);
  const member = (email: string) => db.rows<{ id: number }>('SELECT id FROM members WHERE email = ?', email)[0]!.id;
  you = member(YOU);
  partner = member(PARTNER);
  db.exec(`INSERT INTO accounts (name, type) VALUES ('Card', 'credit')`);
});

describe('reading a search', () => {
  it('splits size filters from text and reads amounts', () => {
    expect(parseSearch('shell')).toEqual({ text: 'shell', amount: null, minCents: null, maxCents: null });
    expect(parseSearch('45')).toEqual({ text: '45', amount: { minCents: 4500, maxCents: 4599 }, minCents: null, maxCents: null });
    expect(parseSearch('45.12')).toEqual({ text: '45.12', amount: { minCents: 4512, maxCents: 4512 }, minCents: null, maxCents: null });
    expect(parseSearch('$45.1')).toEqual({ text: '$45.1', amount: { minCents: 4510, maxCents: 4510 }, minCents: null, maxCents: null });
    expect(parseSearch('$1,200')).toEqual({ text: '$1,200', amount: { minCents: 120000, maxCents: 120099 }, minCents: null, maxCents: null });
    expect(parseSearch('>100')).toEqual({ text: '', amount: null, minCents: 10001, maxCents: null });
    expect(parseSearch('>=100')).toEqual({ text: '', amount: null, minCents: 10000, maxCents: null });
    expect(parseSearch('<$20')).toEqual({ text: '', amount: null, minCents: null, maxCents: 1999 });
    expect(parseSearch('<=20.50')).toEqual({ text: '', amount: null, minCents: null, maxCents: 2050 });
    expect(parseSearch('  Shell  >30 <50 ')).toEqual({ text: 'Shell', amount: null, minCents: 3001, maxCents: 4999 });
    expect(parseSearch('')).toEqual({ text: '', amount: null, minCents: null, maxCents: null });
  });
});

describe('searching activity', () => {
  it('finds text in the description, memo, merchant, normalized merchant, notes and category name, any case', async () => {
    const byName = add({ name: 'SQ *BLUE BOTTLE 0412', cents: -650 });
    const byMemo = add({ name: 'POS DEBIT', memo: 'blue bottle oakland', cents: -700 });
    const byMerchant = add({ name: 'PURCHASE 1123', merchant: 'Blue Bottle Coffee', cents: -800 });
    const byKey = add({ name: 'PURCHASE 1124', normalized: 'BLUE BOTTLE', cents: -900 });
    const byNotes = add({ name: 'VENMO', notes: 'paid back for blue bottle', cents: -1000 });
    add({ name: 'KROGER', cents: -5000 });
    expect(ids(await search(q('Blue Bottle')))).toEqual([byName, byMemo, byMerchant, byKey, byNotes]);

    const gas = cat('Gas');
    const filed = add({ name: 'SHELL OIL', cents: -4000, categoryId: gas });
    const split = add({ name: 'COSTCO WHSE', cents: -9000 });
    db.exec('UPDATE transactions SET is_split = 1 WHERE id = ?', split);
    db.exec('INSERT INTO splits (transaction_id, category_id, amount_cents) VALUES (?, ?, -4000), (?, ?, -5000)', split, gas, split, cat('Groceries'));
    expect(ids(await search(q('gAs')))).toEqual([filed, split]);
  });

  it('treats % and _ as plain characters', async () => {
    add({ name: 'ANYTHING', cents: -100 });
    const pct = add({ name: '50% OFF SALE', cents: -200 });
    expect(ids(await search(q('%')))).toEqual([pct]);
    expect(ids(await search(q('_')))).toEqual([]);
  });

  it('a number matches charges of that amount, either sign, and text that contains it', async () => {
    const out = add({ name: 'DINER', cents: -4500 });
    const outCents = add({ name: 'DINER', cents: -4512 });
    const refund = add({ name: 'REFUND', cents: 4512 });
    const store45 = add({ name: 'WALGREENS #45', cents: -1299 });
    add({ name: 'DINER', cents: -4600 });
    add({ name: 'DINER', cents: -450 });
    expect(ids(await search(q('45')))).toEqual([out, outCents, refund, store45]);
    expect(ids(await search(q('45.12')))).toEqual([outCents, refund]);
    expect(ids(await search(q('$45.12')))).toEqual([outCents, refund]);
    expect(ids(await search(q('$45.00')))).toEqual([out]);
  });

  it('>100 and <20 filter by size; minCents and maxCents too, inclusive', async () => {
    const big = add({ name: 'RENT', cents: -150000 });
    const hundred = add({ name: 'GIFT', cents: -10000 });
    const pay = add({ name: 'PAYROLL', cents: 250000 });
    const small = add({ name: 'SHELL OIL', cents: -1500 });
    const twenty = add({ name: 'SHELL OIL', cents: -2000 });
    const mid = add({ name: 'SHELL OIL', cents: -4000 });
    expect(ids(await search(q('>100')))).toEqual([big, pay]);
    expect(ids(await search(q('>=100')))).toEqual([big, hundred, pay]);
    expect(ids(await search(q('<20')))).toEqual([small]);
    expect(ids(await search(q('shell >19.99')))).toEqual([twenty, mid]);
    expect(ids(await search('minCents=2000&maxCents=10000'))).toEqual([hundred, twenty, mid]);
    expect(ids(await search(`minCents=2000&maxCents=10000&${q('<50')}`))).toEqual([twenty, mid]);
    expect((await api(env, 'GET', '/transactions?minCents=abc')).status).toBe(400);
    expect((await api(env, 'GET', '/transactions?maxCents=-1')).status).toBe(400);
  });

  it('several categories at once, by repeating categoryId or with commas, split parts included', async () => {
    const gas = cat('Gas');
    const groceries = cat('Groceries');
    const a = add({ name: 'SHELL', cents: -4000, categoryId: gas });
    const b = add({ name: 'KROGER', cents: -6000, categoryId: groceries });
    add({ name: 'TARGET', cents: -2000, categoryId: cat('Shopping') });
    const split = add({ name: 'COSTCO', cents: -9000 });
    db.exec('UPDATE transactions SET is_split = 1 WHERE id = ?', split);
    db.exec('INSERT INTO splits (transaction_id, category_id, amount_cents) VALUES (?, ?, -9000)', split, groceries);
    expect(ids(await search(`categoryId=${gas}&categoryId=${groceries}`))).toEqual([a, b, split]);
    expect(ids(await search(`categoryId=${gas},${groceries}`))).toEqual([a, b, split]);
    expect(ids(await search(`categoryId=${gas}`))).toEqual([a]);
    expect((await api(env, 'GET', '/transactions?categoryId=x')).status).toBe(400);
  });

  it('totals cover the whole result, not just the page', async () => {
    for (let i = 0; i < 5; i++) add({ name: 'SHELL OIL', cents: -1000 - i, date: `2026-10-0${i + 1}` });
    add({ name: 'SHELL REWARDS', cents: 500 });
    add({ name: 'KROGER', cents: -99999 });
    add({ name: 'SHELL OIL', cents: -7777, ignored: true });
    add({ name: 'SHELL OIL', cents: -3333, date: '2026-09-30' });
    const page = await search(`${q('shell')}&month=2026-10&limit=2`);
    expect(page.transactions).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.totals).toEqual({ count: 6, outCents: 5010, inCents: 500 });
    expect((await search(`${q('shell')}&month=2026-10&ignored=1`)).totals).toEqual({ count: 7, outCents: 12787, inCents: 500 });
    expect((await search(q('nothing like this'))).totals).toEqual({ count: 0, outCents: 0, inCents: 0 });
  });

  it('privacy: a partner’s private charge is never found or counted', async () => {
    const mine = add({ name: 'BOOKSHOP', cents: -2500, privateTo: you, categoryId: funOf(you) });
    const theirs = add({ name: 'BOOKSHOP', cents: -4000, privateTo: partner, categoryId: funOf(partner) });
    const shared = add({ name: 'BOOKSHOP', cents: -1000 });
    const page = await search(q('bookshop'));
    expect(ids(page)).toEqual([mine, shared]);
    expect(page.totals).toEqual({ count: 2, outCents: 3500, inCents: 0 });
    expect(ids(await search(q('40')))).toEqual([]);
    expect(ids(await search(`categoryId=${funOf(partner)}`))).toEqual([]);
    expect(ids(await search(q('bookshop'), PARTNER))).toEqual([theirs, shared]);
  });
});
