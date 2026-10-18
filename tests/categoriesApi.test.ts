import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/worker/env';
import { CATEGORY_REFERENCES } from '../src/worker/services/categories';
import { api } from './helpers/api';
import { TestD1 } from './helpers/d1';
import { testEnv } from './helpers/plaid';

const YOU = 'you@example.com';
const PARTNER = 'partner@example.com';

interface Cat {
  id: number;
  sectionId: number;
  sectionName: string;
  name: string;
  kind: string;
  parentId: number | null;
  funMemberId: number | null;
  archived: boolean;
}

describe('categories API', () => {
  let db: TestD1;
  let env: Env;
  let youId: number;
  let partnerId: number;

  const section = (name: string) => db.rows<{ id: number }>('SELECT id FROM sections WHERE name = ?', name)[0]!.id;
  const category = (sectionName: string, name: string) =>
    db.rows<{ id: number }>(
      'SELECT c.id FROM categories c JOIN sections s ON s.id = c.section_id WHERE s.name = ? AND c.name = ?',
      sectionName,
      name,
    )[0]!.id;
  const funOf = (memberId: number) => db.rows<{ id: number }>('SELECT id FROM categories WHERE fun_member_id = ?', memberId)[0]!.id;
  const row = (id: number) =>
    db.rows<{ section_id: number; parent_id: number | null; kind: string; archived: number; sort: number; name: string }>(
      'SELECT section_id, parent_id, kind, archived, sort, name FROM categories WHERE id = ?',
      id,
    )[0]!;
  const list = async () => ((await (await api(env, 'GET', '/categories')).json()) as { categories: Cat[] }).categories;
  const add = async (body: Record<string, unknown>) => {
    const res = await api(env, 'POST', '/categories', body);
    return { status: res.status, body: (await res.json()) as { id: number; error?: string } };
  };
  const patch = async (id: number, body: Record<string, unknown>, email?: string) => {
    const res = await api(env, 'PATCH', `/categories/${id}`, body, email);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  function charge(categoryId: number | null, cents = -1000, extra: Record<string, string | number | null> = {}) {
    const cols = ['account_id', 'date', 'amount_cents', 'name', 'source', 'category_id', ...Object.keys(extra)];
    db.exec(
      `INSERT INTO transactions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      1,
      '2026-10-05',
      cents,
      'CHARGE',
      'manual',
      categoryId,
      ...Object.values(extra),
    );
    return db.rows<{ id: number }>('SELECT MAX(id) AS id FROM transactions')[0]!.id;
  }

  beforeEach(async () => {
    db = new TestD1();
    env = testEnv(db);
    await api(env, 'GET', '/me', undefined, YOU);
    await api(env, 'GET', '/me', undefined, PARTNER);
    youId = db.rows<{ id: number }>('SELECT id FROM members WHERE email = ?', YOU)[0]!.id;
    partnerId = db.rows<{ id: number }>('SELECT id FROM members WHERE email = ?', PARTNER)[0]!.id;
    db.exec(`INSERT INTO accounts (id, name, type) VALUES (1, 'Card', 'credit')`);
  });

  describe('sub-categories', () => {
    it('migration 0007 adds categories.parent_id', () => {
      const cols = db.rows<{ name: string }>("SELECT name FROM pragma_table_info('categories')").map((c) => c.name);
      expect(cols).toContain('parent_id');
    });

    it('adds a sub-category under a parent: same group, kind follows the parent', async () => {
      const habits = category('Habits', 'Habits');
      const created = await add({ parentId: habits, name: 'Cigarettes' });
      expect(created.status).toBe(201);
      expect(row(created.body.id)).toMatchObject({ section_id: section('Habits'), parent_id: habits, kind: 'expense' });
      // In Income a new category is income, whatever was sent.
      const income = await add({ sectionId: section('Income'), name: 'Side gig', kind: 'expense' });
      expect(row(income.body.id).kind).toBe('income');
      // Debt is still allowed in a spending group (like Loans).
      const loan = await add({ sectionId: section('Bills'), name: 'Car loan', kind: 'debt' });
      expect(row(loan.body.id).kind).toBe('debt');
    });

    it('refuses two levels, Fun Money parents, archived or missing parents and a mismatched group', async () => {
      const habits = category('Habits', 'Habits');
      const child = (await add({ parentId: habits, name: 'Snacks' })).body.id;
      expect((await add({ parentId: child, name: 'Chips' })).status).toBe(400);
      expect((await add({ parentId: funOf(youId), name: 'Games' })).status).toBe(400);
      expect((await add({ parentId: 99999, name: 'Nope' })).status).toBe(400);
      expect((await add({ parentId: habits, sectionId: section('Bills'), name: 'Mismatch' })).status).toBe(400);
      const groceries = category('Everyday', 'Groceries');
      await patch(groceries, { archived: true });
      expect((await add({ parentId: groceries, name: 'Produce' })).status).toBe(400);
    });

    it('special categories (and Fun Money) never become sub-categories', async () => {
      const savingParent = (await add({ sectionId: section('Saving'), name: 'Emergency' })).body.id;
      const otherIncome = category('Income', 'Other Income');
      const transfersParent = (await add({ sectionId: section('Transfers'), name: 'Between accounts' })).body.id;
      const carUpkeep = category('Everyday', 'Car Upkeep');
      expect((await patch(category('Income', 'Paychecks'), { parentId: otherIncome })).status).toBe(400);
      expect((await patch(category('Saving', 'Savings & Planned Costs'), { parentId: savingParent })).status).toBe(400);
      expect((await patch(category('Transfers', 'Transfers'), { parentId: transfersParent })).status).toBe(400);
      expect((await patch(category('Everyday', 'Gas'), { parentId: carUpkeep })).status).toBe(400);
      expect((await patch(category('Habits', 'Habits'), { parentId: category('Habits', 'Coffee & Fast Food') })).status).toBe(400);
      expect((await patch(funOf(youId), { parentId: category('Fun & Wants', 'Gifts') })).status).toBe(400);
      // A new category can't take a special one's place under a parent either.
      db.exec("UPDATE categories SET name = 'Fuel' WHERE id = ?", category('Everyday', 'Gas'));
      expect((await add({ parentId: carUpkeep, name: 'Gas' })).status).toBe(400);
      expect(db.rows('SELECT COUNT(*) AS n FROM categories WHERE parent_id IS NOT NULL')).toEqual([{ n: 0 }]);
    });

    it('GET /categories returns parentId, ordered group → parent → its children by sort', async () => {
      const habits = category('Habits', 'Habits');
      const coffee = category('Habits', 'Coffee & Fast Food');
      const snacks = (await add({ parentId: habits, name: 'Snacks' })).body.id;
      const cigs = (await add({ parentId: habits, name: 'Cigarettes' })).body.id;
      const latte = (await add({ parentId: coffee, name: 'Lattes' })).body.id;
      const cats = await list();
      const habitsRows = cats.filter((c) => c.sectionName === 'Habits').map((c) => [c.name, c.parentId]);
      expect(habitsRows).toEqual([
        ['Habits', null],
        ['Snacks', habits],
        ['Cigarettes', habits],
        ['Coffee & Fast Food', null],
        ['Lattes', coffee],
      ]);
      expect(cats.find((c) => c.id === snacks)).toMatchObject({ parentId: habits, sectionId: section('Habits') });
      expect([cigs, latte].every((id) => cats.some((c) => c.id === id))).toBe(true);
    });
  });

  describe('PATCH /categories/:id', () => {
    it('moves a category to another group; kind follows the group (debt stays debt between spending groups)', async () => {
      const gifts = category('Fun & Wants', 'Gifts');
      expect((await patch(gifts, { sectionId: section('Everyday') })).status).toBe(200);
      expect(row(gifts)).toMatchObject({ section_id: section('Everyday'), kind: 'expense' });
      await patch(gifts, { sectionId: section('Saving') });
      expect(row(gifts).kind).toBe('savings');
      const loans = category('Bills', 'Loans');
      await patch(loans, { sectionId: section('Everyday') });
      expect(row(loans).kind).toBe('debt');
    });

    it('a moved category goes to the end of its new group', async () => {
      const gifts = category('Fun & Wants', 'Gifts');
      await patch(gifts, { sectionId: section('Everyday') });
      const everyday = (await list()).filter((c) => c.sectionName === 'Everyday' && c.parentId === null);
      expect(everyday.at(-1)!.id).toBe(gifts);
    });

    it('refuses moving Fun Money categories (yours or your partner’s)', async () => {
      expect((await patch(funOf(youId), { sectionId: section('Everyday') })).status).toBe(400);
      expect((await patch(funOf(partnerId), { sectionId: section('Everyday') })).status).toBe(400);
      expect((await patch(funOf(youId), { parentId: category('Fun & Wants', 'Gifts') })).status).toBe(400);
      expect(row(funOf(youId)).section_id).toBe(section('Fun & Wants'));
    });

    it('income ↔ spending for a category with charges needs confirm', async () => {
      const gifts = category('Fun & Wants', 'Gifts');
      charge(gifts);
      const refused = await patch(gifts, { sectionId: section('Income') });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ needsConfirm: true, transactionCount: 1, kind: 'income' });
      expect(row(gifts).kind).toBe('expense');
      expect((await patch(gifts, { sectionId: section('Income'), confirm: true })).status).toBe(200);
      expect(row(gifts)).toMatchObject({ kind: 'income', section_id: section('Income') });
      // Without charges no confirmation is needed.
      const shopping = category('Fun & Wants', 'Shopping');
      expect((await patch(shopping, { sectionId: section('Income') })).status).toBe(200);
    });

    it('counts a parent’s children when asking to confirm, and the children move with it', async () => {
      const gifts = category('Fun & Wants', 'Gifts');
      const kids = (await add({ parentId: gifts, name: 'Birthday gifts' })).body.id;
      charge(kids);
      const refused = await patch(gifts, { sectionId: section('Income') });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ transactionCount: 1 });
      await patch(gifts, { sectionId: section('Income'), confirm: true });
      expect(row(kids)).toMatchObject({ section_id: section('Income'), kind: 'income', parent_id: gifts });
    });

    it('nests and un-nests: a child takes the parent’s group and kind', async () => {
      const coffee = category('Habits', 'Coffee & Fast Food');
      const eatingOut = category('Fun & Wants', 'Eating Out');
      expect((await patch(coffee, { parentId: eatingOut })).status).toBe(200);
      expect(row(coffee)).toMatchObject({ parent_id: eatingOut, section_id: section('Fun & Wants') });
      expect((await patch(coffee, { parentId: null })).status).toBe(200);
      expect(row(coffee)).toMatchObject({ parent_id: null, section_id: section('Fun & Wants') });
    });

    it('refuses: a parent with children becoming a child, nesting under a child or itself, a child changing group alone', async () => {
      const habits = category('Habits', 'Habits');
      const coffee = category('Habits', 'Coffee & Fast Food');
      const snacks = (await add({ parentId: habits, name: 'Snacks' })).body.id;
      expect((await patch(habits, { parentId: coffee })).status).toBe(400);
      expect((await patch(coffee, { parentId: snacks })).status).toBe(400);
      expect((await patch(coffee, { parentId: coffee })).status).toBe(400);
      expect((await patch(snacks, { sectionId: section('Bills') })).status).toBe(400);
      // Moving it out of its parent into another group is fine.
      expect((await patch(snacks, { parentId: null, sectionId: section('Everyday') })).status).toBe(200);
      expect(row(snacks)).toMatchObject({ parent_id: null, section_id: section('Everyday') });
    });

    it('hiding a parent hides its children; a child can’t be shown while its parent is hidden', async () => {
      // Habits itself can't be hidden (the app relies on it), so a plain parent stands in.
      const habits = category('Everyday', 'Household & Personal');
      const snacks = (await add({ parentId: habits, name: 'Snacks' })).body.id;
      await patch(habits, { archived: true });
      expect(row(snacks).archived).toBe(1);
      expect((await patch(snacks, { archived: false })).status).toBe(400);
      await patch(habits, { archived: false });
      expect(row(habits).archived).toBe(0);
      expect((await patch(snacks, { archived: false })).status).toBe(200);
    });

    it('renames', async () => {
      const gifts = category('Fun & Wants', 'Gifts');
      await patch(gifts, { name: 'Presents' });
      expect(row(gifts).name).toBe('Presents');
    });
  });

  describe('POST /categories/reorder', () => {
    it('sets the order of a group’s top-level categories', async () => {
      const ids = (await list()).filter((c) => c.sectionName === 'Everyday' && c.parentId === null).map((c) => c.id);
      const reversed = [...ids].reverse();
      const res = await api(env, 'POST', '/categories/reorder', { sectionId: section('Everyday'), ids: reversed });
      expect(res.status).toBe(200);
      expect((await list()).filter((c) => c.sectionName === 'Everyday').map((c) => c.id)).toEqual(reversed);
    });

    it('orders a parent’s children; ones left out keep their order after the listed ones', async () => {
      const habits = category('Habits', 'Habits');
      const a = (await add({ parentId: habits, name: 'A' })).body.id;
      const b = (await add({ parentId: habits, name: 'B' })).body.id;
      const c = (await add({ parentId: habits, name: 'C' })).body.id;
      const res = await api(env, 'POST', '/categories/reorder', { sectionId: section('Habits'), parentId: habits, ids: [c] });
      expect(res.status).toBe(200);
      expect((await list()).filter((x) => x.parentId === habits).map((x) => x.id)).toEqual([c, a, b]);
    });

    it('refuses ids that aren’t siblings there, and duplicates', async () => {
      const habits = category('Habits', 'Habits');
      const groceries = category('Everyday', 'Groceries');
      expect((await api(env, 'POST', '/categories/reorder', { sectionId: section('Habits'), ids: [groceries] })).status).toBe(400);
      expect((await api(env, 'POST', '/categories/reorder', { sectionId: section('Habits'), ids: [habits, habits] })).status).toBe(400);
      expect(
        (await api(env, 'POST', '/categories/reorder', { sectionId: section('Habits'), parentId: habits, ids: [habits] })).status,
      ).toBe(400);
    });
  });

  describe('POST /categories/:id/merge', () => {
    /** Every column that names a category, found from the schema itself. */
    const referencingColumns = () =>
      db
        .rows<{ tbl: string; col: string }>(
          `SELECT m.name AS tbl, p.name AS col FROM sqlite_master m JOIN pragma_table_info(m.name) p
            WHERE m.type = 'table' AND (p.name LIKE '%category_id'
               OR EXISTS (SELECT 1 FROM pragma_foreign_key_list(m.name) f WHERE f."table" = 'categories' AND f."from" = p.name))
            ORDER BY 1, 2`,
        )
        .map((r) => `${r.tbl}.${r.col}`);

    it('covers every column that names a category', () => {
      expect(referencingColumns()).toEqual(CATEGORY_REFERENCES.map((r) => `${r.table}.${r.column}`).sort());
    });

    function seedReferences(from: number, into: number) {
      const txn = charge(from, -5000);
      const split = charge(null, -3000, { is_split: 1 });
      db.exec('INSERT INTO splits (transaction_id, category_id, amount_cents) VALUES (?, ?, -3000)', split, from);
      db.exec("INSERT INTO budget_lines (month, category_id, budget_cents, timing, due_day, notes) VALUES ('2026-10', ?, 1000, 'due_day', 5, 'a')", from);
      db.exec("INSERT INTO budget_lines (month, category_id, budget_cents, timing, due_day, notes) VALUES ('2026-10', ?, 2000, 'due_day', 9, 'b')", into);
      db.exec("INSERT INTO budget_lines (month, category_id, budget_cents, timing, due_day) VALUES ('2026-11', ?, 700, 'due_day', 3)", from);
      db.exec("INSERT INTO kids (id, name) VALUES (1, 'Ada')");
      db.exec("INSERT INTO kid_budgets (kid_id, category_id, month, budget_cents) VALUES (1, ?, '2026-10', 400), (1, ?, '2026-10', 600)", from, into);
      db.exec("INSERT INTO rules (position, match_text, category_id) VALUES (1, 'TACO', ?)", from);
      db.exec("INSERT INTO recurring_bills (merchant, name, cadence, expected_amount_cents, category_id) VALUES ('x', 'X', 'monthly', 100, ?)", from);
      db.exec("INSERT INTO goals (name, target_cents, category_id) VALUES ('G', 100, ?)", from);
      db.exec("INSERT INTO planned_costs (id, name, start_month) VALUES (1, 'P', '2026-10')");
      db.exec('INSERT INTO planned_cost_categories (planned_cost_id, category_id) VALUES (1, ?)', from);
      db.exec('INSERT INTO category_moves (id, member_id, fix_category_id) VALUES (1, ?, ?)', youId, from);
      db.exec('INSERT INTO category_move_items (move_id, transaction_id, old_category_id, new_category_id) VALUES (1, ?, ?, ?)', txn, from, from);
      return { txn, split };
    }

    it('re-points every reference, sums budgets per month, archives the merged one and returns counts', async () => {
      const from = category('Fun & Wants', 'Shopping');
      const into = category('Fun & Wants', 'Gifts');
      const child = (await add({ parentId: from, name: 'Clothes' })).body.id;
      seedReferences(from, into);

      const preview = await api(env, 'POST', `/categories/${from}/merge?preview=1`, { intoId: into });
      expect(preview.status).toBe(200);
      const previewBody = (await preview.json()) as { preview: boolean; counts: Record<string, number> };
      expect(previewBody.preview).toBe(true);
      // Nothing changed.
      expect(db.rows('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?', from)).toEqual([{ n: 1 }]);
      expect(row(from).archived).toBe(0);

      const res = await api(env, 'POST', `/categories/${from}/merge`, { intoId: into });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { preview: boolean; counts: Record<string, number> };
      expect(body.preview).toBe(false);
      expect(body.counts).toEqual(previewBody.counts);
      expect(body.counts).toEqual({
        transactions: 1,
        splits: 1,
        budgetLines: 2,
        kidBudgets: 1,
        rules: 1,
        bills: 1,
        goals: 1,
        plannedCosts: 1,
        subCategories: 1,
      });

      // Nothing names the merged category any more.
      for (const ref of CATEGORY_REFERENCES) {
        const stale = db.rows(`SELECT 1 FROM ${ref.table} WHERE ${ref.column} = ?`, from);
        expect(stale, `${ref.table}.${ref.column}`).toEqual([]);
      }
      expect(row(from).archived).toBe(1);
      expect(row(child)).toMatchObject({ parent_id: into, section_id: section('Fun & Wants') });
      expect(db.rows('SELECT month, budget_cents, timing, due_day, notes FROM budget_lines WHERE category_id = ? ORDER BY month', into)).toEqual([
        { month: '2026-10', budget_cents: 3000, timing: 'even', due_day: null, notes: 'b; a' },
        { month: '2026-11', budget_cents: 700, timing: 'due_day', due_day: 3, notes: null },
      ]);
      expect(db.rows('SELECT budget_cents FROM kid_budgets WHERE category_id = ?', into)).toEqual([{ budget_cents: 1000 }]);
      expect(db.rows('SELECT category_id FROM planned_cost_categories')).toEqual([{ category_id: into }]);
      expect(db.rows('SELECT fix_category_id AS id FROM category_moves')).toEqual([{ id: into }]);
      expect(db.rows('SELECT old_category_id AS o, new_category_id AS n FROM category_move_items')).toEqual([{ o: into, n: into }]);
    });

    describe('a bulk change made before the merge', () => {
      const state = (id: number) =>
        db.rows<{ category_id: number | null; category_source: string | null; kid_id: number | null; is_ignored: number }>(
          'SELECT category_id, category_source, kid_id, is_ignored FROM transactions WHERE id = ?',
          id,
        )[0]!;
      const bulk = async (ids: number[], set: Record<string, unknown>) => {
        const res = await api(env, 'POST', '/transactions/bulk', { ids, set });
        expect(res.status).toBe(200);
        return (await res.json()) as { updated: number; moveId: number };
      };
      const undo = async (moveId: number) => {
        const res = await api(env, 'POST', `/category-moves/${moveId}/undo`, {});
        expect(res.status).toBe(200);
        return ((await res.json()) as { restored: number }).restored;
      };

      it('set to the merged category: Undo still finds the charges and puts back what they had', async () => {
        const from = category('Fun & Wants', 'Shopping');
        const into = category('Fun & Wants', 'Gifts');
        const groceries = category('Everyday', 'Groceries');
        const filed = charge(groceries, -2000, { category_source: 'auto' });
        const empty = charge(null, -3000);
        const before = [filed, empty].map(state);

        const { moveId, updated } = await bulk([filed, empty], { categoryId: from });
        expect(updated).toBe(2);
        expect((await api(env, 'POST', `/categories/${from}/merge`, { intoId: into })).status).toBe(200);
        expect(state(filed).category_id).toBe(into);

        expect(await undo(moveId)).toBe(2);
        expect([filed, empty].map(state)).toEqual(before);
      });

      it('moved off the merged category: Undo puts them in the surviving one, not the archived one', async () => {
        const from = category('Fun & Wants', 'Shopping');
        const into = category('Fun & Wants', 'Gifts');
        const groceries = category('Everyday', 'Groceries');
        const a = charge(from, -2000, { category_source: 'auto' });
        const b = charge(from, -3000, { category_source: 'user' });

        const { moveId } = await bulk([a, b], { categoryId: groceries });
        expect((await api(env, 'POST', `/categories/${from}/merge`, { intoId: into })).status).toBe(200);

        expect(await undo(moveId)).toBe(2);
        expect(state(a)).toMatchObject({ category_id: into, category_source: 'auto' });
        expect(state(b)).toMatchObject({ category_id: into, category_source: 'user' });
        expect(db.rows('SELECT id FROM transactions WHERE category_id = ?', from)).toEqual([]);
      });
    });

    it('when both are in planned costs, the merged one’s link is dropped', async () => {
      const from = category('Fun & Wants', 'Shopping');
      const into = category('Fun & Wants', 'Gifts');
      db.exec("INSERT INTO planned_costs (id, name, start_month) VALUES (1, 'P', '2026-10'), (2, 'Q', '2026-10')");
      db.exec('INSERT INTO planned_cost_categories (planned_cost_id, category_id) VALUES (1, ?), (2, ?)', from, into);
      expect((await api(env, 'POST', `/categories/${from}/merge`, { intoId: into })).status).toBe(200);
      expect(db.rows('SELECT planned_cost_id, category_id FROM planned_cost_categories')).toEqual([{ planned_cost_id: 2, category_id: into }]);
    });

    it('a child merges into its parent', async () => {
      const habits = category('Habits', 'Habits');
      const snacks = (await add({ parentId: habits, name: 'Snacks' })).body.id;
      charge(snacks);
      expect((await api(env, 'POST', `/categories/${snacks}/merge`, { intoId: habits })).status).toBe(200);
      expect(db.rows('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?', habits)).toEqual([{ n: 1 }]);
    });

    it('refuses: into itself, into its own child, a parent into a child, archived targets, Fun Money either way', async () => {
      const habits = category('Habits', 'Habits');
      const coffee = category('Habits', 'Coffee & Fast Food');
      const snacks = (await add({ parentId: habits, name: 'Snacks' })).body.id;
      const lattes = (await add({ parentId: coffee, name: 'Lattes' })).body.id;
      const merge = async (from: number, intoId: number) => (await api(env, 'POST', `/categories/${from}/merge`, { intoId })).status;
      expect(await merge(habits, habits)).toBe(400);
      expect(await merge(habits, snacks)).toBe(400);
      expect(await merge(habits, lattes)).toBe(400);
      const gifts = category('Fun & Wants', 'Gifts');
      await patch(gifts, { archived: true });
      expect(await merge(coffee, gifts)).toBe(400);
      const shopping = category('Fun & Wants', 'Shopping');
      expect(await merge(shopping, funOf(youId))).toBe(400);
      expect(await merge(funOf(youId), shopping)).toBe(400);
      expect(await merge(funOf(youId), funOf(partnerId))).toBe(400);
      expect(await merge(shopping, funOf(partnerId))).toBe(400);
      expect(await merge(999999, shopping)).toBe(404);
      expect(row(habits).archived).toBe(0);
    });

    it('refuses merging away the categories the app looks up by name', async () => {
      const paychecks = category('Income', 'Paychecks');
      const other = category('Income', 'Other Income');
      expect((await api(env, 'POST', `/categories/${paychecks}/merge`, { intoId: other })).status).toBe(400);
    });

    it('a sub-category name already used in the target’s group: 409 in preview and merge, nothing changed', async () => {
      const shopping = category('Fun & Wants', 'Shopping');
      const groceries = category('Everyday', 'Groceries');
      const kids = category('Everyday', 'Kids');
      // Shopping › Gas would land in Everyday next to Everyday › Gas.
      const gas = (await add({ parentId: shopping, name: 'Gas' })).body.id;
      expect((await api(env, 'POST', `/categories/${shopping}/merge?preview=1`, { intoId: groceries })).status).toBe(409);
      expect((await api(env, 'POST', `/categories/${shopping}/merge`, { intoId: kids })).status).toBe(409);
      expect(row(shopping).archived).toBe(0);
      expect(row(gas).parent_id).toBe(shopping);
    });

    it('income into spending with charges needs confirm', async () => {
      const refunds = category('Income', 'Refunds');
      const shopping = category('Fun & Wants', 'Shopping');
      charge(refunds, 500);
      const res = await api(env, 'POST', `/categories/${refunds}/merge`, { intoId: shopping });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ needsConfirm: true, transactionCount: 1 });
      expect((await api(env, 'POST', `/categories/${refunds}/merge`, { intoId: shopping, confirm: true })).status).toBe(200);
    });

    it('a preview that needs confirming says so with 200 and the counts', async () => {
      const refunds = category('Income', 'Refunds');
      const shopping = category('Fun & Wants', 'Shopping');
      charge(refunds, 500);
      const res = await api(env, 'POST', `/categories/${refunds}/merge?preview=1`, { intoId: shopping });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ preview: true, needsConfirm: true, counts: { transactions: 1 } });
      expect(row(refunds).archived).toBe(0);
    });

    it('only a partner’s private charges: no confirm needed (their charges stay unmentioned)', async () => {
      const refunds = category('Income', 'Refunds');
      const shopping = category('Fun & Wants', 'Shopping');
      charge(refunds, 500, { private_member_id: partnerId });
      const preview = await api(env, 'POST', `/categories/${refunds}/merge?preview=1`, { intoId: shopping });
      expect(await preview.json()).toMatchObject({ needsConfirm: false, counts: { transactions: 0 } });
      expect((await api(env, 'POST', `/categories/${refunds}/merge`, { intoId: shopping })).status).toBe(200);
      const gifts = category('Fun & Wants', 'Gifts');
      charge(gifts, -500, { private_member_id: partnerId });
      expect((await patch(gifts, { sectionId: section('Income') })).status).toBe(200);
    });

    it('merged budget lines record who and when', async () => {
      const from = category('Fun & Wants', 'Shopping');
      const into = category('Fun & Wants', 'Gifts');
      db.exec("INSERT INTO budget_lines (month, category_id, budget_cents, updated_at) VALUES ('2026-10', ?, 100, '2020-01-01'), ('2026-10', ?, 200, '2020-01-01'), ('2026-11', ?, 300, '2020-01-01')", from, into, from);
      await api(env, 'POST', `/categories/${from}/merge`, { intoId: into });
      const lines = db.rows<{ updated_at: string; updated_by_member_id: number }>('SELECT updated_at, updated_by_member_id FROM budget_lines WHERE category_id = ?', into);
      expect(lines).toHaveLength(2);
      for (const l of lines) expect(l).toMatchObject({ updated_by_member_id: youId, updated_at: expect.stringMatching(/^20[2-9]\d-/) });
      expect(lines.every((l) => l.updated_at > '2020-01-02')).toBe(true);
    });

    it('undoing a learned move made before the merge restores the rule to the surviving category', async () => {
      const from = category('Fun & Wants', 'Shopping');
      const into = category('Fun & Wants', 'Gifts');
      const other = category('Everyday', 'Groceries');
      db.exec("INSERT INTO rules (id, position, match_text, category_id, learned) VALUES (7, 1, 'target', ?, 1)", other);
      const before = { position: 1, match_field: 'any', match_text: 'target', account_id: null, category_id: from, kid_id: null, private_member_id: null, ignore_txn: 0, owner_member_id: null, amount_min_cents: null, amount_max_cents: null, learned: 1 };
      db.exec('INSERT INTO category_moves (id, member_id, rule_id, rule_before, fix_category_id, created_at) VALUES (1, ?, 7, ?, ?, ?)', youId, JSON.stringify(before), other, new Date().toISOString());
      expect((await api(env, 'POST', `/categories/${from}/merge`, { intoId: into })).status).toBe(200);
      expect(JSON.parse(db.rows<{ r: string }>('SELECT rule_before AS r FROM category_moves')[0]!.r).category_id).toBe(into);
      expect((await api(env, 'POST', '/category-moves/1/undo', {})).status).toBe(200);
      expect(db.rows('SELECT category_id FROM rules WHERE id = 7')).toEqual([{ category_id: into }]);
    });

    it('counts only charges you can see', async () => {
      const from = category('Fun & Wants', 'Shopping');
      const into = category('Fun & Wants', 'Gifts');
      charge(from, -100, { private_member_id: partnerId });
      charge(from, -100);
      const res = await api(env, 'POST', `/categories/${from}/merge?preview=1`, { intoId: into });
      expect(((await res.json()) as { counts: { transactions: number } }).counts.transactions).toBe(1);
    });
  });

  describe('GET /transactions?categoryId', () => {
    it('a parent includes its sub-categories (and split parts in them)', async () => {
      const habits = category('Habits', 'Habits');
      const snacks = (await add({ parentId: habits, name: 'Snacks' })).body.id;
      const a = charge(habits);
      const b = charge(snacks);
      const split = charge(null, -3000, { is_split: 1 });
      db.exec('INSERT INTO splits (transaction_id, category_id, amount_cents) VALUES (?, ?, -3000)', split, snacks);
      charge(category('Everyday', 'Groceries'));
      const ids = async (categoryId: number) =>
        ((await (await api(env, 'GET', `/transactions?categoryId=${categoryId}`)).json()) as { transactions: { id: number }[] }).transactions
          .map((t) => t.id)
          .sort((x, y) => x - y);
      expect(await ids(habits)).toEqual([a, b, split]);
      expect(await ids(snacks)).toEqual([b, split]);
    });
  });
});
