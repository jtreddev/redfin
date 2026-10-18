import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/worker/env';
import { cleanupCategoryMoves } from '../src/worker/services/learn';
import { api } from './helpers/api';
import { TestD1 } from './helpers/d1';
import { testEnv } from './helpers/plaid';

const YOU = 'you@example.com';
const PARTNER = 'partner@example.com';

type Move = { id: number; moved: number; merchant: string; categoryName: string };
type PatchBody = { transaction: { categoryId: number | null } | null; move: Move | null; suggestion?: unknown };

let db: TestD1;
let env: Env;
let you: number;
let partner: number;
let yourFun: number;

const cat = (name: string) => db.rows<{ id: number }>('SELECT id FROM categories WHERE name = ? AND fun_member_id IS NULL', name)[0]!.id;

function charge(cents: number, opts: { categoryId?: number | null; source?: string | null; reason?: string | null; privateTo?: number | null; merchant?: string; account?: number } = {}) {
  const merchant = opts.merchant ?? 'Shell';
  db.exec(
    `INSERT INTO transactions (account_id, date, amount_cents, name, merchant_name, normalized_merchant, source,
       category_id, category_source, category_reason, private_member_id)
     VALUES (?, '2026-10-01', ?, ?, ?, ?, 'plaid', ?, ?, ?, ?)`,
    opts.account ?? 1,
    -cents,
    `${merchant.toUpperCase()} OIL 5512`,
    merchant,
    merchant.toUpperCase(),
    opts.categoryId ?? null,
    opts.source ?? null,
    opts.reason ?? null,
    opts.privateTo ?? null,
  );
  return db.rows<{ id: number }>('SELECT MAX(id) AS id FROM transactions')[0]!.id;
}

/** A personal card for `memberId`: its charges default to that person's fun money. */
function personalCard(memberId: number) {
  db.exec(`INSERT INTO accounts (name, type) VALUES ('Personal card', 'credit')`);
  const id = db.rows<{ id: number }>('SELECT MAX(id) AS id FROM accounts')[0]!.id;
  db.exec('UPDATE members SET default_private_account_id = ? WHERE id = ?', id, memberId);
  return id;
}

const row = (id: number) =>
  db.rows<{ category_id: number | null; category_source: string | null; category_reason: string | null; rule_id: number | null; private_member_id: number | null }>(
    'SELECT category_id, category_source, category_reason, rule_id, private_member_id FROM transactions WHERE id = ?',
    id,
  )[0]!;

async function fix(id: number, categoryId: number | null, email = YOU): Promise<PatchBody> {
  const res = await api(env, 'PATCH', `/transactions/${id}`, { categoryId }, email);
  expect(res.status).toBe(200);
  return (await res.json()) as PatchBody;
}

const undo = (moveId: number, email = YOU) => api(env, 'POST', `/category-moves/${moveId}/undo`, {}, email);

const learnedRules = () =>
  db.rows<{ id: number; match_field: string; match_text: string; category_id: number; amount_min_cents: number | null; amount_max_cents: number | null; private_member_id: number | null; owner_member_id: number | null }>(
    `SELECT id, match_field, match_text, category_id, amount_min_cents, amount_max_cents, private_member_id, owner_member_id
       FROM rules WHERE learned = 1 ORDER BY id`,
  );

beforeEach(async () => {
  db = new TestD1();
  env = testEnv(db);
  await api(env, 'GET', '/me', undefined, YOU);
  await api(env, 'GET', '/me', undefined, PARTNER);
  const member = (email: string) => db.rows<{ id: number }>('SELECT id FROM members WHERE email = ?', email)[0]!.id;
  you = member(YOU);
  partner = member(PARTNER);
  yourFun = db.rows<{ id: number }>('SELECT id FROM categories WHERE fun_member_id = ?', you)[0]!.id;
  db.exec(`INSERT INTO accounts (name, type) VALUES ('Card', 'credit')`);
});

describe('fixing a charge', () => {
  it('fixing one Shell charge re-files the others and learns', async () => {
    const habits = cat('Habits');
    const gas = cat('Gas');
    const ids = [1, 2, 3].map(() => charge(4000, { categoryId: habits, source: 'auto', reason: 'Under $25 at a gas station' }));

    const body = await fix(ids[0]!, gas);
    expect(body.move).toMatchObject({ moved: 2, merchant: 'SHELL', categoryName: 'Gas' });
    expect(body.transaction?.categoryId).toBe(gas);

    const rules = learnedRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ match_field: 'merchant', match_text: 'SHELL', category_id: gas, amount_min_cents: 2500, amount_max_cents: null, private_member_id: null });
    const minOther = db.rows<{ p: number }>('SELECT MIN(position) AS p FROM rules WHERE learned = 0')[0]!.p;
    const learnedPos = db.rows<{ p: number }>('SELECT position AS p FROM rules WHERE id = ?', rules[0]!.id)[0]!.p;
    if (minOther !== null) expect(learnedPos).toBeLessThan(minOther);

    expect(row(ids[0]!)).toMatchObject({ category_id: gas, category_source: 'user' });
    for (const id of ids.slice(1)) {
      expect(row(id)).toMatchObject({ category_id: gas, category_source: 'rule', category_reason: 'Learned from your fix', rule_id: rules[0]!.id });
    }
    // The tapped charge is recorded too, so Undo can put it back.
    expect(db.rows('SELECT transaction_id FROM category_move_items ORDER BY transaction_id')).toEqual(ids.map((id) => ({ transaction_id: id })));
  });

  it('fix leaves hand-set charges alone', async () => {
    const habits = cat('Habits');
    const gas = cat('Gas');
    const shopping = cat('Shopping');
    const fixed = charge(4000, { categoryId: habits, source: 'auto' });
    const handSet = charge(4000, { categoryId: shopping, source: 'user' });
    const auto = charge(4000, { categoryId: habits, source: 'auto' });

    const body = await fix(fixed, gas);
    expect(body.move?.moved).toBe(1);
    expect(row(handSet)).toMatchObject({ category_id: shopping, category_source: 'user' });
    expect(row(auto)).toMatchObject({ category_id: gas, category_source: 'rule' });
  });

  it('fill-ups stay put when you fix a small one', async () => {
    const gas = cat('Gas');
    const habits = cat('Habits');
    const coffee = cat('Coffee & Fast Food');
    const small = charge(641, { categoryId: habits, source: 'auto' });
    const otherSmall = charge(899, { categoryId: habits, source: 'auto' });
    const fillUps = [charge(4500, { categoryId: gas, source: 'auto' }), charge(4500, { categoryId: gas, source: 'auto' })];

    const body = await fix(small, coffee);
    expect(body.move?.moved).toBe(1);
    expect(learnedRules()[0]).toMatchObject({ amount_min_cents: 0, amount_max_cents: 2499, category_id: coffee });
    expect(row(otherSmall).category_id).toBe(coffee);
    for (const id of fillUps) expect(row(id)).toMatchObject({ category_id: gas, category_source: 'auto' });
  });

  it('learns the whole merchant for a non-gas charge', async () => {
    const groceries = cat('Groceries');
    const ids = [charge(500, { merchant: 'Kroger' }), charge(90000, { merchant: 'Kroger' })];
    const body = await fix(ids[0]!, groceries);
    expect(body.move?.moved).toBe(1);
    expect(learnedRules()[0]).toMatchObject({ match_text: 'KROGER', amount_min_cents: null, amount_max_cents: null });
  });

  it('learns a merchant whose key drops punctuation', async () => {
    const coffee = cat('Coffee & Fast Food');
    const add = () => {
      db.exec(
        `INSERT INTO transactions (account_id, date, amount_cents, name, merchant_name, normalized_merchant, source)
         VALUES (1, '2026-10-01', -1200, 'CHICK-FIL-A #0412', 'Chick-fil-A', 'CHICK FIL A', 'plaid')`,
      );
      return db.rows<{ id: number }>('SELECT MAX(id) AS id FROM transactions')[0]!.id;
    };
    const [a, b] = [add(), add()];
    const body = await fix(a, coffee);
    expect(body.move?.moved).toBe(1);
    expect(learnedRules()[0]).toMatchObject({ match_text: 'CHICK-FIL-A' });
    expect(row(b).category_id).toBe(coffee);
  });

  it('undo restores a charge whose category was cleared since', async () => {
    const habits = cat('Habits');
    const fixed = charge(4000, { categoryId: habits, source: 'auto' });
    const a = charge(4000, { categoryId: habits, source: 'auto' });
    const body = await fix(fixed, cat('Gas'));
    db.exec('UPDATE transactions SET category_id = NULL, category_source = NULL, category_reason = NULL, rule_id = NULL WHERE id = ?', a);
    expect((await undo(body.move!.id)).status).toBe(200);
    expect(row(a)).toMatchObject({ category_id: habits, category_source: 'auto' });
  });

  it('undo restores everything', async () => {
    const habits = cat('Habits');
    const gas = cat('Gas');
    const fixed = charge(4000, { categoryId: habits, source: 'auto', reason: 'Under $25 at a gas station' });
    const a = charge(4000, { categoryId: habits, source: 'auto', reason: 'Under $25 at a gas station' });
    const b = charge(4000);
    db.exec('UPDATE transactions SET rule_id = NULL WHERE id = ?', fixed);
    const before = { fixed: row(fixed), a: row(a), b: row(b) };

    const body = await fix(fixed, gas);
    expect(body.move?.moved).toBe(2);
    const res = await undo(body.move!.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ restored: 3 });

    expect(row(a)).toEqual(before.a);
    expect(row(b)).toEqual(before.b);
    // The charge you tapped goes back too.
    expect(row(fixed)).toEqual(before.fixed);
    expect(learnedRules()).toEqual([]);
    expect(db.rows('SELECT id FROM category_moves')).toEqual([]);
    expect(db.rows('SELECT move_id FROM category_move_items')).toEqual([]);
    expect((await undo(body.move!.id)).status).toBe(404);
  });

  it('undo skips charges set by hand since', async () => {
    const habits = cat('Habits');
    const gas = cat('Gas');
    const shopping = cat('Shopping');
    const fixed = charge(4000, { categoryId: habits, source: 'auto' });
    const a = charge(4000, { categoryId: habits, source: 'auto' });
    const body = await fix(fixed, gas);
    db.exec(`UPDATE transactions SET category_id = ?, category_source = 'user', category_reason = NULL WHERE id = ?`, shopping, a);
    expect((await undo(body.move!.id)).status).toBe(200);
    expect(row(a)).toMatchObject({ category_id: shopping, category_source: 'user' });
  });

  it('undo leaves the tapped charge alone if you changed it again', async () => {
    const habits = cat('Habits');
    const shopping = cat('Shopping');
    const fixed = charge(4000, { categoryId: habits, source: 'auto' });
    const a = charge(4000, { categoryId: habits, source: 'auto' });
    const body = await fix(fixed, cat('Gas'));
    db.exec(`UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?`, shopping, fixed);
    expect((await undo(body.move!.id)).status).toBe(200);
    expect(row(fixed)).toMatchObject({ category_id: shopping, category_source: 'user' });
    expect(row(a)).toMatchObject({ category_id: habits, category_source: 'auto' });
  });

  it('undo leaves a re-filed charge you later picked by hand, even in the same category', async () => {
    const habits = cat('Habits');
    const gas = cat('Gas');
    const fixed = charge(4000, { categoryId: habits, source: 'auto' });
    const a = charge(4000, { categoryId: habits, source: 'auto' });
    const body = await fix(fixed, gas);
    db.exec(`UPDATE transactions SET category_source = 'user', category_reason = NULL, rule_id = NULL WHERE id = ?`, a);
    expect((await undo(body.move!.id)).status).toBe(200);
    expect(row(a)).toMatchObject({ category_id: gas, category_source: 'user' });
  });

  it('undo after the learned rule was deleted leaves a since-split charge alone', async () => {
    const habits = cat('Habits');
    const fixed = charge(4000, { categoryId: habits, source: 'auto' });
    const a = charge(4000, { categoryId: habits, source: 'auto' });
    const body = await fix(fixed, cat('Gas'));
    expect((await api(env, 'DELETE', `/rules/${learnedRules()[0]!.id}`)).status).toBe(200);
    db.exec(`UPDATE transactions SET is_split = 1, category_id = NULL, category_source = NULL, category_reason = NULL WHERE id = ?`, a);
    expect((await undo(body.move!.id)).status).toBe(200);
    expect(db.rows('SELECT is_split, category_id FROM transactions WHERE id = ?', a)).toEqual([{ is_split: 1, category_id: null }]);
  });

  it('a private fix doesn’t take over a partner’s shared learned rule', async () => {
    const coffee = cat('Coffee & Fast Food');
    await fix(charge(700), coffee, PARTNER);
    const shared = learnedRules()[0]!;
    expect(shared).toMatchObject({ private_member_id: null, owner_member_id: null });

    await fix(charge(700), yourFun);
    const rules = learnedRules();
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual(shared);
    expect(rules[1]).toMatchObject({ category_id: yourFun, private_member_id: you, owner_member_id: you });
    const list = ((await (await api(env, 'GET', '/rules', undefined, PARTNER)).json()) as { id: number }[]).map((r) => r.id);
    expect(list).toContain(shared.id);
  });

  it('matches merchants with LIKE wildcards in their name', async () => {
    const coffee = cat('Coffee & Fast Food');
    const ids = [charge(700, { merchant: 'Joe_s Cafe' }), charge(700, { merchant: 'Joe_s Cafe' })];
    const body = await fix(ids[0]!, coffee);
    expect(learnedRules()[0]).toMatchObject({ match_text: 'JOE_S CAFE' });
    expect(body.move?.moved).toBe(1);
    expect(row(ids[1]!).category_id).toBe(coffee);
  });

  it('undo restores a changed rule', async () => {
    const habits = cat('Habits');
    const gas = cat('Gas');
    const savings = cat('Savings & Planned Costs');
    const ids = [charge(4000, { categoryId: habits, source: 'auto' }), charge(4000, { categoryId: habits, source: 'auto' })];
    const first = await fix(ids[0]!, gas);
    const ruleId = learnedRules()[0]!.id;
    const third = charge(4000, { categoryId: gas, source: 'rule', reason: 'Learned from your fix' });
    db.exec('UPDATE transactions SET rule_id = ? WHERE id = ?', ruleId, third);

    const second = await fix(ids[1]!, savings);
    expect(second.move?.id).not.toBe(first.move?.id);
    expect(learnedRules()).toHaveLength(1);
    expect(learnedRules()[0]).toMatchObject({ id: ruleId, category_id: savings });
    expect(row(third)).toMatchObject({ category_id: savings, rule_id: ruleId });

    expect((await undo(second.move!.id)).status).toBe(200);
    expect(learnedRules()).toHaveLength(1);
    expect(learnedRules()[0]).toMatchObject({ id: ruleId, category_id: gas });
    expect(row(third)).toMatchObject({ category_id: gas, category_source: 'rule', rule_id: ruleId });
  });

  it('undo of an older move is refused', async () => {
    const habits = cat('Habits');
    const gas = cat('Gas');
    const savings = cat('Savings & Planned Costs');
    const ids = [charge(4000, { categoryId: habits, source: 'auto' }), charge(4000, { categoryId: habits, source: 'auto' })];
    const first = await fix(ids[0]!, gas);
    await fix(ids[1]!, savings);
    const res = await undo(first.move!.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Already changed again' });
  });

  it('only the person who made the move can undo it', async () => {
    const gas = cat('Gas');
    const ids = [charge(4000), charge(4000)];
    const body = await fix(ids[0]!, gas);
    expect((await undo(body.move!.id, PARTNER)).status).toBe(403);
    expect((await undo(body.move!.id, YOU)).status).toBe(200);
  });

  it('private fix stays private', async () => {
    const habits = cat('Habits');
    const myCard = personalCard(you);
    const mine = [charge(700, { categoryId: habits, source: 'auto' }), charge(700, { categoryId: habits, source: 'auto', account: myCard })];
    const shared = charge(700, { categoryId: habits, source: 'auto' });
    const partnerFun = db.rows<{ id: number }>('SELECT id FROM categories WHERE fun_member_id = ?', partner)[0]!.id;
    const theirs = charge(700, { categoryId: partnerFun, source: 'auto', privateTo: partner });

    const body = await fix(mine[0]!, yourFun);
    expect(body.move?.moved).toBe(1);
    const rules = learnedRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ category_id: yourFun, private_member_id: you, owner_member_id: you });
    expect(row(mine[1]!)).toMatchObject({ category_id: yourFun, private_member_id: you, category_source: 'rule' });
    expect(row(theirs)).toMatchObject({ category_id: partnerFun, private_member_id: partner, category_source: 'auto' });
    // A private learned rule only reaches your own card: shared-account charges stay shared.
    expect(row(shared)).toMatchObject({ category_id: habits, private_member_id: null, category_source: 'auto' });

    const list = async (email: string) => ((await (await api(env, 'GET', '/rules', undefined, email)).json()) as { id: number }[]).map((r) => r.id);
    expect(await list(YOU)).toContain(rules[0]!.id);
    expect(await list(PARTNER)).not.toContain(rules[0]!.id);

    // Undo puts the re-filed charge back where everyone can see it.
    expect((await undo(body.move!.id)).status).toBe(200);
    expect(row(mine[1]!)).toMatchObject({ category_id: habits, private_member_id: null, category_source: 'auto' });
  });

  it('my private fix never pulls a partner’s later charge into my fun money', async () => {
    await fix(charge(700), yourFun);
    // The partner buys there later, on the shared card, and history gets re-sorted.
    const theirs = charge(700);
    await api(env, 'POST', '/categorize/all', {});
    expect(row(theirs)).toMatchObject({ private_member_id: null });
    expect(row(theirs).category_id).not.toBe(yourFun);
    expect(row(theirs).category_source).not.toBe('rule');
  });

  it('a shared fix never moves my personal-card charge into shared view', async () => {
    const myCard = personalCard(you);
    const habits = cat('Habits');
    const gas = cat('Gas');
    const onMyCard = charge(4000, { categoryId: yourFun, source: 'auto', reason: 'Your personal card', privateTo: you, account: myCard });
    const sharedToo = charge(4000, { categoryId: habits, source: 'auto' });
    const body = await fix(charge(4000, { categoryId: habits, source: 'auto' }), gas);
    expect(body.move?.moved).toBe(1);
    expect(row(sharedToo)).toMatchObject({ category_id: gas, category_source: 'rule' });
    expect(row(onMyCard)).toMatchObject({ category_id: yourFun, private_member_id: you, category_source: 'auto' });

    await api(env, 'POST', '/categorize/all', {});
    expect(row(onMyCard)).toMatchObject({ category_id: yourFun, private_member_id: you });
    expect(row(onMyCard).category_source).not.toBe('rule');
    expect(row(sharedToo)).toMatchObject({ category_id: gas, category_source: 'rule' });
  });

  it('a private learned rule applies to new charges on my own card', async () => {
    const myCard = personalCard(you);
    await fix(charge(700, { account: myCard }), yourFun);
    const ruleId = learnedRules()[0]!.id;
    const later = charge(700, { account: myCard });
    await api(env, 'POST', '/categorize/all', {});
    expect(row(later)).toMatchObject({
      category_id: yourFun,
      private_member_id: you,
      category_source: 'rule',
      category_reason: 'Learned from your fix',
      rule_id: ruleId,
    });
  });

  it('a partner’s private learned rule is never reused', async () => {
    const partnerFun = db.rows<{ id: number }>('SELECT id FROM categories WHERE fun_member_id = ?', partner)[0]!.id;
    const theirs = charge(700, { privateTo: partner, categoryId: partnerFun, source: 'auto' });
    await fix(theirs, partnerFun, PARTNER);
    const coffee = cat('Coffee & Fast Food');
    await fix(charge(700), coffee);
    const rules = learnedRules();
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({ category_id: partnerFun, owner_member_id: partner });
    expect(rules[1]).toMatchObject({ category_id: coffee, owner_member_id: null });
  });

  it('no prompt any more', async () => {
    const body = await fix(charge(4000), cat('Gas'));
    expect(body).not.toHaveProperty('suggestion');
    expect(body).toHaveProperty('move');
  });

  it('clearing a category saves without learning', async () => {
    const id = charge(4000, { categoryId: cat('Gas'), source: 'auto' });
    const body = await fix(id, null);
    expect(body.move).toBeNull();
    expect(row(id)).toMatchObject({ category_id: null, category_source: 'user' });
    expect(learnedRules()).toEqual([]);
  });

  it('old moves are cleaned up after a day', async () => {
    const body = await fix(charge(4000), cat('Gas'));
    db.exec(`UPDATE category_moves SET created_at = '2020-01-01T00:00:00.000Z'`);
    const fresh = await fix(charge(4000, { merchant: 'Kroger' }), cat('Groceries'));
    await cleanupCategoryMoves(env.DB);
    expect(db.rows<{ id: number }>('SELECT id FROM category_moves').map((m) => m.id)).toEqual([fresh.move!.id]);
    expect(body.move!.id).not.toBe(fresh.move!.id);
  });
});
