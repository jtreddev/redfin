# Automatic categorizing and a smaller category set

Project 1 of 4. Later projects, each with its own spec: (2) spending groups and charts,
(3) savings for irregular costs (car upkeep, registration, holidays), (4) phone and computer
layout redesign.

## Goal

Stop categorizing by hand, the first time and every time after. Today the app ignores the
bank's categories, so almost every charge arrives uncategorized unless a rule matches.
After this project, nearly every charge gets a sensible category on arrival, fixing one is a
single tap, and the app learns from every fix.

Success looks like:

- After the change runs on existing history, fewer than 5% of the last 90 days' spending
  shows "Needs a look".
- Fixing a category never asks a question, and Undo is available right after.
- No charge a person set by hand is ever changed by automation.
- Totals per month (spending, income, transfers) are identical before and after the
  category move; only the categories change.

## What the user decided

- Small gas-station charges go to Habits automatically, with an adjustable cutoff (default $25).
- Fixing a charge learns quietly, re-files similar past charges, and shows Undo. No prompt.
- The category set below.
- Rule layers on the app's own server. No AI service. (An AI pass for leftovers may be added
  later if "Needs a look" stays busy.)

## Categories

Sections become groups. Each group answers one question.

| Group (section) | Categories | Kind |
|---|---|---|
| Bills | Housing, Utilities, Phone, Internet, Insurance, Loans, Subscriptions, Childcare | expense (Loans: debt) |
| Everyday | Groceries, Gas, Car Upkeep, Household & Personal, Medical, Kids (asks which kid) | expense |
| Habits | Habits, Coffee & Fast Food | expense |
| Fun & Wants | Eating Out, Shopping, Entertainment, Gifts, each person's Fun Money | expense |
| Saving | Savings & Planned Costs | savings |
| Income | Paychecks, Other Income, Refunds | income |
| Transfers | Transfers | transfer |

"Needs a look" is not a category; it is `category_id IS NULL` on a spending charge.

### Moving existing data (migration 0003)

Old to new:

| Old | New |
|---|---|
| Mortgage / Rent, HOA | Housing |
| Home Maintenance | Household & Personal |
| Electric, Natural Gas, Water / Sewer, Trash | Utilities |
| Internet | Internet |
| Mobile Phones | Phone |
| Car Payment, Student Loan | Loans |
| Fuel | Gas |
| Auto Insurance, Health Insurance Premium, Life Insurance, Umbrella Policy | Insurance |
| Auto Maintenance | Car Upkeep |
| Groceries | Groceries |
| Dining Out | Eating Out |
| Childcare | Childcare |
| School & Supplies, Kids Clothing, Activities & Sports, Kids Medical, Kids Gifts & Allowance | Kids |
| Medical & Prescriptions | Medical |
| Fitness | Subscriptions |
| Credit Card Paydown | Transfers |
| Subscriptions & Streaming | Subscriptions |
| Clothing | Shopping |
| Household Goods, Personal Care, Pets | Household & Personal |
| Gifts & Misc | Gifts |
| Emergency Fund, Retirement — Roth, Sinking Funds | Savings & Planned Costs |
| Paychecks, Other Income, Refunds | unchanged |
| Transfers section categories | Transfers |

- Everything that references a category is re-pointed: `transactions`, `splits`,
  `budget_lines`, `kid_budgets`, `rules`, `recurring_bills`, and any other table with a
  `category_id` column (the migration lists them explicitly; a test fails if a table with
  `category_id` is not covered).
- `budget_lines` for merged categories in the same month are summed into one line. If merged
  lines had different timing, the merged line uses `even`.
- Old categories are archived (`archived = 1`), not deleted.
- Categories the household created itself keep their names and move to the closest group
  (by their old section's mapping; unknown sections go to Fun & Wants).
- Fun Money categories (`fun_member_id`) move to Fun & Wants unchanged.
- The migration is plain SQL, so `wrangler d1 migrations apply` runs it.

Before applying to the live database, the user runs `wrangler d1 export` for a backup. Before
that, the migration is run on a copy of the real data locally and per-month totals of spending,
income, savings and transfers are compared before and after; they must match to the cent.

## How a charge gets its category

A pure function in `src/shared/autoCategory.ts`:

```ts
categorize(txn, ctx) -> { categoryId: number | null; source: 'learned' | 'rule' | 'bill' | 'builtin' | 'bank' | null; reason: string | null }
```

Layers, first match wins:

1. **Set by hand** (`category_source = 'user'`, or split): never changed. `classify()` already
   returns early for these; that stays.
2. **Rules**: the existing rules plus learned rules, in position order. Rules gain an optional
   amount range. Reason: "Learned from your fix" or "Your rule: <text>".
3. **Saved bills**: a confirmed bill whose merchant key matches and whose amount is within the
   bill's range (the same `sameBill` window used by marking bills). Reason: "Matches your bill <name>".
4. **Built-in rules** (`src/shared/builtinRules.ts`, a data table):
   - Gas stations: merchant matches a list (Shell, Casey's, Marathon, Kwik Trip, BP, Exxon,
     Mobil, Speedway, Circle K, QuikTrip, Love's, Pilot, Flying J, Sunoco, Chevron, Phillips 66,
     Citgo, Valero, 7-Eleven, Wawa, Sheetz, Holiday, Thorntons), or the bank category is
     `TRANSPORTATION_GAS`. Under the household cutoff → Habits; at or over → Gas.
     Reason: "Under $25 at a gas station" or "Gas station".
   - Known names → category (Netflix, Hulu, Spotify, Disney+, Max, Apple.com/bill, Google *,
     YouTube, Amazon Prime, DashPass → Subscriptions; Rocket Mortgage and names containing
     "MORTGAGE" → Housing; Aidvantage, Nelnet, MOHELA, Bridgecrest, and names containing
     "AUTO LOAN" or "STUDENT LOAN" → Loans; Geico, Progressive, State Farm, Allstate → Insurance; T-Mobile, Verizon,
     AT&T Wireless → Phone; Xfinity, Comcast, Spectrum → Internet). Added after the dry run, because
     older charges carry only the bank's broad category: national fast-food and coffee chains and
     names with "COFFEE" → Coffee & Fast Food; national grocery chains (Aldi, Kroger, Hy-Vee, …) →
     Groceries; names with "LIQUOR" → Habits; PetSmart, Petco, Chewy and vet clinics → Household &
     Personal; Amazon Kids+, Anthropic, OpenAI/ChatGPT → Subscriptions.
5. **Bank category**: Plaid `personal_finance_category.detailed`, mapped by a table in
   `src/shared/bankCategories.ts`, falling back to `primary`. Examples: `FOOD_AND_DRINK_GROCERIES`
   → Groceries; `FOOD_AND_DRINK_FAST_FOOD` and `FOOD_AND_DRINK_COFFEE` → Coffee & Fast Food;
   `FOOD_AND_DRINK_RESTAURANT` → Eating Out; `MEDICAL_*` → Medical; `RENT_AND_UTILITIES_*` →
   Utilities / Phone / Internet; `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT` and `TRANSFER_*` → Transfers;
   `GENERAL_MERCHANDISE_*` → Shopping; `ENTERTAINMENT_*` → Entertainment; `INCOME_WAGES` →
   Paychecks. Reason: "Bank says: fast food".
6. Nothing matched: `null` ("Needs a look").

Existing behaviors in `classify()` keep their place: paycheck matching still sets Paychecks and
the income source; personal-card defaults for private accounts still apply before layer 4.

### Data changes (migration 0003, same file)

- `transactions.plaid_category_detailed TEXT` and `transactions.category_reason TEXT`.
- `transactions.category_source` keeps its values (`rule`, `user`, `auto`): learned rules
  store `rule`; bills, built-in and bank layers store `auto`. Which layer decided is in
  `category_reason`. (Decided while planning: avoids rebuilding the transactions table on the
  live database, since SQLite can't alter a CHECK constraint in place.)
- `rules.amount_min_cents INTEGER`, `rules.amount_max_cents INTEGER` (absolute cents, inclusive,
  null = no bound), `rules.learned INTEGER NOT NULL DEFAULT 0`.
- `household.habit_cutoff_cents INTEGER NOT NULL DEFAULT 2500`.
- `category_moves` (id, created_at, member_id, rule_id, created_rule INTEGER) and
  `category_move_items` (move_id, transaction_id, old_category_id, old_source, old_reason) for Undo.
  Rows older than a day are deleted by the daily cron.

Sync stores `personal_finance_category.detailed`. Existing transactions lack it; the Accounts
screen's sync gets a one-time "Refresh bank details" that restarts each item's
`/transactions/sync` from no cursor, so Plaid re-sends history and existing rows update in place
(matched by `plaid_txn_id`). Until that runs, layer 5 uses `primary`.

### When categorizing runs

- On every new or changed charge during sync (`classify()` in `services/ingest.ts` calls
  `categorize()`).
- Once over all history after the migration, from a new endpoint `POST /categorize/all` the app
  calls on first load when a flag in `household` says it hasn't run. Batches of 200 charges per
  request so it stays inside the Worker CPU limit (lowered from 500 after the dry run timed a cold batch near 10 ms); the client loops until done.
- From "Recategorize everything" in Settings, for after changing the cutoff.

All three skip charges set by hand.

## Fixing a charge

- Picking a category on a charge saves it as `category_source = 'user'` (as today) and also:
  - Creates or updates a learned rule: match on the merchant key; for gas-station charges,
    also an amount range from half to one and a half times the charge, clamped at the cutoff
    so it never captures fill-ups (charges under the cutoff learn `0..cutoff`; at or over learn
    `cutoff..∞`). Learned rules go to the top of the rule order.
  - Re-files earlier charges that match the new rule and were not set by hand.
  - Records the move for Undo and returns `{ moved, moveId }`.
- The app shows "Moved 41 Shell charges to Habits · Undo" for 6 seconds. Undo
  (`POST /category-moves/:id/undo`) restores each charge's old category, source and reason, and
  deletes the learned rule if this fix created it (or restores its old target if it changed one).
- The current "Always file X as Y?" prompt is removed.
- Privacy: a fix into your own Fun Money creates a private learned rule owned by you, and it only
  re-files charges you can see; this reuses the existing private-rule rules. Undo only touches
  the charges the move recorded.

## Needs a look

Home shows a "Needs a look" card when any spending charge from the last 60 days has no
category: up to 5 rows, each opening the charge sheet. The card disappears when empty.

## Rules screen

Learned rules show "Learned from your fix" with their amount range ("Shell · under $25 →
Habits"). They can be edited or deleted like any rule.

## Testing

- `autoCategory` unit tests per layer, including gas-station cutoff edges ($24.99, $25.00),
  set-by-hand never changing, and bank detailed → primary fallback.
- Migration test: seed old categories and data in every table with `category_id`, run 0003,
  check every reference moved, budgets summed, old categories archived, and per-month totals
  unchanged. A test fails if a table has a `category_id` column the migration doesn't cover.
- Fix flow: learning, re-filing only non-hand-set charges, Undo restoring everything,
  gas-station range learning, private rules staying private.
- Batch recategorize: runs in chunks and stops.
- Before release: run the migration and `categorize/all` on a local copy of the real data,
  report the "Needs a look" share and the before/after totals.

## Out of scope here

Charts and group totals over time (project 2), savings for irregular costs (project 3), layout
redesign (project 4), AI categorizing.
