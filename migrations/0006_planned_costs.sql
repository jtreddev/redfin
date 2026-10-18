-- Planned costs (sinking funds): a monthly set-aside for lumpy costs, tracked as a running balance.

CREATE TABLE planned_costs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  -- 'YYYY-MM'; the start month's set-aside counts.
  start_month TEXT NOT NULL,
  start_balance_cents INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The monthly amount from this month on; past months keep the amount they had.
CREATE TABLE planned_cost_amounts (
  planned_cost_id INTEGER NOT NULL REFERENCES planned_costs(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  monthly_cents INTEGER NOT NULL,
  PRIMARY KEY (planned_cost_id, month)
);

-- The spending categories a cost pays for. The primary key keeps each category in one cost.
CREATE TABLE planned_cost_categories (
  planned_cost_id INTEGER NOT NULL REFERENCES planned_costs(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (category_id)
);
CREATE INDEX planned_cost_categories_cost ON planned_cost_categories (planned_cost_id);

-- Defaults are created once; deleting them all doesn't bring them back.
ALTER TABLE household ADD COLUMN planned_costs_seeded_at TEXT;
