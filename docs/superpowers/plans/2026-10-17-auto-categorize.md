# Automatic Categorizing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nearly every charge gets a sensible category on arrival, fixing one is a single tap that the app learns from (with Undo), on a smaller set of categories.

**Architecture:** A pure `categorize()` in `src/shared/autoCategory.ts` runs layers (rules incl. learned → saved bills → built-in rules → bank category) and is called from the existing `classify()` in `src/worker/services/ingest.ts`, so sync, import and reclassify all use it. Migration `0003` moves data to the new category set. A fix on a charge writes a learned rule, re-files similar non-hand-set charges, and records a move that Undo reverses.

**Tech Stack:** Cloudflare Workers + D1 (SQLite), Hono, React, Vitest with `tests/helpers/d1.ts` (node:sqlite, loads every file in `migrations/`).

**Spec:** `docs/superpowers/specs/2026-10-17-auto-categorize-design.md`

**Deviation from spec (decided while planning):** `transactions.category_source` keeps its CHECK values (`rule`, `user`, `auto`). Learned rules store `rule`; bills, built-in and bank layers store `auto`. Which layer decided is recorded in the new `category_reason` text. This avoids rebuilding the transactions table on the live database. The spec records this.

## Global Constraints

- Charges with `category_source = 'user'` or `is_split = 1` are never changed by automation.
- Gas-station cutoff default: `2500` cents (`household.habit_cutoff_cents`). Under the cutoff → Habits; at or over → Gas.
- Undo toast shows for 6 seconds. Copy: `Moved {n} {Merchant} charges to {Category} · Undo` (`charge` singular for 1).
- Recategorize-all batches: 500 transactions per request.
- Per-month totals of spending, income, savings and transfers must be identical to the cent before and after migration 0003.
- No AI service; everything runs in the Worker.
- Private: a learned rule into your own Fun Money is private to you (`private_member_id` and `owner_member_id` = you) and only re-files charges you can see.
- Existing tests keep passing; `npm run typecheck`, `npx vitest run`, `npm run build` all green at the end of every task.
- Commit only; never push or deploy, and never run `wrangler ... --remote`.

## Review Focus

1. A charge set by hand, then a fix on a *different* charge from the same merchant: the hand-set one must not move. (Task 5 test `fix leaves hand-set charges alone`.)
2. Undo after a second fix changed the same rule: Undo of the first move must not delete the rule the second move depends on. Undo only applies to the latest move per rule; older moves return 409 "Already changed again". (Task 5 test `undo of an older move is refused`.)
3. A charge with a split: automation and fixes skip it. (Task 3 test `splits are skipped`.)
4. Migration with a household-created category inside an old section (e.g. "Boat" under Transportation): it survives, moves to the mapped group, keeps its transactions. (Task 1 test `custom categories survive`.)
5. A refund (positive amount) at a gas station or Netflix: built-in spending rules apply only to outflows (`amountCents < 0`); refunds fall through to the bank layer. (Task 2 test `refunds don't hit spending rules`.)

---

### Task 1: New category set and migration 0003

**Files:**
- Create: `migrations/0003_category_set.sql`
- Create: `src/shared/categorySet.ts`
- Modify: `src/worker/middleware/auth.ts:107` (Fun Money section name)
- Modify: `src/worker/services/context.ts:145-146` (special categories)
- Modify: `src/worker/routes/planning.ts:368-369` (goals' savings section)
- Modify: `src/shared/defaults.ts` (`SUGGESTED_BUDGET` to new names)
- Modify: `src/client/screens/Settings.tsx:167-208` (kind and kid inference by group)
- Test: `tests/categorySet.test.ts`

**Interfaces:**
- Produces `src/shared/categorySet.ts`:
  - `export const GROUPS = { bills: 'Bills', everyday: 'Everyday', habits: 'Habits', fun: 'Fun & Wants', saving: 'Saving', income: 'Income', transfers: 'Transfers' } as const`
  - `export const SPECIAL = { paychecks: ['Income', 'Paychecks'], transfers: ['Transfers', 'Transfers'], habits: ['Habits', 'Habits'], gas: ['Everyday', 'Gas'], savings: ['Saving', 'Savings & Planned Costs'] } as const` (section, category name pairs for `findSpecialCategory`)
  - `export function kindForGroup(group: string): 'income' | 'expense' | 'savings' | 'transfer'`
- `IngestContext.cardPaymentCategoryId` now resolves to Transfers › Transfers (name kept so callers don't change).

- [ ] **Step 1: Write the failing migration tests** in `tests/categorySet.test.ts`. Build a `TestD1` with only `0001` and `0002` applied (add an option `new TestD1({ upTo: '0002' })` to the helper, then `db.migrate('0003')`), seed one row per table with `category_id` pointing at old categories, then apply 0003:
  - `moves every reference`: for each table in `['transactions','splits','budget_lines','kid_budgets','rules','recurring_bills','goals']`, no row references an archived category.
  - `covers every table with category_id`: `SELECT name FROM sqlite_master WHERE type='table'` + `pragma_table_info` — every table having a `category_id` column is in the list above (fails if a new one appears).
  - `sums merged budgets`: Electric 16500 + Water 7000 in `2026-09` → one Utilities line of 23500 with timing `even`.
  - `keeps monthly totals`: per-month sums of `amount_cents` grouped by category `kind` (via join) are identical before and after.
  - `custom categories survive`: a "Boat" category under Transportation keeps its name and id, sits in Everyday, and keeps its transaction.
  - `fun money stays`: a member's Fun Money category moves to Fun & Wants with the same id and `fun_member_id`.
  - `new categories exist`: the 25 categories of the spec table exist (Fun Money excluded), unarchived, with Kids `kid_scoped = 1`, Loans `kind = 'debt'`, Savings & Planned Costs `kind = 'savings'`, Transfers `kind = 'transfer'`.
  - `old categories are archived`, not deleted.

- [ ] **Step 2: Run** `npx vitest run tests/categorySet.test.ts` — Expected: FAIL (no 0003, no `upTo`).

- [ ] **Step 3: Write `migrations/0003_category_set.sql`.** Approach (plain SQL, no app code):
  1. Rename sections: `Fun Money` → `Fun & Wants`, `Income` and `Transfers` keep names; insert `Bills`, `Everyday`, `Habits`, `Saving` (sorts 20, 30, 40, 60; Fun & Wants 50, Income 10, Transfers 70). Old sections other than these keep existing rows (they'll be empty and are hidden by having no unarchived categories).
  2. Insert the new categories (spec table; Phone and Internet separate) with `INSERT OR IGNORE`, so a same-named existing category in the target section is reused.
  3. Build `CREATE TEMP TABLE category_map (old_id INTEGER PRIMARY KEY, new_id INTEGER NOT NULL)` from a `VALUES` list of (old section, old name, new section, new name) joined to `categories` by name — every pair in the spec's mapping table, plus `Transfers › Transfer` and `Transfers › Credit Card Payment` → `Transfers › Transfers`.
  4. Custom categories (not in the map, `fun_member_id IS NULL`, not in a kept section): `UPDATE categories SET section_id = <group>` by their old section: Housing/Utilities/Insurance & Protection/Debt Payments → Bills; Transportation/Food/Kids/Health/Personal & Household → Everyday; Savings & Goals → Saving; else Fun & Wants.
  5. Re-point: `UPDATE <table> SET category_id = (SELECT new_id FROM category_map WHERE old_id = category_id) WHERE category_id IN (SELECT old_id FROM category_map)` for every table in the test list.
  6. Budgets: before step 5 for `budget_lines` and `kid_budgets`, insert merged rows with `SUM(budget_cents)` grouped by (month, new_id) [and kid for kid_budgets], timing `even` when merged timings differ else the shared timing, `due_day` kept only when single; delete the old rows. (Uniqueness `(month, category_id)` forces merge-before-repoint.)
  7. `UPDATE categories SET archived = 1 WHERE id IN (SELECT old_id FROM category_map) AND id NOT IN (SELECT new_id FROM category_map)`.
  8. New columns: `transactions.plaid_category_detailed TEXT`, `transactions.category_reason TEXT`, `rules.amount_min_cents INTEGER`, `rules.amount_max_cents INTEGER`, `rules.learned INTEGER NOT NULL DEFAULT 0`, `household.habit_cutoff_cents INTEGER NOT NULL DEFAULT 2500`, `household.categorized_all_at TEXT`.
  9. Tables `category_moves (id INTEGER PRIMARY KEY, member_id INTEGER REFERENCES members(id) ON DELETE CASCADE, rule_id INTEGER REFERENCES rules(id) ON DELETE SET NULL, rule_before TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))` and `category_move_items (move_id INTEGER NOT NULL REFERENCES category_moves(id) ON DELETE CASCADE, transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE, old_category_id INTEGER, old_source TEXT, old_reason TEXT, old_rule_id INTEGER, PRIMARY KEY (move_id, transaction_id))`. `rule_before` is JSON of the rule row before the move, or NULL if the move created the rule.

- [ ] **Step 4: Add `src/shared/categorySet.ts`** and switch the name-dependent call sites listed under Files to it (`auth.ts` uses `GROUPS.fun`; `context.ts` uses `SPECIAL`; `planning.ts` goals use `GROUPS.saving`; `Settings.tsx` uses `kindForGroup` and `kid_scoped` from the category; `SUGGESTED_BUDGET` rewritten to new names, merged amounts summed).

- [ ] **Step 5: Run** `npx vitest run` — Expected: all PASS, including existing suites (fix fixtures that name old categories).

- [ ] **Step 6: Commit** `git commit -m "New category set: migration 0003 moves data to Bills, Everyday, Habits, Fun & Wants, Saving"`

---

### Task 2: The categorizer (pure)

**Files:**
- Create: `src/shared/bankCategories.ts`, `src/shared/builtinRules.ts`, `src/shared/autoCategory.ts`
- Test: `tests/autoCategory.test.ts`

**Interfaces:**
- Consumes: `SPECIAL`, `GROUPS` (Task 1); `ruleMatches`, `normalizeMerchant` (`src/shared/rules.ts`).
- Produces:
  - `export type CategoryRef = readonly [section: string, name: string]`
  - `bankCategories.ts`: `export function bankCategory(detailed: string | null | undefined, primary: string | null | undefined): { ref: CategoryRef; label: string } | null` — label is lowercase words for the reason ("fast food").
  - `builtinRules.ts`: `export const GAS_STATIONS: readonly string[]`, `export function builtinCategory(subject: { merchant: string; amountCents: number; bankDetailed: string | null }, cutoffCents: number): { ref: CategoryRef; reason: string } | null`
  - `autoCategory.ts`:
    ```ts
    export interface AutoContext {
      rules: readonly Rule[];                 // Rule gains amountMin/amountMax/learned (Task 3 adds to type)
      bills: readonly { merchant: string; cents: number; categoryId: number | null; name: string }[];
      cutoffCents: number;
      categoryIdOf: (ref: CategoryRef) => number | null;
    }
    export interface AutoSubject { name: string; merchantName: string | null; merchant: string; accountId: number; amountCents: number; bankDetailed: string | null; bankPrimary: string | null }
    export interface AutoResult { categoryId: number | null; ruleId: number | null; source: 'rule' | 'auto' | null; reason: string | null; action?: RuleAction }
    export function categorize(subject: AutoSubject, ctx: AutoContext): AutoResult
    ```

- [ ] **Step 1: Write failing tests** in `tests/autoCategory.test.ts`:
  - `gas station under the cutoff is Habits`: Shell −2499 → Habits, reason `Under $25 at a gas station`; −2500 → Gas, reason `Gas station`.
  - `bank gas category counts as a gas station`: unknown merchant, detailed `TRANSPORTATION_GAS`, −1200 → Habits.
  - `known names`: NETFLIX.COM → Subscriptions; ROCKET MORTGAGE → Housing; AIDVANTAGE → Loans; GEICO → Insurance; T MOBILE → Phone; XFINITY → Internet.
  - `bank detailed then primary`: `FOOD_AND_DRINK_FAST_FOOD` → Coffee & Fast Food (reason `Bank says: fast food`); detailed unknown + primary `FOOD_AND_DRINK` → Eating Out; `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT` → Transfers; `INCOME_WAGES` (positive) → Paychecks.
  - `rules beat bills beat built-in beat bank`: one subject matching all four layers returns the rule; remove the rule → the bill (reason `Matches your bill Netflix`); remove the bill → built-in; remove built-in match → bank.
  - `learned rule amount range`: rule Shell 2500..6000 → Habits matches −4000, not −1000 and not −7000.
  - `refunds don't hit spending rules`: Shell +1500 and Netflix +1549 skip built-in, fall to bank.
  - `nothing matches`: returns `{ categoryId: null, source: null, reason: null }`.

- [ ] **Step 2: Run** `npx vitest run tests/autoCategory.test.ts` — Expected: FAIL (modules missing).

- [ ] **Step 3: Implement** the three modules. Bank map covers every Plaid primary and the detailed values named in the spec; full Plaid taxonomy list is in Plaid's docs (`personal_finance_category` v1). Built-in name matching: `merchant` (normalized key) starts with or contains a listed token, case-insensitive. Bills match when `merchant` equals the bill's merchant key (or its `"<merchant> $N"` variant) and `sameBill` (ratio 2) holds; move `sameBill` from `src/worker/routes/planning.ts` to `src/shared/recurring.ts` and import it in both places.

- [ ] **Step 4: Run** `npx vitest run tests/autoCategory.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "Categorizer: rules, bills, built-in patterns and bank categories"`

---

### Task 3: Use the categorizer in sync, import and reclassify

**Files:**
- Modify: `src/shared/rules.ts` (`Rule` gains `amountMin?: number | null; amountMax?: number | null; learned?: boolean`; `ruleMatches(rule, subject)` checks `|amountCents|` within the range when `subject.amountCents` is given; `RuleSubject` gains `amountCents?: number`)
- Modify: `src/worker/services/context.ts` (`RULE_SELECT`/`RuleRow`/`toRule` read the new columns; `IngestContext` gains `bills`, `cutoffCents`, `categoryIdOf`)
- Modify: `src/worker/services/ingest.ts` (`classify()` calls `categorize()` in place of `findRule()`; `Classification` gains `categoryReason: string | null`; `INSERT_SQL`, `reclassify()` and `STORED_SELECT` write/read `category_reason`, `plaid_category_detailed`)
- Modify: `src/worker/plaid/sync.ts:120-131` (`IncomingTxn.plaidCategoryDetailed = t.personal_finance_category?.detailed ?? null`; also written on modify)
- Test: `tests/sync.test.ts`, `tests/import.test.ts`

**Interfaces:**
- Consumes: `categorize`, `AutoContext` (Task 2).
- Produces: `classify(ctx, txn, current?)` unchanged signature; `Classification.categoryReason`. `IncomingTxn.plaidCategoryDetailed?: string | null`.

- [ ] **Step 1: Write failing tests** in `tests/sync.test.ts`:
  - `a synced Shell charge under $25 lands in Habits with a reason`: sync a sandbox-shaped transaction (existing helpers in `tests/helpers/plaid.ts`) with `personal_finance_category: { primary: 'TRANSPORTATION', detailed: 'TRANSPORTATION_GAS' }`, amount 6.41 → row has Habits, `category_source = 'auto'`, `category_reason = 'Under $25 at a gas station'`, `plaid_category_detailed = 'TRANSPORTATION_GAS'`.
  - `hand-set charges keep their category through a modify`: set by hand, then a `modified` sync with a new name → category unchanged.
  - `splits are skipped`: a split transaction's category stays `NULL` with `is_split = 1` after reclassify.
  - Paycheck matching and card-payment detection still win over the categorizer (existing tests cover; keep them green).

- [ ] **Step 2: Run** `npx vitest run tests/sync.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** Order inside `classify()`: user/split early return (existing) → paycheck → `categorize()` (rules incl. ignore/kid/private actions come back in `action`) → card payment → personal-card default → `enforceFunMoney`. `loadIngestContext` loads confirmed `recurring_bills` and `household.habit_cutoff_cents`.

- [ ] **Step 4: Run** `npx vitest run` — Expected: all PASS.

- [ ] **Step 5: Commit** `git commit -m "Categorize synced and imported charges automatically, with a reason"`

---

### Task 4: Recategorize everything (batched)

**Files:**
- Create: `src/worker/routes/categorize.ts` (mounted in `src/worker/index.ts` route list)
- Modify: `src/worker/routes/core.ts:58-75` (`PATCH /household` accepts `habitCutoffCents`, int 0..100000)
- Modify: `src/client/screens/Settings.tsx` (cutoff field "Small gas-station charges count as Habits under $__"; "Recategorize everything" button with progress)
- Modify: `src/client/App.tsx` (on load, if `me.household.categorizedAllAt` is null, run the loop once in the background and reload)
- Test: `tests/categorize.test.ts`

**Interfaces:**
- Produces: `POST /api/categorize/all` body `{ afterId?: number }` → `{ updated: number; nextAfterId: number | null }`. Processes up to 500 transactions with `id > afterId` ordered by id, skipping `category_source = 'user'` and splits, via `reclassify()`. When `nextAfterId` is null it sets `household.categorized_all_at`. Client helper `recategorizeAll(onProgress?: (done: number) => void): Promise<number>` in `src/client/sync.ts`.

- [ ] **Step 1: Write failing tests**: 1,200 seeded charges → three calls (`nextAfterId` non-null, non-null, null), all non-hand-set charges categorized, hand-set untouched, `categorized_all_at` set; changing the cutoff to 1000 and re-running moves a $15 Shell charge from Habits to Gas.
- [ ] **Step 2: Run** `npx vitest run tests/categorize.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the route, household field and client pieces.
- [ ] **Step 4: Run** `npx vitest run` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Recategorize all history in batches; adjustable gas-station cutoff"`

---

### Task 5: One-tap fix that learns, with Undo

**Files:**
- Create: `src/worker/services/learn.ts`
- Modify: `src/worker/routes/transactions.ts:261-345` (category change calls `learnFromFix`; the "Always file X?" suggestion block is removed and the response drops `suggestion`)
- Create route: `POST /api/category-moves/:id/undo` in `src/worker/routes/transactions.ts`
- Modify: `src/worker/index.ts` scheduled cron: delete `category_moves` older than 1 day
- Modify: `src/client/screens/TransactionSheet.tsx` (remove the rule-suggestion banner and `acceptRule`), `src/client/App.tsx` + `src/client/state.tsx` (toast gains `action?: { label: string; run: () => void }` and `durationMs`)
- Test: `tests/learn.test.ts`

**Interfaces:**
- Produces: `learnFromFix(db, ctx, viewer: Viewer, txn: StoredTxn, categoryId: number): Promise<{ moved: number; moveId: number | null; ruleId: number }>`. `PATCH /transactions/:id` response gains `move: { id: number; moved: number; merchant: string; categoryName: string } | null`.
- Learned rule shape: `match_field = 'merchant'` if the charge has `merchant_name`, else `'name'`; `match_text` = the normalized merchant key; `learned = 1`; `position` = `MIN(position) - 10`; amount range only for gas-station charges: under cutoff → `0..cutoff-1`, otherwise `cutoff..NULL`. Re-uses an existing learned rule with the same match text and range (updates its category) instead of adding another; `rule_before` stores its old row.
- Re-filing: charges matching the rule, `category_source IS NULL OR != 'user'`, `is_split = 0`, visible to the viewer (`PRIVACY_SQL`), excluding the fixed charge, limit 2000; each recorded in `category_move_items`.

- [ ] **Step 1: Write failing tests** in `tests/learn.test.ts`:
  - `fixing one Shell charge re-files the others and learns`: 3 auto-Habits Shell charges at $40 → fix one to Gas → other two Gas, `move.moved = 2`, one learned rule `2500..NULL`.
  - `fix leaves hand-set charges alone`.
  - `fill-ups stay put when you fix a small one`: $6.41 Shell fixed to Coffee & Fast Food → $45 Shell charges stay Gas.
  - `undo restores everything`: after undo every charge has its old category, source and reason; the created rule is gone.
  - `undo restores a changed rule`: an existing learned rule updated by the fix gets its old category back.
  - `undo of an older move is refused`: two fixes on the same rule; undoing the first → 409.
  - `private fix stays private`: fix into your Fun Money → rule has your `private_member_id`/`owner_member_id`; partner's charges from that merchant don't move; partner's rule list doesn't show it.
  - `no prompt any more`: response has no `suggestion` key.
- [ ] **Step 2: Run** `npx vitest run tests/learn.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `learn.ts`, the route changes and the toast action (6000 ms when an action is present).
- [ ] **Step 4: Run** `npx vitest run` — Expected: PASS (update tests that asserted the old suggestion).
- [ ] **Step 5: Commit** `git commit -m "Fixing a category learns quietly and re-files similar charges, with Undo"`

---

### Task 6: Needs a look, reasons on charges, learned rules on the Rules screen

**Files:**
- Modify: `src/worker/routes/budget.ts:149` (`GET /home` adds `needsLook: { count: number; items: Transaction[] }` — spending charges, last 60 days, `category_id IS NULL`, not ignored/transfer/pending, visible to the viewer, newest 5)
- Modify: `src/client/screens/Home.tsx` (card "Needs a look" listing items, tap opens `TransactionSheet`; hidden when count is 0)
- Modify: `src/worker/routes/transactions.ts` `TXN_SELECT` adds `t.category_reason AS categoryReason`; `src/client/types.ts` `Transaction.categoryReason: string | null`
- Modify: `src/client/screens/TransactionSheet.tsx` (field hint under Category: the reason, or "Set by you")
- Modify: `src/worker/routes/rules.ts` list returns `learned`, `amountMinCents`, `amountMaxCents`; `src/client/screens/Rules.tsx` shows "Learned from your fix" / "You made this" and the range ("under $25", "$25 and up")
- Test: `tests/planning.test.ts` (home), `tests/learn.test.ts` (rules list fields)

**Interfaces:** Consumes `Classification.categoryReason` (Task 3) and learned rule columns (Task 1).

- [ ] **Step 1: Write failing tests**: `/home` returns `needsLook.count` and at most 5 items, excludes your partner's private charges and transfers; `/rules` marks a learned rule with its range.
- [ ] **Step 2: Run** `npx vitest run tests/planning.test.ts tests/learn.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** server fields and the three client changes.
- [ ] **Step 4: Run** `npx vitest run && npm run build` — Expected: PASS.
- [ ] **Step 5: Check in a browser** with the local dev server on a scratch copy of `.wrangler/state` (back up first, restore after): Home shows Needs a look; a charge sheet shows its reason; fixing one shows the Undo toast and Undo works; Rules lists the learned rule. Phone width (390px) and desktop.
- [ ] **Step 6: Commit** `git commit -m "Needs a look on Home, why each charge landed where it did, learned rules listed"`

---

### Task 7: Refresh bank details for older charges

**Files:**
- Modify: `src/worker/routes/plaid.ts` (`POST /plaid/items/:id/refresh-details`: sets `cursor = NULL, has_more = 0, history_complete = 0` for that item)
- Modify: `src/worker/plaid/sync.ts` (when an `added` transaction's `plaid_txn_id` already exists, update `plaid_category`, `plaid_category_detailed` on that row and reclassify it, instead of counting it as a duplicate only)
- Modify: `src/client/screens/Accounts.tsx` (per bank: "Refresh bank details" button → calls the endpoint, then `syncOneBank` until done, then toast "Updated N charges")
- Test: `tests/sync.test.ts`

**Interfaces:** Produces the endpoint above returning `{ ok: true }`.

- [ ] **Step 1: Write failing test** `re-sent history fills in detailed categories`: seed a row with only `plaid_category = 'FOOD_AND_DRINK'`, run refresh + sync where Plaid re-sends it with detailed `FOOD_AND_DRINK_FAST_FOOD` → row gets detailed and moves from Eating Out to Coffee & Fast Food; no duplicate row; a hand-set row only gets the detailed column.
- [ ] **Step 2: Run** `npx vitest run tests/sync.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Refresh bank details to sort older charges by the bank's detailed category"`

---

### Task 8: Dry run on a copy of the real data

No product code. The user runs the export; nothing touches the live database.

- [ ] **Step 1: Ask the user to run** `! npx wrangler d1 export fin --remote --output <scratchpad>/fin-backup.sql` (this is also their backup).
- [ ] **Step 2: Load it locally** into a fresh SQLite file in the scratchpad (`node:sqlite`), record per-month totals by kind, apply `migrations/0003_category_set.sql`, record totals again. Expected: identical.
- [ ] **Step 3: Run the categorizer** over every row with a small script that imports `categorize` and the same context loading as `loadIngestContext` against the local file. Report: share of last-90-days spending in "Needs a look" (target < 5%), counts per new category, and the 20 largest uncategorized merchants.
- [ ] **Step 4: Tune** `builtinRules.ts`/`bankCategories.ts` for any large uncategorized merchants found; add each to `tests/autoCategory.test.ts` first. Commit `git commit -m "Tune built-in rules from a dry run"`.
- [ ] **Step 5: Delete** the export and local copy from the scratchpad, and give the user the release steps: `npx wrangler d1 migrations apply fin --remote`, `npm run deploy`, open the app (recategorize-all runs once), then Accounts › Refresh bank details per bank.
