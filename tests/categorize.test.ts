import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/worker/env';
import { api } from './helpers/api';
import { TestD1 } from './helpers/d1';
import { testEnv } from './helpers/plaid';

type Step = { updated: number; nextAfterId: number | null };
type MeBody = { household: { categorizedAllAt: string | null; habitCutoffCents: number } };

describe('POST /categorize/all', () => {
  let db: TestD1;
  let env: Env;
  const catName = (id: number | null) =>
    id === null ? null : db.rows<{ name: string }>('SELECT name FROM categories WHERE id = ?', id)[0]!.name;
  const step = async (afterId?: number) =>
    (await (await api(env, 'POST', '/categorize/all', afterId === undefined ? {} : { afterId })).json()) as Step;
  const me = async () => (await (await api(env, 'GET', '/me')).json()) as MeBody;

  beforeEach(async () => {
    db = new TestD1();
    env = testEnv(db);
    await api(env, 'GET', '/me');
    db.exec(`INSERT INTO accounts (name, type) VALUES ('Card', 'credit')`);
  });

  it('recategorizes 1,200 charges in three batches, leaves hand-set ones alone, and records the run', async () => {
    const other = db.rows<{ id: number }>(`SELECT id FROM categories WHERE name = 'Shopping'`)[0]!.id;
    for (let i = 0; i < 1200; i++) {
      db.exec(
        `INSERT INTO transactions (account_id, date, amount_cents, name, normalized_merchant, source, category_id, category_source)
         VALUES (1, '2026-10-01', -1500, 'SHELL OIL 123', 'SHELL OIL', 'plaid', ?, ?)`,
        i === 0 ? other : null,
        i === 0 ? 'user' : null,
      );
    }
    expect((await me()).household.categorizedAllAt).toBeNull();

    const a = await step();
    expect(a.nextAfterId).toBe(500);
    const b = await step(a.nextAfterId!);
    expect(b.nextAfterId).toBe(1000);
    const c = await step(b.nextAfterId!);
    expect(c.nextAfterId).toBeNull();
    expect(a.updated + b.updated + c.updated).toBe(1199);

    expect(db.rows(`SELECT id FROM transactions WHERE category_id IS NULL`)).toEqual([]);
    expect(db.rows('SELECT category_id, category_source FROM transactions WHERE id = 1')).toEqual([
      { category_id: other, category_source: 'user' },
    ]);
    const household = (await me()).household;
    expect(household.categorizedAllAt).not.toBeNull();
    expect(household.habitCutoffCents).toBe(2500);
  });

  it('moves a $15 Shell charge from Habits to Gas when the cutoff drops', async () => {
    db.exec(
      `INSERT INTO transactions (account_id, date, amount_cents, name, normalized_merchant, source)
       VALUES (1, '2026-10-01', -1500, 'SHELL OIL 123', 'SHELL OIL', 'plaid')`,
    );
    await step();
    const cat = () => catName(db.rows<{ category_id: number }>('SELECT category_id FROM transactions')[0]!.category_id);
    expect(cat()).toBe('Habits');
    expect((await api(env, 'PATCH', '/household', { habitCutoffCents: 1000 })).status).toBe(200);
    await step();
    expect(cat()).toBe('Gas');
  });

  it('validates the cutoff and afterId', async () => {
    expect((await api(env, 'PATCH', '/household', { habitCutoffCents: 100001 })).status).toBe(400);
    expect((await api(env, 'PATCH', '/household', { habitCutoffCents: -1 })).status).toBe(400);
    expect((await api(env, 'POST', '/categorize/all', { afterId: -3 })).status).toBe(400);
  });
});
