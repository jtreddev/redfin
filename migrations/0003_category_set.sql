-- A smaller category set in groups: Bills, Everyday, Habits, Fun & Wants, Saving, Income, Transfers.
-- Old categories are archived, never deleted; everything that pointed at them is moved to the new ones.

-- 1. Groups. Old sections stay (empty, sorted last); Fun Money becomes Fun & Wants.
UPDATE sections SET name = 'Fun & Wants' WHERE name = 'Fun Money';
UPDATE sections SET sort = sort + 1000 WHERE name NOT IN ('Income', 'Fun & Wants', 'Transfers');
INSERT OR IGNORE INTO sections (name, sort) VALUES ('Bills', 20), ('Everyday', 30), ('Habits', 40), ('Saving', 60);
UPDATE sections SET sort = CASE name
    WHEN 'Income' THEN 10 WHEN 'Bills' THEN 20 WHEN 'Everyday' THEN 30 WHEN 'Habits' THEN 40
    WHEN 'Fun & Wants' THEN 50 WHEN 'Saving' THEN 60 WHEN 'Transfers' THEN 70 END
  WHERE name IN ('Income', 'Bills', 'Everyday', 'Habits', 'Fun & Wants', 'Saving', 'Transfers');

-- 2. New categories. A same-named category already in the group (Income's three) is reused.
WITH v (section, name, kind, kid_scoped, sort) AS (VALUES
  ('Bills', 'Housing', 'expense', 0, 10),
  ('Bills', 'Utilities', 'expense', 0, 20),
  ('Bills', 'Phone', 'expense', 0, 30),
  ('Bills', 'Internet', 'expense', 0, 40),
  ('Bills', 'Insurance', 'expense', 0, 50),
  ('Bills', 'Loans', 'debt', 0, 60),
  ('Bills', 'Subscriptions', 'expense', 0, 70),
  -- Childcare was per kid; keep asking which kid so its history still shows on the Kids screen.
  ('Bills', 'Childcare', 'expense', 1, 80),
  ('Everyday', 'Groceries', 'expense', 0, 10),
  ('Everyday', 'Gas', 'expense', 0, 20),
  ('Everyday', 'Car Upkeep', 'expense', 0, 30),
  ('Everyday', 'Household & Personal', 'expense', 0, 40),
  ('Everyday', 'Medical', 'expense', 0, 50),
  ('Everyday', 'Kids', 'expense', 1, 60),
  ('Habits', 'Habits', 'expense', 0, 10),
  ('Habits', 'Coffee & Fast Food', 'expense', 0, 20),
  ('Fun & Wants', 'Eating Out', 'expense', 0, 10),
  ('Fun & Wants', 'Shopping', 'expense', 0, 20),
  ('Fun & Wants', 'Entertainment', 'expense', 0, 30),
  ('Fun & Wants', 'Gifts', 'expense', 0, 40),
  ('Saving', 'Savings & Planned Costs', 'savings', 0, 10),
  ('Income', 'Paychecks', 'income', 0, 10),
  ('Income', 'Other Income', 'income', 0, 20),
  ('Income', 'Refunds', 'income', 0, 30),
  ('Transfers', 'Transfers', 'transfer', 0, 10))
INSERT OR IGNORE INTO categories (section_id, name, kind, kid_scoped, sort)
SELECT s.id, v.name, v.kind, v.kid_scoped, v.sort FROM v JOIN sections s ON s.name = v.section;

-- 3. Old category → new category. Scratch tables are plain tables dropped at the end (D1 refuses TEMP).
CREATE TABLE category_map (old_id INTEGER PRIMARY KEY, new_id INTEGER NOT NULL);

WITH m (old_section, old_name, new_section, new_name) AS (VALUES
  ('Housing', 'Mortgage / Rent', 'Bills', 'Housing'),
  ('Housing', 'HOA', 'Bills', 'Housing'),
  ('Housing', 'Home Maintenance', 'Everyday', 'Household & Personal'),
  ('Utilities', 'Electric', 'Bills', 'Utilities'),
  ('Utilities', 'Natural Gas', 'Bills', 'Utilities'),
  ('Utilities', 'Water / Sewer', 'Bills', 'Utilities'),
  ('Utilities', 'Trash', 'Bills', 'Utilities'),
  ('Utilities', 'Internet', 'Bills', 'Internet'),
  ('Utilities', 'Mobile Phones', 'Bills', 'Phone'),
  ('Transportation', 'Car Payment', 'Bills', 'Loans'),
  ('Transportation', 'Fuel', 'Everyday', 'Gas'),
  ('Transportation', 'Auto Insurance', 'Bills', 'Insurance'),
  ('Transportation', 'Auto Maintenance', 'Everyday', 'Car Upkeep'),
  ('Food', 'Groceries', 'Everyday', 'Groceries'),
  ('Food', 'Dining Out', 'Fun & Wants', 'Eating Out'),
  ('Kids', 'Childcare', 'Bills', 'Childcare'),
  ('Kids', 'School & Supplies', 'Everyday', 'Kids'),
  ('Kids', 'Kids Clothing', 'Everyday', 'Kids'),
  ('Kids', 'Activities & Sports', 'Everyday', 'Kids'),
  ('Kids', 'Kids Medical', 'Everyday', 'Kids'),
  ('Kids', 'Kids Gifts & Allowance', 'Everyday', 'Kids'),
  ('Health', 'Health Insurance Premium', 'Bills', 'Insurance'),
  ('Health', 'Medical & Prescriptions', 'Everyday', 'Medical'),
  ('Health', 'Fitness', 'Bills', 'Subscriptions'),
  ('Insurance & Protection', 'Life Insurance', 'Bills', 'Insurance'),
  ('Insurance & Protection', 'Umbrella Policy', 'Bills', 'Insurance'),
  ('Debt Payments', 'Student Loan', 'Bills', 'Loans'),
  ('Debt Payments', 'Credit Card Paydown', 'Transfers', 'Transfers'),
  ('Personal & Household', 'Subscriptions & Streaming', 'Bills', 'Subscriptions'),
  ('Personal & Household', 'Clothing', 'Fun & Wants', 'Shopping'),
  ('Personal & Household', 'Household Goods', 'Everyday', 'Household & Personal'),
  ('Personal & Household', 'Personal Care', 'Everyday', 'Household & Personal'),
  ('Personal & Household', 'Pets', 'Everyday', 'Household & Personal'),
  ('Personal & Household', 'Gifts & Misc', 'Fun & Wants', 'Gifts'),
  ('Savings & Goals', 'Emergency Fund', 'Saving', 'Savings & Planned Costs'),
  ('Savings & Goals', 'Retirement — Roth', 'Saving', 'Savings & Planned Costs'),
  ('Savings & Goals', 'Sinking Funds', 'Saving', 'Savings & Planned Costs'),
  ('Income', 'Paychecks', 'Income', 'Paychecks'),
  ('Income', 'Other Income', 'Income', 'Other Income'),
  ('Income', 'Refunds', 'Income', 'Refunds'),
  ('Transfers', 'Transfer', 'Transfers', 'Transfers'),
  ('Transfers', 'Credit Card Payment', 'Transfers', 'Transfers'))
INSERT INTO category_map (old_id, new_id)
SELECT o.id, n.id
  FROM m
  JOIN sections os ON os.name = m.old_section
  JOIN categories o ON o.section_id = os.id AND o.name = m.old_name
  JOIN sections ns ON ns.name = m.new_section
  JOIN categories n ON n.section_id = ns.id AND n.name = m.new_name;

-- The household's own transfer categories fold into Transfers too. Other kinds filed under
-- Transfers stay where they are, so no total changes.
INSERT INTO category_map (old_id, new_id)
SELECT c.id, t.id
  FROM sections s
  JOIN categories t ON t.section_id = s.id AND t.name = 'Transfers'
  JOIN categories c ON c.section_id = s.id AND c.id <> t.id
 WHERE s.name = 'Transfers'
   AND c.kind = 'transfer'
   AND c.fun_member_id IS NULL
   AND c.id NOT IN (SELECT old_id FROM category_map);

-- 4. The household's own categories keep their names and move to the closest group.
CREATE TABLE custom_move AS
SELECT c.id, c.name, ns.id AS section_id
  FROM categories c
  JOIN sections os ON os.id = c.section_id
  JOIN sections ns ON ns.name = CASE
    WHEN os.name IN ('Housing', 'Utilities', 'Insurance & Protection', 'Debt Payments') THEN 'Bills'
    WHEN os.name IN ('Transportation', 'Food', 'Kids', 'Health', 'Personal & Household') THEN 'Everyday'
    WHEN os.name = 'Savings & Goals' THEN 'Saving'
    ELSE 'Fun & Wants' END
 WHERE os.name NOT IN ('Bills', 'Everyday', 'Habits', 'Fun & Wants', 'Saving', 'Income', 'Transfers')
   AND c.fun_member_id IS NULL
   AND c.id NOT IN (SELECT old_id FROM category_map);

-- A custom category whose name is already taken in its new group folds into that one...
INSERT INTO category_map (old_id, new_id)
SELECT m.id, c.id FROM custom_move m JOIN categories c ON c.section_id = m.section_id AND c.name = m.name;

-- ...and same-named customs from different old sections fold into the oldest of them.
INSERT INTO category_map (old_id, new_id)
SELECT m.id, (SELECT MIN(k.id) FROM custom_move k WHERE k.section_id = m.section_id AND k.name = m.name)
  FROM custom_move m
 WHERE m.id NOT IN (SELECT old_id FROM category_map)
   AND m.id > (SELECT MIN(k.id) FROM custom_move k WHERE k.section_id = m.section_id AND k.name = m.name);

UPDATE categories SET section_id = (SELECT m.section_id FROM custom_move m WHERE m.id = categories.id)
 WHERE id IN (SELECT id FROM custom_move) AND id NOT IN (SELECT old_id FROM category_map);

-- 5. Budgets: lines landing on the same category and month are summed into one. Mixed timing
--    or due days become 'even'. Merged rows are built first because of UNIQUE (month, category_id).
CREATE TABLE merged_budget_lines AS
SELECT b.month,
       COALESCE(m.new_id, b.category_id) AS category_id,
       SUM(b.budget_cents) AS budget_cents,
       CASE WHEN COUNT(DISTINCT b.timing) = 1 AND COUNT(DISTINCT IFNULL(b.due_day, 0)) = 1
            THEN MIN(b.timing) ELSE 'even' END AS timing,
       CASE WHEN COUNT(DISTINCT b.timing) = 1 AND COUNT(DISTINCT IFNULL(b.due_day, 0)) = 1
            THEN MIN(b.due_day) END AS due_day,
       group_concat(b.notes, '; ') AS notes,
       MAX(b.updated_by_member_id) AS updated_by_member_id,
       MAX(b.updated_at) AS updated_at
  FROM budget_lines b
  LEFT JOIN category_map m ON m.old_id = b.category_id
 WHERE b.category_id IN (SELECT old_id FROM category_map) OR b.category_id IN (SELECT new_id FROM category_map)
 GROUP BY b.month, COALESCE(m.new_id, b.category_id);

DELETE FROM budget_lines
 WHERE category_id IN (SELECT old_id FROM category_map) OR category_id IN (SELECT new_id FROM category_map);

INSERT INTO budget_lines (month, category_id, budget_cents, timing, due_day, notes, updated_by_member_id, updated_at)
SELECT month, category_id, budget_cents, timing, due_day, notes, updated_by_member_id, updated_at FROM merged_budget_lines;

CREATE TABLE merged_kid_budgets AS
SELECT k.kid_id, k.month, COALESCE(m.new_id, k.category_id) AS category_id, SUM(k.budget_cents) AS budget_cents
  FROM kid_budgets k
  LEFT JOIN category_map m ON m.old_id = k.category_id
 WHERE k.category_id IN (SELECT old_id FROM category_map) OR k.category_id IN (SELECT new_id FROM category_map)
 GROUP BY k.kid_id, k.month, COALESCE(m.new_id, k.category_id);

DELETE FROM kid_budgets
 WHERE category_id IN (SELECT old_id FROM category_map) OR category_id IN (SELECT new_id FROM category_map);

INSERT INTO kid_budgets (kid_id, category_id, month, budget_cents)
SELECT kid_id, category_id, month, budget_cents FROM merged_kid_budgets;

-- 6. Re-point everything else that names a category.
UPDATE transactions SET category_id = (SELECT new_id FROM category_map WHERE old_id = category_id)
 WHERE category_id IN (SELECT old_id FROM category_map);
UPDATE splits SET category_id = (SELECT new_id FROM category_map WHERE old_id = category_id)
 WHERE category_id IN (SELECT old_id FROM category_map);
UPDATE rules SET category_id = (SELECT new_id FROM category_map WHERE old_id = category_id)
 WHERE category_id IN (SELECT old_id FROM category_map);
UPDATE recurring_bills SET category_id = (SELECT new_id FROM category_map WHERE old_id = category_id)
 WHERE category_id IN (SELECT old_id FROM category_map);
UPDATE goals SET category_id = (SELECT new_id FROM category_map WHERE old_id = category_id)
 WHERE category_id IN (SELECT old_id FROM category_map);

-- 7. Archive the old categories.
UPDATE categories SET archived = 1
 WHERE id IN (SELECT old_id FROM category_map) AND id NOT IN (SELECT new_id FROM category_map);

DROP TABLE category_map;
DROP TABLE custom_move;
DROP TABLE merged_budget_lines;
DROP TABLE merged_kid_budgets;

-- 8. Columns for automatic categorizing.
ALTER TABLE transactions ADD COLUMN plaid_category_detailed TEXT;
-- Why the category was chosen, shown to the user.
ALTER TABLE transactions ADD COLUMN category_reason TEXT;
ALTER TABLE rules ADD COLUMN amount_min_cents INTEGER;
ALTER TABLE rules ADD COLUMN amount_max_cents INTEGER;
-- Made by the app from the user's fixes, not typed in.
ALTER TABLE rules ADD COLUMN learned INTEGER NOT NULL DEFAULT 0;
-- Small charges at habit merchants under this amount go to Habits.
ALTER TABLE household ADD COLUMN habit_cutoff_cents INTEGER NOT NULL DEFAULT 2500;
ALTER TABLE household ADD COLUMN categorized_all_at TEXT;

-- 9. Undo for "move these charges": one row per move, one item per charge it changed.
CREATE TABLE category_moves (
  id INTEGER PRIMARY KEY,
  member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
  rule_id INTEGER REFERENCES rules(id) ON DELETE SET NULL,
  -- JSON of the rule before the move; NULL if the move created the rule.
  rule_before TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE category_move_items (
  move_id INTEGER NOT NULL REFERENCES category_moves(id) ON DELETE CASCADE,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  old_category_id INTEGER,
  old_source TEXT,
  old_reason TEXT,
  old_rule_id INTEGER,
  PRIMARY KEY (move_id, transaction_id)
);
