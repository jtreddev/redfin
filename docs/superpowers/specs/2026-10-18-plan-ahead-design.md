# Plan › Ahead: where the extra money goes

Project 7. The user's request (2026-10-18): "This doesn't really take paydown of debt into goals or
anything like that. Should we build it in a new UI for now? Something that takes bill and other type
transactions (maybe bills and then + for unexpected / known month transfers) Then sliders for
goals/debts/maintance things? Again this should be automated with the ability to change things and as
simple things easy and hard things possible."

The user's answers:
- **Where it lives:** inside Plan.
- **Sliders:** preview first, then "Save as my plan".
- **Extra debt money:** goes to the highest interest rate first.
- **Credit cards:** link them to debts automatically, "but more should be possible". That means
  any other kind of debt can be added too.

Live data has 4 debts, 5 credit-card accounts, 3 planned costs (Car, Health, Holidays & gifts),
11 confirmed bills and 0 goals.

Claude made the remaining calls on the user's standing instruction not to ask for approvals. Each
one is recorded as a ruling (P7-Rn) with what it costs if wrong.

## Where it lives

Plan's views become **Budget · Weeks · Bills · Goals · Ahead**.

- Ahead has its own route, `#/plan?view=ahead`.
- **Trends › Ahead moves here** (P7-R1). Trends goes back to history only, and its Past/Ahead
  switch is removed.
  - `#/trends?view=ahead` redirects to `#/plan?view=ahead`.
  - Home's "See the next few months" link points here.
  - The Project 6b screen sections (summary, charts, months to watch, set-asides, goals, habits) are
    reused inside the planner, not rebuilt.

## The screen, top to bottom

### 1. The months (automatic)

The horizon switch (3 months, 6 months or 1 year) and the month table/chart come from Project 6b.
Each month shows money in and the money-out groups. Tapping a month opens a sheet listing what is
in it:
- paydays;
- each bill and its date;
- the usual spending per group;
- planned-cost spends;
- debt payments;
- known items (see "＋ Add" below);
- surprises.

The list is grouped. Each automatic line says where it came from, for example "Confirmed bill",
"Your budget", "Usual (last 3 months)" or "Like last Dec".

### 2. ＋ Add: known items (manual, optional)

An **＋ Add** button is always visible. A small form takes:
- a name;
- an amount;
- "Money in" or "Money out";
- a month;
- how often: once, every month, or every year;
- an optional end month for repeats.

Examples: tax refund (in), car registration (out), a transfer to savings (out), and a one-off
"birthday party".

- Items are listed under the month table. Each can be edited or deleted.
- Items are household-wide, and stored in `ahead_items` (migration 0011).
- Items appear in the month sheet and in the cash numbers.

### 3. Surprises cushion (automatic, adjustable)

The cushion is a monthly amount for the unexpected. It is counted as money out in every whole month.

- **Suggested value:** the median, over the last 6 full months, of each month's spending that was
  neither a confirmed bill, a due-day budget line, a planned-cost category, nor under $100 per
  transaction (P7-R2). It is rounded to $25.
- **Display:** shown as "Surprises: $150 a month (suggested)" with a stepper.
  - Once changed, it reads "(your amount)".
  - A **Use suggestion** button switches back.
- **Storage:** `household.surprise_cents`. NULL means use the suggestion.
- *Cost if wrong:* a too-high cushion makes every month look tighter. The suggestion is visible and
  can be changed.

### 4. Where the extra goes (the sliders)

**Headline.** "About **$X a month** left over after bills, everyday spending, minimums and
set-asides." This is the average over the horizon's whole months of left-over before any extra.
Under it is a bar showing allocated versus unallocated. If the sliders add up to more than the
left-over, the bar reads "$Y over what's left". That state is allowed, but it is flagged.

**One row per item, in three groups:**

1. **Set-asides** (Car, Health, Holidays & gifts). The slider is the monthly set-aside. The
   readout is the balance at the horizon's end, or a "Runs short in <Mon>" flag.
   - The starting value is the current monthly amount.
2. **Debts.** The slider is the **extra** on top of the minimum payment. The readout shows:
   - "Paid off <Mon Year> · $X interest";
   - with any extra, the change, e.g. "4 months sooner · saves $310".
   - If a debt won't be paid off within 30 years, it says "Not paid off at this rate".
3. **Goals.** The slider is the monthly amount. The readout is "Reached <Mon Year>", or "Not
   reached" when the amount is $0.
   - With no goals, a single line reads "Add a goal" and opens the existing goal form.

**Slider details:**
- Each slider has a number field beside it, so you can type an exact amount.
- The step is $5.
- The range runs from 0 to the larger of 2 × the left-over and the item's current value.
- Targets are at least 44px, and each slider has a label and a value readout for screen readers.

**Fill automatically.** This button splits the left-over, in this order (P7-R3):
1. Each set-aside is raised to what keeps it from running short within the horizon.
2. Each goal with a target date gets what reaches it on time.
3. Everything left goes to debts by highest APR. Ties go to the smallest balance.
4. If no debts are left, the remainder goes to goals evenly.

The split is a pure function and can be tested. Moving a slider by hand never moves the other
sliders (P7-R4). The headline bar shows the effect. *Cost if wrong:* the user balances by hand, or
presses Fill automatically again.

**Debt order.** It is highest interest first (avalanche) by default. A link, "Change order", lets the
user pick "Smallest balance first" or "My order". My order shows ↑/↓ buttons, the same pattern as
Categories reorder. The order sets which debt gets money freed when another is paid off. The extra
rolls over (snowball-style roll-over under every strategy). It is stored in
`household.debt_strategy` ('avalanche' | 'snowball' | 'custom') and `debts.sort`.

### 5. The results (live as sliders move)

- **Debt-free date.** Shown as "Debt-free by <Mon Year>", and on a second line "$X interest from
  now". The change against the saved plan is shown when it differs.
- **Debt balance chart.** Total debt by month over the horizon, as a line falling toward zero. When
  it is longer than the horizon, the summary text says when it hits zero.
  - It includes a table toggle.
  - It uses the existing chart patterns and hide-amount classes.
- **Cash chart.** The Project 6b end-of-month cash chart, which now includes extra debt payments,
  set-aside changes and goal amounts as money out.

### 6. Save as my plan

The **Save as my plan** button is enabled only when something differs from the saved plan. A
**Reset** button sits next to it. Saving opens a confirm sheet that lists exactly what changes, and
then:

- **Debts:** writes `debts.extra_cents` for each debt.
- **Set-asides:** writes a `planned_cost_amounts` row effective **next month** (the existing
  "effective from that month on" model). This month is left as is (P7-R5).
- **Goals:** writes `goals.monthly_cents`.
- **Budget:** updates the budget from next month on. If those months already exist, it updates:
  - the goal-category budget lines;
  - the Loans/debt lines, which get min + extra when the debt is linked to a category.

  If they don't exist, the values are stored and used when the month is created, i.e. carried
  forward. Only lines that changed are touched.
- **Settings:** writes `household.surprise_cents` and `household.debt_strategy`.

All writes happen in one D1 batch, and a toast confirms "Plan saved". There is no Undo, which is
why the confirm sheet lists everything (P7-R6).

The saved plan is the starting point for the sliders next time. It also feeds the Months ahead
numbers and Until payday (extra debt payments made on the debt's due day count as events, and goal
amounts count as saving).

## Debts: automatic, with more possible

### Auto-link

On every load of Ahead or Plan › Goals › Debts, and after every Plaid sync, each `accounts` row of
type `credit`, plus `loan` when present, gets a debt linked by `debts.account_id`.

- An existing debt is matched by name or by its existing `account_id`.
- If there is no match, a debt is created with `source = 'plaid'`, the account's name and
  `kind = 'credit_card'`.
- **The balance always comes from the account:** `current_balance_cents`, made positive. It is not
  edited by hand while linked.
- **APR and minimum** are filled from Plaid liabilities data when the item has it (check what
  `plaid/` already fetches; don't add a new Plaid product). Otherwise:
  - APR is left at 0 and flagged "Add the interest rate". With APR 0, payoff readouts say "no
    interest rate yet".
  - The minimum is estimated as the larger of $25 and 1% of the balance plus a month's interest. It
    is marked "estimated" until edited.
- **Paid in full.** A card whose payments over each of the last 3 statement-sized cycles cleared its
  balance is marked "Paid in full each month" (`debts.paid_in_full = 1`; P7-R7).
  - Such cards are left out of payoff, the sliders and the debt total.
  - Their spending is already counted as everyday/fun etc.
  - A toggle on the debt lets the user change this either way.
  - Detection runs once, at link time. After that the user's toggle wins.
  - *Cost if wrong:* a carried card is hidden until the user flips the toggle. The Debts list shows
    paid-in-full cards in a separate "Paid in full" group so it's visible.

### More possible

Plan › Goals › Debts, and Ahead's debt rows, have **＋ Add a debt** for anything that isn't at a
bank: a car loan, student loan, mortgage, medical bill, buy-now-pay-later, money owed to family, or
something else.

- Fields: name, kind, balance, APR (optional), minimum payment, due day, and link to a bill or
  category (optional).
- **Kind** is stored in `debts.kind`: credit_card, car, student, mortgage, medical, personal,
  bnpl, family or other.
- **Manual debts** have editable balances. A "Balance as of <date>" note nudges the user to update.
- **Optional end date** for fixed-term loans, e.g. BNPL with 4 payments. When it's set, payoff uses
  the term.
- **Linking to a bill or category** avoids double counting. A debt linked to a confirmed bill or a
  due-day budget line has its minimum counted **once**: as that bill, not as a separate debt
  payment (P7-R8). Unlinked debts' minimums are counted as debt payments on their due day.
  - Auto-suggest the link when a confirmed bill's merchant or name matches the debt's name or
    account. The suggestion is shown, never applied silently.

### Payments counted in the forecast

**Card minimums plus extra.** Payments from checking to a card are transfers today, so they are not
in bills or usual. The forecast therefore counts each unlinked, not-paid-in-full debt's
**minimum + extra** as money out on its due day. When there's no due day, it is the 15th.

**Balances.** Each debt's balance runs month by month: balance + interest − payment, floored at 0.
When a debt is paid off, its payment rolls to the next debt in order.
- New card spending isn't added to the debt balance. It is assumed to be paid within the usual
  spending (P7-R9).
- *Cost if wrong:* someone who keeps adding to a carried card sees a too-early payoff date. The
  copy under the debt total says "assumes new card spending is paid each month".

**Existing code.** Use `src/shared/debt.ts` `planPayoff` / `monthlyInterest` as the engine. Extend
it rather than writing a second simulator:
- custom order;
- per-debt extra;
- a month-by-month balance series;
- terms;
- paid-in-full excluded.

## Data: migration 0011_plan_ahead.sql

Plain ALTERs plus one CREATE TABLE, with no temp tables:

- `debts`:
  - `kind TEXT NOT NULL DEFAULT 'other'`;
  - `extra_cents INTEGER NOT NULL DEFAULT 0`;
  - `sort INTEGER NOT NULL DEFAULT 0`;
  - `paid_in_full INTEGER NOT NULL DEFAULT 0`;
  - `min_estimated INTEGER NOT NULL DEFAULT 0`;
  - `end_month TEXT`;
  - `bill_id INTEGER REFERENCES recurring_bills(id) ON DELETE SET NULL`;
  - `category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL`;
  - `balance_as_of TEXT`.
  - Add an UPDATE that sets `kind = 'credit_card'` for debts whose linked account is type credit.
- `goals`: `monthly_cents INTEGER` (NULL = not set).
- `household`:
  - `surprise_cents INTEGER` (NULL = suggested);
  - `debt_strategy TEXT NOT NULL DEFAULT 'avalanche'`.
- `ahead_items`:
  - `id INTEGER PRIMARY KEY`;
  - `name TEXT NOT NULL`;
  - `amount_cents INTEGER NOT NULL` (positive = in, negative = out);
  - `month TEXT NOT NULL`;
  - `repeat TEXT NOT NULL DEFAULT 'once' CHECK (repeat IN ('once','monthly','yearly'))`;
  - `end_month TEXT`;
  - `created_by INTEGER REFERENCES members(id)`;
  - `created_at`, `updated_at`.

The category merge's re-pointing (`CATEGORY_REFERENCES` in `services/categories.ts`) must include
`debts.category_id`. The coverage guard test will enforce this.

## Engine and API

**Engine.** A pure `planAhead(input, plan): PlanAheadResult` in `src/shared/planAhead.ts`.
- **Input:** the Project 6b `MonthsAheadInput`, plus debts, goals, planned costs, ahead items, the
  surprise amount and the strategy.
- **`plan`:**
  - per-debt extra;
  - per-cost monthly;
  - per-goal monthly;
  - the surprise amount;
  - the strategy and custom order.
- **Output:** the 6b `MonthsAhead`, with these lines added to each month: debt payments, known
  items, surprises, set-aside changes and goal saving. Also:
  - the left-over before extra (average over whole months);
  - per-debt payoff month, interest and balance series;
  - debt-free month and total interest;
  - per-cost balance and runs-short month;
  - per-goal reached month;
  - allocated and unallocated amounts.
- **`autoFill`.** A pure `autoFill(input): Plan` implements Fill automatically.
- **Client re-runs.** The client re-runs `planAhead` on every slider move, so no request is made
  per move. It must run in under 16 ms for 12 months, 10 debts and a 30-year payoff tail. The payoff
  tail beyond the horizon only needs debt balances, not full months.

**Routes:**
- `GET /api/ahead` returns the inputs, the saved plan and the suggestion values. Months ahead's
  `/forecast/months` either becomes this route or shares its gathering. It stays within the
  50-query D1 limit, and a test caps it at 35.
- `POST /api/ahead/plan` saves the plan as described in "Save as my plan".
- `GET/POST/PATCH/DELETE /api/ahead/items` handles known items.
- The debts routes are extended with the new fields, and auto-link runs as described. Auto-link
  must be idempotent and must not create duplicates on concurrent loads; use a unique index or
  `INSERT … WHERE NOT EXISTS`.

**Privacy.** Debts, goals, items and the plan are household-wide, as debts and goals already are.
Partner private bills are never shown, under the existing rules. Private charges count only as Fun
Money totals.

## Simple versus power

**Default view, simple:**
- the months;
- the headline;
- Fill automatically;
- one slider per item;
- the debt-free date;
- Save.

**With "Show more tools" on, also:**
- per-month sheet details;
- the debt order control;
- the debt balance chart's table;
- the surprises stepper. Without power tools it shows the suggestion read-only, with a "Change"
  link that still works.
- the Project 6b what-if controls.

＋ Add and ＋ Add a debt are always available.

## Testing

**Engine:**
- the payoff series and roll-over under each strategy, including custom;
- the interest math against `debt.ts`;
- a term loan ending;
- paid-in-full cards excluded;
- a debt linked to a bill counted once;
- known items: once, monthly, yearly and with an end month;
- the surprise suggestion: median, the filters, rounding;
- autoFill's order and the set-aside "doesn't run short" amount;
- over-allocation;
- the speed bound.

**API:**
- auto-link is idempotent, including two loads in a row and concurrent loads;
- the estimated minimum;
- paid-in-full detection;
- save writes exactly the listed rows, in one batch, with next month's `planned_cost_amounts`;
- items CRUD;
- two partners, with a private bill never visible;
- the query cap;
- category merge re-points `debts.category_id`.

**Checks:** the full suite, typecheck and build all pass.

**Browser check** at 360/390 and 1280 px, in light and dark:
- the sliders by touch and keyboard;
- Fill automatically;
- Save and its confirm sheet;
- ＋ Add;
- ＋ Add a debt;
- the month sheet;
- hide amounts;
- the Trends redirect.

## Rulings made while building (Task 1: engine and API)

- **P7-R10 The plan starts next month.** Extras, set-aside changes, goal amounts and surprises count in whole
  months only. In the rest of this month a debt pays its minimum if its due day is still ahead, with no
  interest yet, and known items dated this month count. *Cost:* an extra paid this month shows from next.
- **P7-R11 A linked debt is counted once, by the plan from next month.**
  - This month its linked bill, or its category's line, counts it. It isn't paid again.
  - From next month the gatherer takes out its linked bill and the bills and due-day lines in its category
    (sub-categories too). The plan then counts minimum + extra on the due day (the 15th without one).
  - Its category's money is also left out of "other bills" (P6b-R17).
  - *Cost:* a hand-typed line bigger than the minimum shows as minimum + extra until the plan is saved.
    Another payment filed in that category is dropped from next month on.
- **P7-R12 A goal's saving line becomes the goal's monthly amount from next month.**
  - With no saved amount, the slider starts at next month's line (or $0).
  - Saving stops once the goal is reached.
  - Months ahead's goal readout uses a saved amount as the pace.
  - *Cost:* a line that differs month to month is flattened to next month's.
- **P7-R13 Set-asides.**
  - The cash numbers count the change (slider − current) as money out, from next month.
  - The costs' expected spending stays as Project 6b works it out.
  - The headline left-over subtracts the current set-asides in place of the costs' lumpy spending, so it's
    even month to month.
  - Allocated is debt extras + set-aside changes + goal amounts.
  - *Cost:* with under a year of history, raising a set-aside counts as out once (as the change), not as
    more spending too.
- **P7-R14 A planned cost with no linked categories gets no slider.** Months ahead leaves it out, because its
  spending can't be told apart. It is still edited in Planned Costs.
- **P7-R15 Auto-link details.**
  - Hidden accounts are skipped. A new loan gets kind 'other', or 'student' from Plaid's subtype.
  - "Made positive" is `MAX(0, balance)`. Credit balances are stored positive when owed, and a negative one is
    money the bank owes you, as sync already treats it.
  - A linked debt's balance and estimated minimum are read live from the account, by the API and by the
    budget lines Save and month creation write. The stored copy is refreshed after a sync.
  - A sync links first, so a debt of the same name takes a new card before liabilities data would add one. A
    hidden liability account still gets its debt from the liabilities data, as before.
  - Steady state costs one query. A load that links something costs three.
- **P7-R16 Paid-in-full detection.**
  - Cycles are calendar months. In each of the last 3 full months, a payment came in that covered the month
    before's charges, to the dollar.
  - It runs only when a card is linked. Debts linked before migration 0011 aren't checked.
  - *Cost:* a card already linked and paid in full stays in payoff until the toggle is flipped.
- **P7-R17 Estimated minimums.**
  - A debt added by hand with no minimum is estimated too.
  - So is a Plaid card whose bank gives no minimum. Before this it was $0.
  - Any typed minimum, or one from the bank, ends the estimate.
- **P7-R18 Surprise suggestion details.**
  - It counts shared charges only. Private ones are fun money.
  - It counts charges with no category or an expense category, and leaves out transfers and splits.
  - A charge is a confirmed bill when its merchant matches a confirmed bill's.
  - A month with nothing counts as $0.
- **P7-R19 Save.**
  - In later months that already have a budget, a goal line is added where it's missing.
  - A new debt line is due on the linked debts' first due day.
  - Only next month's `planned_cost_amounts` row is written, as Planned Costs' edit does. A later row, if
    any, still wins from its month.
  - Copying a budget into a later month, and a check-in creating next month, apply the saved goal and debt
    lines.
- **P7-R20 Until payday.**
  - A debt's minimum is an event on its due day this month, unless a linked bill or line counts it.
  - Later months get minimum + extra, in place of its bill or lines.
  - A saved goal amount is an event on the 1st of each later month, in place of the goal's lines.
  - Known items and surprises aren't in Until payday.
- **P7-R21 The suggestion runs in the browser.** `GET /api/ahead` doesn't run `autoFill`, to keep the Worker
  within 10 ms of CPU. The client calls `autoFill(input)`.
- **P7-R22 My order.** Debts missing from the order follow, highest rate first. Save writes `debts.sort`
  only where it changed.
- **P7-R23 Bill-link suggestion.** A visible confirmed bill whose name contains the debt's or its account's
  name, or the reverse, or whose merchant (3+ letters) appears in either.
- **P7-R24 Measured D1 queries** (middleware included):
  - `/ahead`: 34 on a load that links a card, 32 after.
  - `/forecast/months`: 31.
  - `/forecast`: 23.
  - The test bound is 35. Removing a duplicate income-sources query saved one.
