import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/worker/env';
import { rewriteCategoryIds } from '../src/shared/activityQuery';
import { api } from './helpers/api';
import { TestD1 } from './helpers/d1';
import { testEnv } from './helpers/plaid';

const YOU = 'you@example.com';
const PARTNER = 'partner@example.com';

let db: TestD1;
let env: Env;
let you: number;
let partner: number;

const cat = (name: string) => db.rows<{ id: number }>('SELECT id FROM categories WHERE name = ? AND fun_member_id IS NULL', name)[0]!.id;
const section = (name: string) => db.rows<{ id: number }>('SELECT id FROM sections WHERE name = ?', name)[0]!.id;

async function json<T>(method: string, path: string, body?: unknown, email = YOU): Promise<{ status: number; body: T }> {
  const res = await api(env, method, path, body, email);
  return { status: res.status, body: (await res.json()) as T };
}

beforeEach(async () => {
  db = new TestD1();
  env = testEnv(db);
  await api(env, 'GET', '/me', undefined, YOU);
  await api(env, 'GET', '/me', undefined, PARTNER);
  const member = (email: string) => db.rows<{ id: number }>('SELECT id FROM members WHERE email = ?', email)[0]!.id;
  you = member(YOU);
  partner = member(PARTNER);
  db.exec(`INSERT INTO accounts (id, name, type) VALUES (1, 'Card', 'credit')`);
});

describe('rewriting a saved query after a merge', () => {
  it('re-points the merged id in either form and drops duplicates', () => {
    expect(rewriteCategoryIds('q=shell&categoryId=3', 3, 9)).toBe('q=shell&categoryId=9');
    expect(rewriteCategoryIds('categoryId=3,5&month=all', 3, 9)).toBe('categoryId=9%2C5&month=all');
    expect(rewriteCategoryIds('categoryId=5&categoryId=3', 3, 5)).toBe('categoryId=5');
    expect(rewriteCategoryIds('category=3&q=x', 3, 9)).toBe('categoryId=9&q=x');
  });

  it('leaves queries that don’t name the merged id alone (31 is not 3)', () => {
    expect(rewriteCategoryIds('categoryId=31,13', 3, 9)).toBeNull();
    expect(rewriteCategoryIds('q=3', 3, 9)).toBeNull();
    expect(rewriteCategoryIds('', 3, 9)).toBeNull();
  });
});

describe('a category merge re-points saved searches', () => {
  async function saved(name: string, query: string, email: string) {
    const res = await json<{ id: number }>('POST', '/saved-searches', { name, query }, email);
    expect(res.status).toBe(201);
    return res.body.id;
  }
  const queryOf = (id: number) => db.rows<{ query: string }>('SELECT query FROM saved_searches WHERE id = ?', id)[0]!.query;

  it('for both people, only where the merged id appears, and not on preview', async () => {
    const from = (await json<{ id: number }>('POST', '/categories', { name: 'Coffee runs', sectionId: section('Fun & Wants') })).body.id;
    const into = cat('Eating Out');
    const other = cat('Groceries');
    const lookalike = Number(`${from}1`);
    const mine = await saved('Coffee', `q=latte&categoryId=${from}`, YOU);
    const both = await saved('Food', `categoryId=${other},${from}&month=all`, YOU);
    const dupe = await saved('Dupe', `categoryId=${into}&categoryId=${from}`, YOU);
    const theirs = await saved('Their coffee', `categoryId=${from}&needs=1`, PARTNER);
    const legacy = await saved('Old link', `category=${from}`, PARTNER);
    const untouched = await saved('Lookalike', `categoryId=${lookalike}&q=${from}`, YOU);

    const preview = await json<{ preview: boolean }>('POST', `/categories/${from}/merge?preview=1`, { intoId: into });
    expect(preview.status).toBe(200);
    expect(queryOf(mine)).toBe(`q=latte&categoryId=${from}`);

    const merged = await json<{ preview: boolean }>('POST', `/categories/${from}/merge`, { intoId: into });
    expect(merged.status).toBe(200);
    expect(queryOf(mine)).toBe(`q=latte&categoryId=${into}`);
    expect(queryOf(both)).toBe(`categoryId=${other}%2C${into}&month=all`);
    expect(queryOf(dupe)).toBe(`categoryId=${into}`);
    expect(queryOf(theirs)).toBe(`categoryId=${into}&needs=1`);
    expect(queryOf(legacy)).toBe(`categoryId=${into}`);
    expect(queryOf(untouched)).toBe(`categoryId=${lookalike}&q=${from}`);
    // Each person still sees only their own.
    const list = await json<{ id: number }[]>('GET', '/saved-searches', undefined, PARTNER);
    expect(list.body.map((s) => s.id).sort()).toEqual([theirs, legacy].sort());
  });
});

describe('bills search and sub-categories', () => {
  function bill(name: string, merchant: string, categoryId: number) {
    db.exec(
      `INSERT INTO recurring_bills (merchant, name, cadence, expected_amount_cents, status, category_id)
       VALUES (?, ?, 'monthly', 1500, 'confirmed', ?)`,
      merchant,
      name,
      categoryId,
    );
    return db.rows<{ id: number }>('SELECT MAX(id) AS id FROM recurring_bills')[0]!.id;
  }

  it('a search for a parent’s name also finds bills in its sub-categories', async () => {
    const parent = cat('Subscriptions');
    const child = (await json<{ id: number }>('POST', '/categories', { name: 'Streaming', parentId: parent })).body.id;
    const direct = bill('Cloud storage', 'cloudco', parent);
    const nested = bill('Movie service', 'flixco', child);
    bill('Phone', 'phoneco', cat('Phone'));
    const res = await json<{ id: number }[]>('GET', '/recurring?q=subscriptions');
    expect(res.body.map((b) => b.id).sort((a, b) => a - b)).toEqual([direct, nested]);
    const byChild = await json<{ id: number }[]>('GET', '/recurring?q=streaming');
    expect(byChild.body.map((b) => b.id)).toEqual([nested]);
  });

  it('PATCH changes how often a bill repeats', async () => {
    const id = bill('Water', 'waterco', cat('Utilities'));
    expect((await json('PATCH', `/recurring/${id}`, { cadence: 'quarterly' })).status).toBe(200);
    expect(db.rows<{ cadence: string }>('SELECT cadence FROM recurring_bills WHERE id = ?', id)[0]!.cadence).toBe('quarterly');
    expect((await json('PATCH', `/recurring/${id}`, { cadence: 'hourly' })).status).toBe(400);
  });
});

describe('Activity: only left-out charges', () => {
  it('ignored=only lists left-out charges and nothing else; privacy holds', async () => {
    const add = (name: string, ignored: number, privateTo: number | null = null) => {
      db.exec(
        `INSERT INTO transactions (account_id, date, amount_cents, name, source, is_ignored, private_member_id)
         VALUES (1, '2026-10-05', -500, ?, 'manual', ?, ?)`,
        name,
        ignored,
        privateTo,
      );
      return db.rows<{ id: number }>('SELECT MAX(id) AS id FROM transactions')[0]!.id;
    };
    const out = add('LEFT OUT', 1);
    add('COUNTED', 0);
    add('PARTNER SECRET', 1, partner);
    const mine = add('MY SECRET', 1, you);
    const res = await json<{ transactions: { id: number }[]; totals: { count: number } }>('GET', '/transactions?ignored=only');
    expect(res.body.transactions.map((t) => t.id).sort((a, b) => a - b)).toEqual([out, mine]);
    expect(res.body.totals.count).toBe(2);
  });
});
