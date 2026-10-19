-- Project 7: Plan › Ahead. Debts get a kind, a planned extra, an order and links; goals a monthly amount;
-- the household a surprises cushion and a payoff order; known items ahead get a table of their own.
ALTER TABLE debts ADD COLUMN kind TEXT NOT NULL DEFAULT 'other';
-- On top of the minimum each month (Save as my plan).
ALTER TABLE debts ADD COLUMN extra_cents INTEGER NOT NULL DEFAULT 0;
-- "My order" for extra money (household.debt_strategy = 'custom').
ALTER TABLE debts ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;
-- A card cleared each month: left out of payoff, sliders and the debt total.
ALTER TABLE debts ADD COLUMN paid_in_full INTEGER NOT NULL DEFAULT 0;
-- Detection has run (once, for a linked card) or the user set paid_in_full: it's never re-detected.
ALTER TABLE debts ADD COLUMN paid_in_full_checked INTEGER NOT NULL DEFAULT 0;
-- The minimum is our estimate (no bank data, not typed in): it follows the balance.
ALTER TABLE debts ADD COLUMN min_estimated INTEGER NOT NULL DEFAULT 0;
-- 'YYYY-MM': a fixed-term loan's last payment.
ALTER TABLE debts ADD COLUMN end_month TEXT;
-- Its minimum is already counted as this bill, or as this category's budget line.
ALTER TABLE debts ADD COLUMN bill_id INTEGER REFERENCES recurring_bills(id) ON DELETE SET NULL;
ALTER TABLE debts ADD COLUMN category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;
-- When a hand-kept balance was last typed in.
ALTER TABLE debts ADD COLUMN balance_as_of TEXT;
UPDATE debts SET kind = 'credit_card' WHERE account_id IN (SELECT id FROM accounts WHERE type = 'credit');

-- NULL: not set (the budget line, or nothing).
ALTER TABLE goals ADD COLUMN monthly_cents INTEGER;

-- NULL: use the suggestion.
ALTER TABLE household ADD COLUMN surprise_cents INTEGER;
ALTER TABLE household ADD COLUMN debt_strategy TEXT NOT NULL DEFAULT 'avalanche';

-- Known money in or out ahead: a tax refund, a registration, a party.
CREATE TABLE ahead_items (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  -- Positive = money in, negative = money out.
  amount_cents INTEGER NOT NULL,
  -- 'YYYY-MM': the (first) month.
  month TEXT NOT NULL,
  repeat TEXT NOT NULL DEFAULT 'once' CHECK (repeat IN ('once', 'monthly', 'yearly')),
  -- 'YYYY-MM': the last month a repeat comes, or NULL for no end.
  end_month TEXT,
  created_by INTEGER REFERENCES members(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
