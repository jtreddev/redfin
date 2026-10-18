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

  it('with sub-categories: a parent covers its children (charges and split parts) alongside other picked categories', async () => {
    const shopping = cat('Shopping');
    const groceries = cat('Groceries');
    const res = await api(env, 'POST', '/categories', { parentId: shopping, name: 'Clothes' });
    expect(res.status).toBe(201);
    const clothes = ((await res.json()) as { id: number }).id;
    const inParent = add({ name: 'TARGET', cents: -2000, categoryId: shopping });
    const inChild = add({ name: 'GAP', cents: -4000, categoryId: clothes });
    const other = add({ name: 'KROGER', cents: -6000, categoryId: groceries });
    add({ name: 'SHELL', cents: -3000, categoryId: cat('Gas') });
    const split = add({ name: 'COSTCO', cents: -9000 });
    db.exec('UPDATE transactions SET is_split = 1 WHERE id = ?', split);
    db.exec('INSERT INTO splits (transaction_id, category_id, amount_cents) VALUES (?, ?, -9000)', split, clothes);

    expect(ids(await search(`categoryId=${shopping}`))).toEqual([inParent, inChild, split]);
    expect(ids(await search(`categoryId=${clothes}`))).toEqual([inChild, split]);
    expect(ids(await search(`categoryId=${shopping},${groceries}`))).toEqual([inParent, inChild, other, split]);
    expect(ids(await search(`categoryId=${shopping}&categoryId=${clothes}`))).toEqual([inParent, inChild, split]);
    expect((await search(`categoryId=${shopping},${groceries}`)).totals).toEqual({ count: 4, outCents: 21000, inCents: 0 });

    // Bulk set to the child: the parent's filter finds them, the child's too.
    const loose = add({ name: 'OLD NAVY', cents: -1500 });
    const bulked = await api(env, 'POST', '/transactions/bulk', { ids: [loose, other], set: { categoryId: clothes } });
    expect(bulked.status).toBe(200);
    expect(ids(await search(`categoryId=${clothes}`))).toEqual([inChild, other, loose, split].sort((x, y) => x - y));
    expect(ids(await search(`categoryId=${shopping}`))).toEqual([inParent, inChild, other, loose, split].sort((x, y) => x - y));
  });

  it('with sub-categories: the similar-count preview and "also file" agree for a child category', async () => {
    const shopping = cat('Shopping');
    const res = await api(env, 'POST', '/categories', { parentId: shopping, name: 'Clothes' });
    const clothes = ((await res.json()) as { id: number }).id;
    const picked = add({ name: 'UNIQLO 0412', merchant: 'Uniqlo', cents: -2500 });
    const others = [add({ name: 'UNIQLO 0413', merchant: 'Uniqlo', cents: -3500 }), add({ name: 'UNIQLO 0414', merchant: 'Uniqlo', cents: -4500, categoryId: shopping })];
    add({ name: 'UNIQLO 0415', merchant: 'Uniqlo', cents: -1500, categoryId: clothes });

    const preview = await api(env, 'GET', `/transactions/${picked}/similar?categoryId=${clothes}`);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ count: 2 });

    // A one-off pick moves just the one; "also file" then moves the two the preview counted.
    expect((await api(env, 'PATCH', `/transactions/${picked}`, { categoryId: clothes })).status).toBe(200);
    expect(db.rows<{ n: number }>('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?', clothes)[0]!.n).toBe(2);
    const fixed = await api(env, 'PATCH', `/transactions/${picked}`, { categoryId: clothes, alsoSimilar: true });
    expect(fixed.status).toBe(200);
    expect(((await fixed.json()) as { move: { moved: number } | null }).move).toMatchObject({ moved: 2 });
    for (const id of others) expect(db.rows<{ c: number }>('SELECT category_id AS c FROM transactions WHERE id = ?', id)[0]!.c).toBe(clothes);
    expect(ids(await search(`categoryId=${shopping}`))).toHaveLength(4);
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

describe('changing many charges at once', () => {
  type Bulk = { updated: number; skipped: number; moveId: number | null };
  const state = (id: number) =>
    db.rows<{
      category_id: number | null;
      category_source: string | null;
      category_reason: string | null;
      rule_id: number | null;
      kid_id: number | null;
      private_member_id: number | null;
      is_ignored: number;
    }>('SELECT category_id, category_source, category_reason, rule_id, kid_id, private_member_id, is_ignored FROM transactions WHERE id = ?', id)[0]!;
  async function bulk(body: unknown, email = YOU): Promise<Bulk> {
    const res = await api(env, 'POST', '/transactions/bulk', body, email);
    expect(res.status).toBe(200);
    return (await res.json()) as Bulk;
  }
  const undo = (moveId: number, email = YOU) => api(env, 'POST', `/category-moves/${moveId}/undo`, {}, email);
  const kid = () => {
    db.exec(`INSERT INTO kids (name) VALUES ('Kid A')`);
    return db.rows<{ id: number }>('SELECT MAX(id) AS id FROM kids')[0]!.id;
  };
  function ruled(s: Seed) {
    db.exec(`INSERT INTO rules (position, match_text, category_id) VALUES (1, 'X', ?)`, s.categoryId ?? null);
    const ruleId = db.rows<{ id: number }>('SELECT MAX(id) AS id FROM rules')[0]!.id;
    const id = add({ ...s, source: 'rule' });
    db.exec(`UPDATE transactions SET rule_id = ?, category_reason = 'Matched a rule' WHERE id = ?`, ruleId, id);
    return id;
  }

  it('sets a category on every picked charge, pins it, and one Undo puts everything back', async () => {
    const shopping = cat('Shopping');
    const gifts = cat('Gifts');
    const a = ruled({ name: 'TARGET', cents: -2000, categoryId: shopping });
    const b = add({ name: 'AMAZON', cents: -3000 });
    const c = add({ name: 'ETSY', cents: -4000, categoryId: cat('Groceries'), source: 'user' });
    const untouched = add({ name: 'KROGER', cents: -5000, categoryId: shopping });
    const before = [a, b, c, untouched].map(state);

    const res = await bulk({ ids: [a, b, c], set: { categoryId: gifts } });
    expect(res).toMatchObject({ updated: 3, skipped: 0 });
    for (const id of [a, b, c]) expect(state(id)).toMatchObject({ category_id: gifts, category_source: 'user', category_reason: null, rule_id: null });
    expect(state(untouched)).toEqual(before[3]);
    // A one-off: nothing is learned.
    expect(db.rows('SELECT id FROM rules WHERE learned = 1')).toEqual([]);

    expect((await undo(res.moveId!)).status).toBe(200);
    expect([a, b, c, untouched].map(state)).toEqual(before);
  });

  it('kid and "leave out" too, and Undo restores them', async () => {
    const k = kid();
    const ids = [add({ name: 'DAYCARE', cents: -50000, categoryId: cat('Childcare') }), add({ name: 'SHOES', cents: -6000 })];
    const before = ids.map(state);
    const res = await bulk({ ids, set: { kidId: k, isIgnored: true } });
    expect(res.updated).toBe(2);
    for (const id of ids) expect(state(id)).toMatchObject({ kid_id: k, is_ignored: 1, category_source: 'user' });
    expect(state(ids[0]!).category_id).toBe(cat('Childcare'));
    await undo(res.moveId!);
    expect(ids.map(state)).toEqual(before);
  });

  it('mark private files to my own fun money; Undo makes them shared again', async () => {
    const shopping = cat('Shopping');
    const picked = [add({ name: 'BOOKS', cents: -2000, categoryId: shopping }), add({ name: 'GAME', cents: -3000 })];
    const before = picked.map(state);
    const res = await bulk({ ids: picked, set: { isPrivate: true } });
    for (const id of picked) expect(state(id)).toMatchObject({ private_member_id: you, category_id: funOf(you) });
    // The partner no longer sees them.
    expect(ids(await search('', PARTNER)).filter((id) => picked.includes(id))).toEqual([]);
    await undo(res.moveId!);
    expect(picked.map(state)).toEqual(before);
  });

  it('a category on my private charges makes them shared (like a single change)', async () => {
    const mine = add({ name: 'BOOKS', cents: -2000, privateTo: you, categoryId: funOf(you) });
    await bulk({ ids: [mine], set: { categoryId: cat('Shopping') } });
    expect(state(mine)).toMatchObject({ private_member_id: null, category_id: cat('Shopping') });
  });

  it('never touches a partner’s private charge, or charges that aren’t there', async () => {
    const theirs = add({ name: 'SPA', cents: -9000, privateTo: partner, categoryId: funOf(partner) });
    const shared = add({ name: 'SPA', cents: -9000 });
    const before = state(theirs);
    const res = await bulk({ ids: [theirs, shared, 999999], set: { categoryId: cat('Gifts'), kidId: null, isIgnored: true } });
    expect(res).toMatchObject({ updated: 1, skipped: 2 });
    expect(state(theirs)).toEqual(before);
    expect(db.rows('SELECT transaction_id FROM category_move_items WHERE move_id = ?', res.moveId)).toEqual([{ transaction_id: shared }]);
    // Only the person who made the change can undo it.
    expect((await undo(res.moveId!, PARTNER)).status).toBe(403);
  });

  it('nothing to change: no move', async () => {
    const theirs = add({ name: 'SPA', cents: -9000, privateTo: partner, categoryId: funOf(partner) });
    expect(await bulk({ ids: [theirs], set: { isIgnored: true } })).toEqual({ updated: 0, skipped: 1, moveId: null });
    expect(db.rows('SELECT id FROM category_moves')).toEqual([]);
  });

  it('split charges keep their parts when a category is set, but take a kid', async () => {
    const k = kid();
    const split = add({ name: 'COSTCO', cents: -9000 });
    db.exec('UPDATE transactions SET is_split = 1 WHERE id = ?', split);
    const plain = add({ name: 'COSTCO', cents: -9000 });
    expect(await bulk({ ids: [split, plain], set: { categoryId: cat('Groceries') } })).toMatchObject({ updated: 1, skipped: 1 });
    expect(state(split).category_id).toBeNull();
    expect(await bulk({ ids: [split], set: { kidId: k } })).toMatchObject({ updated: 1, skipped: 0 });
    expect(state(split).kid_id).toBe(k);
  });

  it('Undo leaves a charge changed by hand since, and puts back the rest', async () => {
    const gifts = cat('Gifts');
    const shopping = cat('Shopping');
    const a = add({ name: 'TARGET', cents: -2000, categoryId: shopping });
    const b = add({ name: 'AMAZON', cents: -3000, categoryId: shopping });
    const res = await bulk({ ids: [a, b], set: { categoryId: gifts } });
    expect((await api(env, 'PATCH', `/transactions/${b}`, { categoryId: cat('Groceries') })).status).toBe(200);
    const undone = (await (await undo(res.moveId!)).json()) as { restored: number };
    expect(undone.restored).toBe(1);
    expect(state(a)).toMatchObject({ category_id: shopping, category_source: 'auto' });
    expect(state(b)).toMatchObject({ category_id: cat('Groceries'), category_source: 'user' });
    expect((await undo(res.moveId!)).status).toBe(404);
  });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  it('Undo leaves a charge split since alone', async () => {
    const shopping = cat('Shopping');
    const a = add({ name: 'COSTCO', cents: -9000, categoryId: shopping });
    const b = add({ name: 'TARGET', cents: -2000, categoryId: shopping });
    // Clearing the category: a later split also leaves it empty, so only a split guard tells them apart.
    const res = await bulk({ ids: [a, b], set: { categoryId: null } });
    await tick();
    const split = await api(env, 'PUT', `/transactions/${a}/splits`, {
      splits: [
        { categoryId: cat('Groceries'), amountCents: -4000 },
        { categoryId: shopping, amountCents: -5000 },
      ],
    });
    expect(split.status).toBe(200);
    const after = state(a);
    expect(((await (await undo(res.moveId!)).json()) as { restored: number }).restored).toBe(1);
    expect(state(a)).toEqual(after);
    expect(state(a).category_id).toBeNull();
    expect(db.rows<{ is_split: number }>('SELECT is_split FROM transactions WHERE id = ?', a)[0]!.is_split).toBe(1);
    expect(state(b).category_id).toBe(shopping);
  });

  it('Undo leaves a charge re-picked by hand since, even to the same values', async () => {
    const shopping = cat('Shopping');
    const gifts = cat('Gifts');
    const a = add({ name: 'TARGET', cents: -2000, categoryId: shopping });
    const b = add({ name: 'AMAZON', cents: -3000, categoryId: shopping });
    const res = await bulk({ ids: [a, b], set: { categoryId: gifts } });
    await tick();
    expect((await api(env, 'PATCH', `/transactions/${a}`, { categoryId: gifts })).status).toBe(200);
    expect(((await (await undo(res.moveId!)).json()) as { restored: number }).restored).toBe(1);
    expect(state(a)).toMatchObject({ category_id: gifts, category_source: 'user' });
    expect(state(b)).toMatchObject({ category_id: shopping, category_source: 'auto' });
  });

  it('a kid-only change on an already-split charge undoes fine', async () => {
    const k = kid();
    const split = add({ name: 'COSTCO', cents: -9000 });
    db.exec('UPDATE transactions SET is_split = 1 WHERE id = ?', split);
    const before = state(split);
    const res = await bulk({ ids: [split], set: { kidId: k, isIgnored: true } });
    expect(state(split)).toMatchObject({ kid_id: k, is_ignored: 1 });
    expect(((await (await undo(res.moveId!)).json()) as { restored: number }).restored).toBe(1);
    expect(state(split)).toEqual(before);
  });

  it('refuses a category or kid that doesn’t exist, and records nothing', async () => {
    const id = add({ name: 'X', cents: -100 });
    expect((await api(env, 'POST', '/transactions/bulk', { ids: [id], set: { categoryId: 999999 } })).status).toBe(400);
    expect((await api(env, 'POST', '/transactions/bulk', { ids: [id], set: { kidId: 999999 } })).status).toBe(400);
    expect(db.rows('SELECT id FROM category_moves')).toEqual([]);
    expect(state(id)).toMatchObject({ category_id: null, kid_id: null, category_source: null });
  });

  it('refuses bad requests', async () => {
    const id = add({ name: 'X', cents: -100 });
    const post = (body: unknown) => api(env, 'POST', '/transactions/bulk', body);
    expect((await post({ ids: [], set: { isIgnored: true } })).status).toBe(400);
    expect((await post({ ids: 'all', set: { isIgnored: true } })).status).toBe(400);
    expect((await post({ ids: [id, 'x'], set: { isIgnored: true } })).status).toBe(400);
    expect((await post({ ids: Array.from({ length: 501 }, (_, i) => i + 1), set: { isIgnored: true } })).status).toBe(400);
    expect((await post({ ids: [id] })).status).toBe(400);
    expect((await post({ ids: [id], set: {} })).status).toBe(400);
    expect((await post({ ids: [id], set: { isIgnored: 'yes' } })).status).toBe(400);
    expect((await post({ ids: [id], set: { categoryId: funOf(partner) } })).status).toBe(403);
    expect(state(id)).toMatchObject({ category_id: null, is_ignored: 0 });
  });

  it('handles a big selection in one request', async () => {
    const many = Array.from({ length: 300 }, (_, i) => add({ name: `SHOP ${i}`, cents: -100 - i }));
    const res = await bulk({ ids: many, set: { categoryId: cat('Shopping') } });
    expect(res.updated).toBe(300);
    expect(db.rows<{ n: number }>('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?', cat('Shopping'))[0]!.n).toBe(300);
    await undo(res.moveId!);
    expect(db.rows<{ n: number }>('SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NULL')[0]!.n).toBe(300);
  });
});

describe('searching bills', () => {
  type Bill = { id: number; name: string; status: string };
  function bill(name: string, merchant: string, cents: number, status = 'confirmed', privateTo: number | null = null) {
    db.exec(
      `INSERT INTO recurring_bills (merchant, name, cadence, expected_amount_cents, status, private_member_id, category_id)
       VALUES (?, ?, 'monthly', ?, ?, ?, ?)`,
      merchant,
      name,
      cents,
      status,
      privateTo,
      cat('Phone'),
    );
    return db.rows<{ id: number }>('SELECT MAX(id) AS id FROM recurring_bills')[0]!.id;
  }
  async function bills(query: string, email = YOU) {
    const res = await api(env, 'GET', `/recurring${query ? `?${query}` : ''}`, undefined, email);
    expect(res.status).toBe(200);
    return ((await res.json()) as Bill[]).map((b) => b.id).sort((a, b) => a - b);
  }

  it('by name, merchant, category or amount, and by status', async () => {
    const phone = bill('Phone bill', 'verizon', 8512);
    const net = bill('Internet', 'comcast', 6000, 'suggested');
    const gym = bill('Gym', 'planet fitness', 2500, 'dismissed');
    const theirs = bill('Their gym', 'yoga studio', 4000, 'confirmed', partner);

    // Today's default: everything but dismissed.
    expect(await bills('')).toEqual([phone, net]);
    expect(await bills('all=1')).toEqual([phone, net, gym]);
    expect(await bills('status=all')).toEqual([phone, net, gym]);
    expect(await bills('status=dismissed')).toEqual([gym]);
    expect(await bills('status=suggested')).toEqual([net]);
    expect(await bills('status=confirmed')).toEqual([phone]);
    expect((await api(env, 'GET', '/recurring?status=nope')).status).toBe(400);

    expect(await bills(q('VERIZON'))).toEqual([phone]);
    expect(await bills(q('internet'))).toEqual([net]);
    expect(await bills(q('phone'))).toEqual([phone, net]);
    expect(await bills(q('85.12'))).toEqual([phone]);
    expect(await bills(q('$85'))).toEqual([phone]);
    expect(await bills(q('>50'))).toEqual([phone, net]);
    expect(await bills(`${q('gym')}&status=all`)).toEqual([gym]);
    expect(await bills(q('gym'))).toEqual([]);
    expect(await bills(`${q('yoga')}&status=all`)).toEqual([]);
    expect(await bills(q('yoga'), PARTNER)).toEqual([theirs]);
  });
});
