import { beforeAll, describe, expect, it } from 'vitest';
import { GROUPS, kindForGroup, SPECIAL } from '../src/shared/categorySet';
import { loadIngestContext } from '../src/worker/services/context';
import { TestD1 } from './helpers/d1';

const CATEGORY_TABLES = ['transactions', 'splits', 'budget_lines', 'kid_budgets', 'rules', 'recurring_bills', 'goals'];

/** The spec's category table: [group, name, kind, kid_scoped]. Fun Money categories are per member. */
const NEW_CATEGORIES: [string, string, string, number][] = [
  ['Bills', 'Housing', 'expense', 0],
  ['Bills', 'Utilities', 'expense', 0],
  ['Bills', 'Phone', 'expense', 0],
  ['Bills', 'Internet', 'expense', 0],
  ['Bills', 'Insurance', 'expense', 0],
  ['Bills', 'Loans', 'debt', 0],
  ['Bills', 'Subscriptions', 'expense', 0],
  ['Bills', 'Childcare', 'expense', 1],
  ['Everyday', 'Groceries', 'expense', 0],
  ['Everyday', 'Gas', 'expense', 0],
  ['Everyday', 'Car Upkeep', 'expense', 0],
  ['Everyday', 'Household & Personal', 'expense', 0],
  ['Everyday', 'Medical', 'expense', 0],
  ['Everyday', 'Kids', 'expense', 1],
  ['Habits', 'Habits', 'expense', 0],
  ['Habits', 'Coffee & Fast Food', 'expense', 0],
  ['Fun & Wants', 'Eating Out', 'expense', 0],
  ['Fun & Wants', 'Shopping', 'expense', 0],
  ['Fun & Wants', 'Entertainment', 'expense', 0],
  ['Fun & Wants', 'Gifts', 'expense', 0],
  ['Saving', 'Savings & Planned Costs', 'savings', 0],
  ['Income', 'Paychecks', 'income', 0],
  ['Income', 'Other Income', 'income', 0],
  ['Income', 'Refunds', 'income', 0],
  ['Transfers', 'Transfers', 'transfer', 0],
];

type Totals = { month: string; kind: string; cents: number }[];

function id(db: TestD1, section: string, name: string): number {
  const row = db.rows<{ id: number }>(
    'SELECT c.id FROM categories c JOIN sections s ON s.id = c.section_id WHERE s.name = ? AND c.name = ?',
    section,
    name,
  )[0];
  if (!row) throw new Error(`No category ${section} › ${name}`);
  return row.id;
}

function categoryOf(db: TestD1, categoryId: number) {
  return db.rows<{ id: number; section: string; name: string; kind: string; archived: number; funMemberId: number | null }>(
    `SELECT c.id, s.name AS section, c.name, c.kind, c.archived, c.fun_member_id AS funMemberId
       FROM categories c JOIN sections s ON s.id = c.section_id WHERE c.id = ?`,
    categoryId,
  )[0];
}

/** Monthly transaction totals by category kind; `shift` restates a few old kinds as their new ones. */
function totals(db: TestD1, shift = false): Totals {
  const kind = shift
    ? `CASE c.name WHEN 'Car Payment' THEN 'debt' WHEN 'Credit Card Paydown' THEN 'transfer' ELSE c.kind END`
    : 'c.kind';
  return db.rows(
    `SELECT substr(t.date, 1, 7) AS month, ${kind} AS kind, SUM(t.amount_cents) AS cents
       FROM transactions t JOIN categories c ON c.id = t.category_id
      GROUP BY 1, 2 ORDER BY 1, 2`,
  );
}

describe('migration 0003: new category set', () => {
  const db = new TestD1({ upTo: '0002' });
  let before: Totals;
  let shiftedBefore: Totals;
  let boatId: number;
  let funId: number;
  let customInsuranceId: number;
  let foodMiscId: number;
  let healthMiscId: number;
  let venmoId: number;
  let cashGiftsId: number;

  beforeAll(() => {
    db.exec("INSERT INTO members (id, email, name) VALUES (1, 'sam@example.com', 'Sam')");
    db.exec("INSERT INTO kids (id, name) VALUES (1, 'Ada')");
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Checking')");
    db.exec(
      `INSERT INTO categories (section_id, name, kind, fun_member_id)
       SELECT id, 'Sam''s Fun Money', 'expense', 1 FROM sections WHERE name = 'Fun Money'`,
    );
    const custom = (section: string, name: string, kind = 'expense') =>
      db.exec(`INSERT INTO categories (section_id, name, kind) SELECT id, ?, ? FROM sections WHERE name = ?`, name, kind, section);
    custom('Transportation', 'Boat');
    custom('Insurance & Protection', 'Insurance');
    custom('Food', 'Misc');
    custom('Health', 'Misc');
    custom('Fun Money', 'Hobbies');
    custom('Transfers', 'Venmo', 'transfer');
    custom('Transfers', 'Cash Gifts', 'expense');
    boatId = id(db, 'Transportation', 'Boat');
    funId = id(db, 'Fun Money', "Sam's Fun Money");
    customInsuranceId = id(db, 'Insurance & Protection', 'Insurance');
    foodMiscId = id(db, 'Food', 'Misc');
    healthMiscId = id(db, 'Health', 'Misc');
    venmoId = id(db, 'Transfers', 'Venmo');
    cashGiftsId = id(db, 'Transfers', 'Cash Gifts');

    // Two charges per category in two months, every one a different amount.
    for (const month of ['2026-08', '2026-09']) {
      db.exec(
        `INSERT INTO transactions (account_id, date, amount_cents, name, source, category_id)
         SELECT 1, ? || '-15', CASE kind WHEN 'income' THEN 1 ELSE -1 END * (id * 1000 + ?), name, 'manual', id FROM categories`,
        month,
        month === '2026-08' ? 7 : 13,
      );
    }
    const txn = db.rows<{ id: number }>("SELECT id FROM transactions WHERE category_id = ? AND date = '2026-09-15'", boatId)[0]!.id;
    db.exec(
      `INSERT INTO splits (transaction_id, category_id, amount_cents) VALUES (?, ?, -2000), (?, ?, -3000)`,
      txn,
      id(db, 'Transportation', 'Fuel'),
      txn,
      id(db, 'Food', 'Dining Out'),
    );
    const line = (month: string, section: string, name: string, cents: number, timing: string, dueDay: number | null) =>
      db.exec(
        'INSERT INTO budget_lines (month, category_id, budget_cents, timing, due_day) VALUES (?, ?, ?, ?, ?)',
        month,
        id(db, section, name),
        cents,
        timing,
        dueDay,
      );
    line('2026-09', 'Utilities', 'Electric', 16500, 'due_day', 12);
    line('2026-09', 'Utilities', 'Water / Sewer', 7000, 'due_day', 20);
    line('2026-09', 'Housing', 'Mortgage / Rent', 160000, 'due_day', 1);
    line('2026-09', 'Savings & Goals', 'Emergency Fund', 40000, 'due_day', 5);
    line('2026-09', 'Savings & Goals', 'Retirement — Roth', 50000, 'due_day', 5);
    line('2026-09', 'Transportation', 'Boat', 5000, 'even', null);
    line('2026-09', 'Transfers', 'Venmo', 3000, 'even', null);
    line('2026-09', 'Transfers', 'Credit Card Payment', 2000, 'even', null);
    line('2026-09', 'Transfers', 'Cash Gifts', 1500, 'even', null);
    line('2026-09', 'Income', 'Paychecks', 774000, 'due_day', 4);
    db.exec(
      'INSERT INTO kid_budgets (kid_id, category_id, month, budget_cents) VALUES (1, ?, ?, 10000), (1, ?, ?, 5000)',
      id(db, 'Kids', 'School & Supplies'),
      '2026-09',
      id(db, 'Kids', 'Kids Clothing'),
      '2026-09',
    );
    db.exec("INSERT INTO rules (position, match_text, category_id) VALUES (1, 'TACO', ?)", id(db, 'Food', 'Dining Out'));
    db.exec(
      "INSERT INTO recurring_bills (merchant, name, cadence, expected_amount_cents, category_id) VALUES ('verizon', 'Verizon', 'monthly', 20000, ?)",
      id(db, 'Utilities', 'Mobile Phones'),
    );
    db.exec("INSERT INTO goals (name, target_cents, category_id) VALUES ('Cushion', 1000000, ?)", id(db, 'Savings & Goals', 'Emergency Fund'));

    before = totals(db);
    shiftedBefore = totals(db, true);
    db.migrate('0003');
  });

  it('moves every reference', () => {
    for (const table of CATEGORY_TABLES) {
      const stale = db.rows(
        `SELECT t.category_id FROM ${table} t JOIN categories c ON c.id = t.category_id WHERE c.archived = 1`,
      );
      expect(stale, table).toEqual([]);
    }
    expect(categoryOf(db, db.rows<{ category_id: number }>('SELECT category_id FROM rules WHERE category_id IS NOT NULL')[0]!.category_id)?.name).toBe('Eating Out');
    expect(categoryOf(db, db.rows<{ category_id: number }>('SELECT category_id FROM recurring_bills')[0]!.category_id)?.name).toBe('Phone');
    expect(categoryOf(db, db.rows<{ category_id: number }>('SELECT category_id FROM goals')[0]!.category_id)?.name).toBe('Savings & Planned Costs');
    expect(db.rows('SELECT c.name FROM splits s JOIN categories c ON c.id = s.category_id ORDER BY s.id')).toEqual([
      { name: 'Gas' },
      { name: 'Eating Out' },
    ]);
  });

  it('covers every table with category_id', () => {
    const tables = db.rows<{ name: string }>(
      `SELECT m.name FROM sqlite_master m WHERE m.type = 'table'
         AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) p WHERE p.name = 'category_id') ORDER BY m.name`,
    );
    expect(tables.map((t) => t.name).sort()).toEqual([...CATEGORY_TABLES].sort());
  });

  it('sums merged budgets', () => {
    expect(
      db.rows('SELECT budget_cents, timing, due_day FROM budget_lines WHERE month = ? AND category_id = ?', '2026-09', id(db, 'Bills', 'Utilities')),
    ).toEqual([{ budget_cents: 23500, timing: 'even', due_day: null }]);
    // Same timing and day: kept as is.
    expect(
      db.rows('SELECT budget_cents, timing, due_day FROM budget_lines WHERE category_id = ?', id(db, 'Saving', 'Savings & Planned Costs')),
    ).toEqual([{ budget_cents: 90000, timing: 'due_day', due_day: 5 }]);
    // A single line keeps its due day; unmoved categories keep their lines.
    expect(db.rows('SELECT budget_cents, timing, due_day FROM budget_lines WHERE category_id = ?', id(db, 'Bills', 'Housing'))).toEqual([
      { budget_cents: 160000, timing: 'due_day', due_day: 1 },
    ]);
    expect(db.rows('SELECT budget_cents FROM budget_lines WHERE category_id = ?', id(db, 'Income', 'Paychecks'))).toEqual([{ budget_cents: 774000 }]);
    expect(db.rows('SELECT budget_cents FROM budget_lines WHERE category_id = ?', boatId)).toEqual([{ budget_cents: 5000 }]);
    expect(db.rows('SELECT SUM(budget_cents) AS n FROM budget_lines')).toEqual([{ n: 16500 + 7000 + 160000 + 90000 + 5000 + 774000 + 3000 + 2000 + 1500 }]);
    expect(db.rows('SELECT kid_id, month, budget_cents FROM kid_budgets WHERE category_id = ?', id(db, 'Everyday', 'Kids'))).toEqual([
      { kid_id: 1, month: '2026-09', budget_cents: 15000 },
    ]);
  });

  it('keeps monthly totals', () => {
    // Car Payment becomes Loans (debt) and Credit Card Paydown becomes Transfers (transfer);
    // every other dollar keeps its kind.
    expect(totals(db)).toEqual(shiftedBefore);
    expect(totals(db)).not.toEqual(before);
    const byMonth = (t: Totals) => t.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.month]: (acc[r.month] ?? 0) + r.cents }), {});
    expect(byMonth(totals(db))).toEqual(byMonth(before));
    expect(db.rows('SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NULL')).toEqual([{ n: 0 }]);
  });

  it('custom categories survive', () => {
    expect(categoryOf(db, boatId)).toMatchObject({ name: 'Boat', section: 'Everyday', archived: 0 });
    expect(db.rows('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?', boatId)).toEqual([{ n: 2 }]);
    expect(categoryOf(db, id(db, 'Fun & Wants', 'Hobbies'))).toMatchObject({ archived: 0 });
  });

  it('folds custom categories into a same-named one in their new group', () => {
    const insurance = id(db, 'Bills', 'Insurance');
    expect(categoryOf(db, customInsuranceId)).toMatchObject({ section: 'Insurance & Protection', archived: 1 });
    expect(db.rows('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?', customInsuranceId)).toEqual([{ n: 0 }]);
    expect(db.rows('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?', insurance)).toEqual([{ n: 2 * 5 }]);
    // Two customs named Misc from different old sections both land in Everyday as one.
    const misc = id(db, 'Everyday', 'Misc');
    expect([foodMiscId, healthMiscId]).toContain(misc);
    expect(db.rows('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?', misc)).toEqual([{ n: 4 }]);
  });

  it('folds custom transfer categories into Transfers and leaves other kinds there', () => {
    const transfers = id(db, 'Transfers', 'Transfers');
    expect(categoryOf(db, venmoId)).toMatchObject({ section: 'Transfers', name: 'Venmo', archived: 1 });
    expect(db.rows('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?', venmoId)).toEqual([{ n: 0 }]);
    // Transfer, Credit Card Payment, Credit Card Paydown and Venmo, two charges each.
    expect(db.rows('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?', transfers)).toEqual([{ n: 8 }]);
    expect(db.rows('SELECT budget_cents FROM budget_lines WHERE category_id = ?', transfers)).toEqual([{ budget_cents: 5000 }]);
    expect(categoryOf(db, cashGiftsId)).toMatchObject({ section: 'Transfers', kind: 'expense', archived: 0 });
    expect(db.rows('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?', cashGiftsId)).toEqual([{ n: 2 }]);
    expect(db.rows('SELECT budget_cents FROM budget_lines WHERE category_id = ?', cashGiftsId)).toEqual([{ budget_cents: 1500 }]);
  });

  it('fun money stays', () => {
    expect(categoryOf(db, funId)).toMatchObject({ section: 'Fun & Wants', funMemberId: 1, archived: 0 });
    expect(db.rows('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?', funId)).toEqual([{ n: 2 }]);
  });

  it('new categories exist', () => {
    for (const [section, name, kind, kidScoped] of NEW_CATEGORIES) {
      const row = db.rows<{ kind: string; kid_scoped: number; archived: number }>(
        'SELECT kind, kid_scoped, archived FROM categories WHERE id = ?',
        id(db, section, name),
      )[0];
      expect(row, `${section} › ${name}`).toEqual({ kind, kid_scoped: kidScoped, archived: 0 });
    }
    const live = db.rows<{ name: string }>(
      `SELECT c.name FROM categories c JOIN sections s ON s.id = c.section_id
        WHERE c.archived = 0 AND c.fun_member_id IS NULL AND c.id NOT IN (?, ?, ?, ?)`,
      boatId,
      id(db, 'Fun & Wants', 'Hobbies'),
      id(db, 'Everyday', 'Misc'),
      cashGiftsId,
    );
    expect(live).toHaveLength(NEW_CATEGORIES.length);
    expect(db.rows('SELECT name FROM sections WHERE name IN (?, ?, ?, ?, ?, ?, ?) ORDER BY sort', ...Object.values(GROUPS))).toEqual(
      ['Income', 'Bills', 'Everyday', 'Habits', 'Fun & Wants', 'Saving', 'Transfers'].map((name) => ({ name })),
    );
  });

  it('old categories are archived, not deleted', () => {
    for (const [section, name] of [
      ['Food', 'Dining Out'],
      ['Utilities', 'Mobile Phones'],
      ['Transfers', 'Credit Card Payment'],
      ['Transfers', 'Transfer'],
      ['Debt Payments', 'Credit Card Paydown'],
    ] as const) {
      expect(categoryOf(db, id(db, section, name))?.archived, name).toBe(1);
    }
    expect(db.rows('SELECT COUNT(*) AS n FROM categories')).toEqual([{ n: 42 + 8 + 22 }]);
  });

  it('adds the columns and tables later tasks use', () => {
    const columns = (table: string) => db.rows<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, table).map((c) => c.name);
    expect(columns('transactions')).toEqual(expect.arrayContaining(['plaid_category_detailed', 'category_reason']));
    expect(columns('rules')).toEqual(expect.arrayContaining(['amount_min_cents', 'amount_max_cents', 'learned']));
    expect(columns('household')).toEqual(expect.arrayContaining(['habit_cutoff_cents', 'categorized_all_at']));
    expect(db.rows('SELECT habit_cutoff_cents FROM household')).toEqual([{ habit_cutoff_cents: 2500 }]);
    expect(columns('category_moves')).toEqual(['id', 'member_id', 'rule_id', 'rule_before', 'created_at']);
    expect(columns('category_move_items')).toEqual([
      'move_id',
      'transaction_id',
      'old_category_id',
      'old_source',
      'old_reason',
      'old_rule_id',
    ]);
  });
});

describe('kindForGroup', () => {
  it('maps groups to the kind of a new category', () => {
    expect(kindForGroup(GROUPS.income)).toBe('income');
    expect(kindForGroup(GROUPS.saving)).toBe('savings');
    expect(kindForGroup(GROUPS.transfers)).toBe('transfer');
    expect(kindForGroup(GROUPS.bills)).toBe('expense');
    expect(kindForGroup(GROUPS.fun)).toBe('expense');
    expect(kindForGroup('Something Else')).toBe('expense');
  });
});

describe('special categories', () => {
  it('resolve on a fresh database', async () => {
    const db = new TestD1();
    const ctx = await loadIngestContext(db.d1);
    expect(ctx.paychecksCategoryId).toBe(id(db, ...SPECIAL.paychecks));
    expect(ctx.cardPaymentCategoryId).toBe(id(db, 'Transfers', 'Transfers'));
    for (const [section, name] of Object.values(SPECIAL)) expect(id(db, section, name)).toBeGreaterThan(0);
  });
});
