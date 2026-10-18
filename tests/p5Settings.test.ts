import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/worker/env';
import { api } from './helpers/api';
import { TestD1 } from './helpers/d1';
import { testEnv } from './helpers/plaid';

const YOU = 'you@example.com';
const PARTNER = 'partner@example.com';

let db: TestD1;
let env: Env;

beforeEach(() => {
  db = new TestD1();
  env = testEnv(db);
});

const json = async <T = any>(res: Response) => (await res.json()) as T;

async function twoPeople() {
  await api(env, 'GET', '/me', undefined, YOU);
  await api(env, 'GET', '/me', undefined, PARTNER);
  const id = (email: string) => db.rows<{ id: number }>('SELECT id FROM members WHERE email = ?', email)[0]!.id;
  return { you: id(YOU), partner: id(PARTNER) };
}

describe('per-person preferences', () => {
  it('defaults to showing the checklist and hiding power tools', async () => {
    const me = await json(await api(env, 'GET', '/me', undefined, YOU));
    expect(me.viewer.hideSetup).toBe(false);
    expect(me.viewer.powerTools).toBe(false);
  });

  it('saves each person their own switches', async () => {
    await twoPeople();
    expect((await api(env, 'PATCH', '/me/prefs', { hideSetup: true, powerTools: true }, YOU)).status).toBe(200);
    const mine = await json(await api(env, 'GET', '/me', undefined, YOU));
    const theirs = await json(await api(env, 'GET', '/me', undefined, PARTNER));
    expect(mine.viewer).toMatchObject({ hideSetup: true, powerTools: true });
    expect(theirs.viewer).toMatchObject({ hideSetup: false, powerTools: false });
    await api(env, 'PATCH', '/me/prefs', { powerTools: false }, YOU);
    const again = await json(await api(env, 'GET', '/me', undefined, YOU));
    expect(again.viewer).toMatchObject({ hideSetup: true, powerTools: false });
  });

  it('rejects empty or non-boolean updates', async () => {
    expect((await api(env, 'PATCH', '/me/prefs', {}, YOU)).status).toBe(400);
    expect((await api(env, 'PATCH', '/me/prefs', { powerTools: 'yes' }, YOU)).status).toBe(400);
  });
});

describe('saved searches', () => {
  it('creates, lists, renames and deletes your own', async () => {
    const made = await api(env, 'POST', '/saved-searches', { name: 'Big groceries', query: 'q=kroger&min=50', sort: 'amount' }, YOU);
    expect(made.status).toBe(201);
    const created = await json(made);
    expect(created).toMatchObject({ name: 'Big groceries', query: 'q=kroger&min=50', sort: 'amount' });
    expect(await json(await api(env, 'GET', '/saved-searches', undefined, YOU))).toHaveLength(1);
    expect((await api(env, 'PATCH', `/saved-searches/${created.id}`, { name: 'Groceries' }, YOU)).status).toBe(200);
    expect((await json(await api(env, 'GET', '/saved-searches', undefined, YOU)))[0].name).toBe('Groceries');
    expect((await api(env, 'DELETE', `/saved-searches/${created.id}`, undefined, YOU)).status).toBe(200);
    expect(await json(await api(env, 'GET', '/saved-searches', undefined, YOU))).toHaveLength(0);
  });

  it('validates the name', async () => {
    expect((await api(env, 'POST', '/saved-searches', { name: '  ', query: 'q=a' }, YOU)).status).toBe(400);
    expect((await api(env, 'POST', '/saved-searches', { query: 'q=a' }, YOU)).status).toBe(400);
  });

  it("never shows or changes your partner's", async () => {
    await twoPeople();
    const theirs = await json(await api(env, 'POST', '/saved-searches', { name: 'Secret', query: 'q=gift' }, PARTNER));
    expect(await json(await api(env, 'GET', '/saved-searches', undefined, YOU))).toEqual([]);
    expect((await api(env, 'PATCH', `/saved-searches/${theirs.id}`, { name: 'x' }, YOU)).status).toBe(404);
    expect((await api(env, 'DELETE', `/saved-searches/${theirs.id}`, undefined, YOU)).status).toBe(404);
    expect(await json(await api(env, 'GET', '/saved-searches', undefined, PARTNER))).toHaveLength(1);
  });
});

describe('rule preview and apply to past charges', () => {
  async function seed() {
    const ids = await twoPeople();
    db.exec(`INSERT INTO accounts (id, name) VALUES (1, 'Checking'), (2, 'Card')`);
    const tx = (date: string, name: string, acct: number, priv: number | null) =>
      db.exec(
        `INSERT INTO transactions (account_id, date, amount_cents, name, source, private_member_id) VALUES (?, ?, -500, ?, 'manual', ?)`,
        acct, date, name, priv,
      );
    for (let i = 1; i <= 7; i++) tx(`2026-10-0${i}`, `KROGER #${i}`, 1, null);
    tx('2026-10-08', 'KROGER SECRET', 1, ids.partner);
    tx('2026-10-09', 'KROGER CARD', 2, null);
    tx('2026-10-10', 'SHELL', 1, null);
    return ids;
  }
  const aCategory = () => db.rows<{ id: number }>(`SELECT id FROM categories WHERE fun_member_id IS NULL LIMIT 1`)[0]!.id;

  it('counts matches and returns up to 5 samples', async () => {
    await seed();
    const res = await json(await api(env, 'POST', '/rules/preview', { matchField: 'name', matchText: 'kroger' }, YOU));
    expect(res.count).toBe(8);
    expect(res.sample).toHaveLength(5);
    expect(res.sample[0]).toMatchObject({ id: expect.any(Number), date: '2026-10-09', name: 'KROGER CARD', amountCents: -500 });
  });

  it("never counts or shows your partner's private charges", async () => {
    await seed();
    const mine = await json(await api(env, 'POST', '/rules/preview', { matchText: 'secret' }, YOU));
    expect(mine.count).toBe(0);
    expect(mine.sample).toEqual([]);
    const theirs = await json(await api(env, 'POST', '/rules/preview', { matchText: 'secret' }, PARTNER));
    expect(theirs.count).toBe(1);
  });

  it('limits to one account', async () => {
    await seed();
    const res = await json(await api(env, 'POST', '/rules/preview', { matchText: 'kroger', accountId: 2 }, YOU));
    expect(res.count).toBe(1);
  });

  it('says how many a category would change, leaving hand-set ones alone', async () => {
    await seed();
    const cat = aCategory();
    db.exec(`UPDATE transactions SET category_id = ?, category_source = 'user' WHERE name = 'KROGER #1'`, cat);
    const res = await json(await api(env, 'POST', '/rules/preview', { matchText: 'kroger #', categoryId: cat }, YOU));
    expect(res.count).toBe(7);
    expect(res.wouldChange).toBe(6);
  });

  it('rejects short or missing text', async () => {
    expect((await api(env, 'POST', '/rules/preview', { matchText: 'k' }, YOU)).status).toBe(400);
    expect((await api(env, 'POST', '/rules/preview', {}, YOU)).status).toBe(400);
  });

  it('POST /rules files past charges by default and skips them when applyToExisting is false', async () => {
    await seed();
    const cat = aCategory();
    const off = await json(await api(env, 'POST', '/rules', { matchText: 'SHELL', categoryId: cat, applyToExisting: false }, YOU));
    expect(off.updated).toBe(0);
    expect(db.rows(`SELECT category_id AS c FROM transactions WHERE name = 'SHELL'`)).toEqual([{ c: null }]);
    const on = await json(await api(env, 'POST', '/rules', { matchText: 'KROGER #', categoryId: cat, applyToExisting: true }, YOU));
    expect(on.updated).toBe(7);
    expect(db.rows(`SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?`, cat)).toEqual([{ n: 7 }]);
  });

  it('PATCH /rules honours applyToExisting: false', async () => {
    await seed();
    const cat = aCategory();
    const { id } = await json(await api(env, 'POST', '/rules', { matchText: 'SHELL', ignore: true, applyToExisting: false }, YOU));
    const res = await json(await api(env, 'PATCH', `/rules/${id}`, { categoryId: cat, applyToExisting: false }, YOU));
    expect(res.updated).toBe(0);
    expect(db.rows(`SELECT category_id AS c FROM transactions WHERE name = 'SHELL'`)).toEqual([{ c: null }]);
  });
});

describe('kids', () => {
  const add = async (name: string) => json<{ id: number }>(await api(env, 'POST', '/kids', { name }, YOU));

  it('reorders and lists by sort', async () => {
    const a = await add('Ava');
    const b = await add('Ben');
    const c = await add('Cy');
    expect((await api(env, 'POST', '/kids/reorder', { ids: [c.id, a.id, b.id] }, YOU)).status).toBe(200);
    const names = (await json<{ name: string }[]>(await api(env, 'GET', '/kids', undefined, YOU))).map((k) => k.name);
    expect(names).toEqual(['Cy', 'Ava', 'Ben']);
    const me = await json(await api(env, 'GET', '/me', undefined, YOU));
    expect(me.kids.map((k: { name: string }) => k.name)).toEqual(['Cy', 'Ava', 'Ben']);
  });

  it('rejects a bad reorder body', async () => {
    expect((await api(env, 'POST', '/kids/reorder', { ids: 'x' }, YOU)).status).toBe(400);
    expect((await api(env, 'POST', '/kids/reorder', { ids: [1.5] }, YOU)).status).toBe(400);
  });

  it('hides and restores a kid', async () => {
    const a = await add('Ava');
    await add('Ben');
    await api(env, 'PATCH', `/kids/${a.id}`, { archived: true }, YOU);
    expect((await json(await api(env, 'GET', '/me', undefined, YOU))).kids.map((k: { name: string }) => k.name)).toEqual(['Ben']);
    const everyone = await json(await api(env, 'GET', '/kids', undefined, YOU));
    expect(everyone.find((k: { id: number }) => k.id === a.id).archived).toBe(1);
    await api(env, 'PATCH', `/kids/${a.id}`, { archived: false }, YOU);
    expect((await json(await api(env, 'GET', '/me', undefined, YOU))).kids).toHaveLength(2);
  });

  it('renames a kid', async () => {
    const a = await add('Ava');
    await api(env, 'PATCH', `/kids/${a.id}`, { name: 'Avery' }, YOU);
    expect((await json(await api(env, 'GET', '/kids', undefined, YOU)))[0].name).toBe('Avery');
  });

  it('adds new kids at the end after a reorder', async () => {
    const a = await add('Ava');
    const b = await add('Ben');
    await api(env, 'POST', '/kids/reorder', { ids: [b.id, a.id] }, YOU);
    await add('Cy');
    expect((await json<{ name: string }[]>(await api(env, 'GET', '/kids', undefined, YOU))).map((k) => k.name)).toEqual(['Ben', 'Ava', 'Cy']);
  });
});
