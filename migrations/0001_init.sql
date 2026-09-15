-- Family budget app schema. Money is integer cents (negative = money out).
-- Dates are 'YYYY-MM-DD' in the household time zone; months are 'YYYY-MM'.

CREATE TABLE household (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT 'Our Family',
  timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  low_balance_cents INTEGER NOT NULL DEFAULT 75000,
  -- when_made: card purchases count as spending when they happen (card payments are transfers).
  card_pay_mode TEXT NOT NULL DEFAULT 'when_made' CHECK (card_pay_mode IN ('when_made', 'when_paid')),
  fun_money_start_date TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO household (id) VALUES (1);

CREATE TABLE members (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#3b6fd8',
  fun_allowance_cents INTEGER NOT NULL DEFAULT 0,
  -- Purchases on this account default to this member's private fun money.
  default_private_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE kids (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#e08a2c',
  birth_date TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE plaid_items (
  id INTEGER PRIMARY KEY,
  item_id TEXT NOT NULL UNIQUE,
  institution_id TEXT,
  institution_name TEXT,
  access_token_enc TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  cursor TEXT,
  -- Cursor at the start of the current pagination; sync restarts here if Plaid reports a mutation mid-way.
  sync_start_cursor TEXT,
  has_more INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'login_required', 'error')),
  error_code TEXT,
  error_message TEXT,
  -- 1 once the first full history pull has finished.
  history_complete INTEGER NOT NULL DEFAULT 0,
  balances_updated_at TEXT,
  liabilities_updated_at TEXT,
  last_synced_at TEXT,
  last_attempt_at TEXT,
  created_by_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  institution TEXT,
  mask TEXT,
  type TEXT NOT NULL DEFAULT 'checking'
    CHECK (type IN ('checking', 'savings', 'credit', 'investment', 'loan', 'cash', 'other')),
  -- Counts toward the cash balance in the weekly forecast.
  is_cash INTEGER NOT NULL DEFAULT 1,
  plaid_item_id INTEGER REFERENCES plaid_items(id) ON DELETE SET NULL,
  plaid_account_id TEXT UNIQUE,
  current_balance_cents INTEGER,
  available_balance_cents INTEGER,
  credit_limit_cents INTEGER,
  balance_updated_at TEXT,
  owner_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE sections (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- income; expense = spending; savings and debt = cash out that isn't spending; transfer = not counted.
  kind TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'savings', 'debt', 'transfer')),
  -- Kids categories ask which kid.
  kid_scoped INTEGER NOT NULL DEFAULT 0,
  -- Set on a member's personal fun money category.
  fun_member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
  archived INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE (section_id, name)
);

CREATE TABLE income_sources (
  id INTEGER PRIMARY KEY,
  member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  net_pay_cents INTEGER NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly', 'biweekly', 'semimonthly', 'monthly')),
  anchor_date TEXT NOT NULL,
  semimonthly_day1 INTEGER,
  semimonthly_day2 INTEGER,
  -- Text in the deposit description that identifies this paycheck, e.g. 'ACME PAYROLL'.
  match_text TEXT,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  -- Fun money allowances build on these paydays.
  drives_allowance INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE rules (
  id INTEGER PRIMARY KEY,
  position INTEGER NOT NULL,
  match_field TEXT NOT NULL DEFAULT 'any' CHECK (match_field IN ('name', 'merchant', 'any')),
  match_text TEXT NOT NULL,
  account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  kid_id INTEGER REFERENCES kids(id) ON DELETE SET NULL,
  private_member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
  ignore_txn INTEGER NOT NULL DEFAULT 0,
  -- Private rules are listed only for their owner.
  owner_member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX rules_position ON rules (position);

CREATE TABLE import_batches (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  filename TEXT,
  format TEXT NOT NULL CHECK (format IN ('csv', 'ofx')),
  row_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  created_by_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE transactions (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  name TEXT NOT NULL,
  merchant_name TEXT,
  normalized_merchant TEXT,
  memo TEXT,
  pending INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL CHECK (source IN ('plaid', 'import', 'manual')),
  plaid_txn_id TEXT UNIQUE,
  pending_txn_id TEXT,
  plaid_category TEXT,
  import_fitid TEXT,
  import_hash TEXT,
  import_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  category_source TEXT CHECK (category_source IN ('rule', 'user', 'auto')),
  rule_id INTEGER REFERENCES rules(id) ON DELETE SET NULL,
  kid_id INTEGER REFERENCES kids(id) ON DELETE SET NULL,
  private_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  income_source_id INTEGER REFERENCES income_sources(id) ON DELETE SET NULL,
  -- The expected payday this deposit was matched to.
  pay_date TEXT,
  notes TEXT,
  -- The other half of a transfer between your own accounts.
  transfer_pair_id INTEGER,
  is_ignored INTEGER NOT NULL DEFAULT 0,
  is_split INTEGER NOT NULL DEFAULT 0,
  created_by_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT
);
CREATE UNIQUE INDEX transactions_fitid ON transactions (account_id, import_fitid) WHERE import_fitid IS NOT NULL;
CREATE UNIQUE INDEX transactions_import_hash ON transactions (account_id, import_hash) WHERE import_hash IS NOT NULL;
CREATE INDEX transactions_date ON transactions (date);
CREATE INDEX transactions_account_date ON transactions (account_id, date);
CREATE INDEX transactions_category_date ON transactions (category_id, date);
CREATE INDEX transactions_private ON transactions (private_member_id);
CREATE INDEX transactions_merchant ON transactions (normalized_merchant);
CREATE INDEX transactions_pending_txn ON transactions (pending_txn_id);

CREATE TABLE splits (
  id INTEGER PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  kid_id INTEGER REFERENCES kids(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL,
  notes TEXT
);
CREATE INDEX splits_transaction ON splits (transaction_id);
CREATE INDEX splits_category ON splits (category_id);

CREATE TABLE transfer_unlinks (
  a_id INTEGER NOT NULL,
  b_id INTEGER NOT NULL,
  PRIMARY KEY (a_id, b_id)
);

CREATE TABLE budget_lines (
  id INTEGER PRIMARY KEY,
  month TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  budget_cents INTEGER NOT NULL DEFAULT 0,
  timing TEXT NOT NULL DEFAULT 'even' CHECK (timing IN ('due_day', 'even')),
  due_day INTEGER CHECK (due_day BETWEEN 1 AND 31),
  notes TEXT,
  updated_by_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (month, category_id)
);

CREATE TABLE kid_budgets (
  id INTEGER PRIMARY KEY,
  kid_id INTEGER NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  budget_cents INTEGER NOT NULL DEFAULT 0,
  UNIQUE (kid_id, category_id, month)
);

CREATE TABLE month_settings (
  month TEXT PRIMARY KEY,
  starting_balance_cents INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE recurring_bills (
  id INTEGER PRIMARY KEY,
  merchant TEXT NOT NULL,
  name TEXT NOT NULL,
  cadence TEXT NOT NULL CHECK (cadence IN ('weekly', 'biweekly', 'monthly', 'quarterly', 'yearly')),
  expected_amount_cents INTEGER NOT NULL,
  last_date TEXT,
  next_date TEXT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'confirmed', 'dismissed')),
  confidence REAL,
  private_member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (merchant, cadence)
);

CREATE TABLE goals (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  target_cents INTEGER NOT NULL,
  target_date TEXT,
  -- Money filed to this category counts toward the goal.
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  starting_saved_cents INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE debts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  apr_percent REAL NOT NULL DEFAULT 0,
  min_payment_cents INTEGER NOT NULL DEFAULT 0,
  due_day INTEGER CHECK (due_day BETWEEN 1 AND 31),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'plaid')),
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE fun_adjustments (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  date TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE checkins (
  id INTEGER PRIMARY KEY,
  -- The month being reviewed.
  month TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'agreed', 'complete')),
  step INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  items_json TEXT NOT NULL DEFAULT '{}',
  snapshot_json TEXT,
  agreed_by_json TEXT NOT NULL DEFAULT '[]',
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE import_mappings (
  id INTEGER PRIMARY KEY,
  header_signature TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  mapping_json TEXT NOT NULL,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE sync_runs (
  id INTEGER PRIMARY KEY,
  plaid_item_id INTEGER REFERENCES plaid_items(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('cron', 'manual', 'link')),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  added INTEGER NOT NULL DEFAULT 0,
  modified INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  has_more INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'error')),
  error TEXT
);
CREATE INDEX sync_runs_item ON sync_runs (plaid_item_id, started_at);

-- Seed sections and categories (from the original spreadsheet, plus Kids and Fun Money).
INSERT INTO sections (id, name, sort) VALUES
  (1, 'Income', 10),
  (2, 'Housing', 20),
  (3, 'Utilities', 30),
  (4, 'Transportation', 40),
  (5, 'Food', 50),
  (6, 'Kids', 60),
  (7, 'Health', 70),
  (8, 'Insurance & Protection', 80),
  (9, 'Debt Payments', 90),
  (10, 'Personal & Household', 100),
  (11, 'Fun Money', 110),
  (12, 'Savings & Goals', 120),
  (13, 'Transfers', 130);

INSERT INTO categories (section_id, name, kind, kid_scoped, sort) VALUES
  (1, 'Paychecks', 'income', 0, 10),
  (1, 'Other Income', 'income', 0, 20),
  (1, 'Refunds', 'income', 0, 30),
  (2, 'Mortgage / Rent', 'expense', 0, 10),
  (2, 'HOA', 'expense', 0, 20),
  (2, 'Home Maintenance', 'expense', 0, 30),
  (3, 'Electric', 'expense', 0, 10),
  (3, 'Natural Gas', 'expense', 0, 20),
  (3, 'Water / Sewer', 'expense', 0, 30),
  (3, 'Trash', 'expense', 0, 40),
  (3, 'Internet', 'expense', 0, 50),
  (3, 'Mobile Phones', 'expense', 0, 60),
  (4, 'Car Payment', 'expense', 0, 10),
  (4, 'Fuel', 'expense', 0, 20),
  (4, 'Auto Insurance', 'expense', 0, 30),
  (4, 'Auto Maintenance', 'expense', 0, 40),
  (5, 'Groceries', 'expense', 0, 10),
  (5, 'Dining Out', 'expense', 0, 20),
  (6, 'Childcare', 'expense', 1, 10),
  (6, 'School & Supplies', 'expense', 1, 20),
  (6, 'Kids Clothing', 'expense', 1, 30),
  (6, 'Activities & Sports', 'expense', 1, 40),
  (6, 'Kids Medical', 'expense', 1, 50),
  (6, 'Kids Gifts & Allowance', 'expense', 1, 60),
  (7, 'Health Insurance Premium', 'expense', 0, 10),
  (7, 'Medical & Prescriptions', 'expense', 0, 20),
  (7, 'Fitness', 'expense', 0, 30),
  (8, 'Life Insurance', 'expense', 0, 10),
  (8, 'Umbrella Policy', 'expense', 0, 20),
  (9, 'Student Loan', 'debt', 0, 10),
  (9, 'Credit Card Paydown', 'debt', 0, 20),
  (10, 'Subscriptions & Streaming', 'expense', 0, 10),
  (10, 'Clothing', 'expense', 0, 20),
  (10, 'Household Goods', 'expense', 0, 30),
  (10, 'Personal Care', 'expense', 0, 40),
  (10, 'Pets', 'expense', 0, 50),
  (10, 'Gifts & Misc', 'expense', 0, 60),
  (12, 'Emergency Fund', 'savings', 0, 10),
  (12, 'Retirement — Roth', 'savings', 0, 20),
  (12, 'Sinking Funds', 'savings', 0, 30),
  (13, 'Transfer', 'transfer', 0, 10),
  (13, 'Credit Card Payment', 'transfer', 0, 20);

-- Fidelity Cash Management core-fund sweeps mirror every real debit; ignore them.
INSERT INTO rules (position, match_field, match_text, ignore_txn) VALUES
  (10000, 'any', 'REDEMPTION FROM CORE ACCOUNT', 1),
  (10010, 'any', 'PURCHASE INTO CORE ACCOUNT', 1),
  (10020, 'any', 'REINVESTMENT', 1);
