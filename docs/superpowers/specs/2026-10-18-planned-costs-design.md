# Planned costs: setting money aside for the things that always come up

Project 3 of 4 (1: automatic categorizing, shipped; 2: Trends; 4: redesign). Design calls were
made by Claude on the user's standing instruction not to ask for approvals. The user's answers
it builds on: money is **tracked in the app** — a suggested monthly amount per cost from
history and a running balance for each; the money itself stays in one savings account and
nothing moves automatically. Costs to suggest: **Car** (upkeep, tires, oil changes,
registration, license), **Health** (dentist, glasses, deductibles, vet), **Holidays & gifts**
(Christmas, birthdays, back-to-school, clothing, yearly subscriptions). Not home costs.

## Goal

Turn the lumpy costs of normal life into a steady monthly amount, so a $600 tire bill is
"already covered" instead of a surprise, and the plan for the month accounts for it.

## Model

A **planned cost** has: a name, a monthly set-aside, a start month, a starting balance, and the
spending categories it pays for.

- Balance = starting balance + monthly set-aside × months since the start month (counting the
  start month and the current month) − money spent in its categories since the start month
  (the same counting rules as budgets: `ledgerEntries` + `flowCents`; refunds add back).
- A balance can go negative ("$120 short") — it is shown, not hidden.
- Changing the monthly amount applies from the current month forward: store set-aside changes
  as rows (`month`, `monthly_cents`) so past months keep the amount they had.
- Each spending category belongs to at most one planned cost.

Defaults, created automatically the first time Plan › Goals loads when none exist (the user is
hands-off; they can edit or delete them):

| Name | Categories | Suggested monthly |
|---|---|---|
| Car | Car Upkeep | history |
| Health | Medical | history |
| Holidays & gifts | Gifts, Shopping (clothing), plus yearly bills' categories don't move — see "Coming up" | history |

Suggested monthly = the average monthly spend in its categories over the last 12 full months
(months before the first transaction in history don't count; at least 3 months needed),
rounded up to the next $5. With under 3 months of history: Car $50, Health $40, Holidays &
gifts $75. Start month = the current month; starting balance = $0.

Holidays & gifts links Gifts only by default (Shopping is too broad to be "gifts"); the edit
sheet lets them add Shopping.

## Coming up

Each planned cost shows what is likely next:
- Confirmed **yearly** bills (recurring_bills, cadence yearly, status confirmed) whose
  category is linked to the cost: "Amazon Prime, about $139, due Mar 3".
- For costs with 12+ months of history: the biggest month last year if it's within the next
  3 months: "December usually costs about $420".

## In the monthly plan

The planner gets a computed budget line `planned_costs` on **Saving › Savings & Planned
Costs** (like the existing computed `paychecks` and `fun_money` lines). So safe-to-spend and
the forecast reserve that money. The line = the household's hand budget on that category
(other savings, like an emergency fund or retirement) **plus** the sum of this month's
set-asides. It does not replace the hand amount: replacing a $900 savings budget with $165
would wrongly raise safe-to-spend (controller ruling P3-R1). The row says "Includes $165 for
planned costs", and the API reports the planned-costs part separately (`plannedCostsCents`)
so the hand part can still be edited on its own.

Spending that a planned cost pays for (e.g. a Car Upkeep charge) still counts against the
Car Upkeep budget line as today; the planned-cost balance is the extra view that says it was
covered.

## Screen

Plan › Goals view (`#/plan?view=goals`), top section **"Set aside each month"**, above savings
goals:

- A total: "$165 a month set aside for 3 costs".
- A card per planned cost: name, balance in large type ("$340 ready" / "$120 short" in the
  warning tone with an icon and the word "short"), "$60 a month", spent in the last 12 months,
  the "coming up" line. Tap → edit sheet.
- Edit sheet: name, monthly amount (with "Suggested: $55 from the last 12 months"), categories
  (multi-select of Bills/Everyday/Habits/Fun & Wants categories not used by another planned
  cost), starting balance, delete. "Add a planned cost" opens the same sheet empty.
- Trends (project 2) is unchanged; its Saving group already shows real money moved to savings.

## Data

Migration `0006_planned_costs.sql`:
- `planned_costs (id, name, start_month TEXT NOT NULL, start_balance_cents INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, created_at, updated_at)`
- `planned_cost_amounts (planned_cost_id REFERENCES planned_costs ON DELETE CASCADE, month TEXT NOT NULL, monthly_cents INTEGER NOT NULL, PRIMARY KEY (planned_cost_id, month))`
- `planned_cost_categories (planned_cost_id REFERENCES planned_costs ON DELETE CASCADE, category_id REFERENCES categories ON DELETE CASCADE, PRIMARY KEY (category_id))` (the primary key enforces one cost per category)
- `household.planned_costs_seeded_at TEXT` (defaults are created once; deleting them all doesn't bring them back)

API: `GET /api/planned-costs` (list with balance, monthly, spent12, comingUp, suggestedMonthly),
`POST /api/planned-costs`, `PATCH /api/planned-costs/:id`, `DELETE /api/planned-costs/:id`.
Shared household data (not private); a partner's private Fun Money categories can't be linked.
Pure math in `src/shared/plannedCosts.ts`.

## Testing

- Pure: balance over months with amount changes, refunds, negative balance, suggestion
  rounding and the 3-month minimum, defaults when history is short, coming-up selection.
- API: seeding once (and not again after deleting all), one-cost-per-category conflict → 409,
  Fun Money categories rejected, planner computed line equals the hand budget on that
  category plus the sum of set-asides (P3-R1), safe-to-spend reflects it.
- Browser check at 390px and 1280px, light and dark.
