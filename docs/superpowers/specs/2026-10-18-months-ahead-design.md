# Months ahead: a 3, 6 and 12 month forecast

This is Project 6b. After Project 6 shipped "Until payday", the user clarified: "When I say forecast I
mean the next 3 mo 6 mo 1 year". The design calls below were made by Claude, because the user has a
standing instruction not to ask for approvals. Each call is recorded as a ruling (P6b-Rn) with what it
costs if it's wrong. "Until payday" stays on Home as the short-term view.

## Where it lives

- The Trends tab gets a segmented control at the top with **Past** and **Ahead**.
  - The URL is `#/trends?view=ahead`.
  - Past is today's Trends screen, unchanged.
- Ahead has a segmented control for **3 months · 6 months · 1 year**.
  - The default is 6 months.
  - The choice is remembered per browser in localStorage, wrapped in try/catch.
- The Home "Until payday" section gets a link: "See the next few months". It opens Ahead.

## The numbers

There is one pure function, `projectMonths(input): MonthsAhead`, in a new file,
`src/shared/monthsAhead.ts`. It has no I/O, so the client can re-run it for what-ifs and for the
3/6/12 switch.

The route `GET /api/forecast/months` always returns the inputs for 12 months plus the rest of the
current month. The client slices them.

**Months.** The current month counts only from tomorrow to its end, and is labelled "Rest of Oct".
After that come the next 3, 6 or 12 whole months.

**Starting cash.** Today's balance across cash accounts, the same as Until payday.

**Each month adds up these parts:**

- **Money in.** For every active income source, the number of pay dates in the month
  (`payDatesBetween`) times `net_pay_cents`.
  - Paydays already received this month are skipped.
  - Months with an extra paycheck say so ("3 paydays").
- **Bills.** Occurrences of every confirmed recurring bill in that month, at its usual amount. This
  includes quarterly and yearly bills.
  - Due-day expense budget lines that no bill covers are added as well.
  - Use the existing `upcomingBills` with `{ until, repeat: true, laterMonths: true }`, with its
    paid / sub-category / carry-forward rules: this month's lines carry forward when a month has no
    budget yet.
  - This group holds the Bills section plus any bill that is an event.
- **Everyday, Habits, Fun & wants.** Each group's monthly usual (`usualOf`, the last 3 full months)
  goes in as a flat amount per month.
  - From it, subtract the monthly-equivalent of confirmed bills in that group, as Until payday does.
  - Also subtract the usual of categories linked to a planned cost, because those are projected
    separately below (P6b-R1).
  - The current month uses usual × the share of days left.
- **Planned costs (Car, Health, Holidays & gifts).** Expected spending per month comes from the
  cost's linked categories.
  - With at least 12 months of history, use the same calendar month last year, so December carries
    the holidays (P6b-R2).
  - With less history, use the cost's monthly set-aside amount (`monthlyFor`).
  - These amounts count in their categories' groups for the chart, so Holidays & gifts appears in Fun &
    wants if that's where its categories sit.
  - *Cost if wrong:* a one-off big spend last year, such as a car repair, is expected again the same
    month this year. The month is labelled "like last <Mon>" so you can see why.
- **Saving.** Each month's savings-kind budget lines, taken from that month's budget or carried from
  this month's. This is money moving out of the cash accounts.
  - The Savings & Planned Costs line has its set-aside part removed, as in P6-R5: set-asides don't
    leave the account.
- **Left over** = in − bills − everyday − habits − fun − saving.
- **End-of-month cash** = previous end + left over.

**Privacy.** The same rules as Until payday apply:
- A partner's private bills are left out.
- Fun Money counts only as group totals.
- A viewer's own private bills are counted in Fun.

**CPU.** Twelve months of bill occurrences plus one trends aggregation. The test covers 3,000
transactions and 30 bills, and the route must stay well under 10 ms.

**Output.** `MonthsAhead` contains:
- `months[]`, where each entry has `{ month, label, partial, payDays, inCents, byGroup: { bills,
  everyday, habits, fun, saving }, leftOverCents, endCents, bigItems[] }`.
  - `bigItems` holds bills and planned-cost spends of $100 or more that aren't monthly ("Car
    insurance $612", "Holidays & gifts, like last Dec, $540").
- `totals` over the horizon.
- `tightest`: the month with the lowest end cash.
- `habitsTotal`.
- `plannedCosts[]`: `{ name, balanceNowCents, lowestCents, lowestMonth, endCents }`. Each balance
  runs forward: balance + monthly set-aside − expected spend.
- `goals[]`: `{ name, projectedMonth | null }`, from `goalProgress`'s recent pace. The value is
  null when nothing is being saved toward it.

## The screen (Trends › Ahead)

Top to bottom, in one column on a phone and two on a computer:

1. **Summary sentence.** "Next 6 months: about $24,300 in, $22,950 out, **$1,350 left over**."
   - Below it, a line on cash: "Cash goes from $2,140 today to about $3,490 by end of April."
   - The bold follows the existing type rules: weight only, no colour.
2. **End-of-month cash chart.** Each month gets one bar or point: end cash.
   - A dashed cushion line marks `low_balance_cents`.
   - Negative months are drawn below the baseline, with a word in the tooltip ("Below zero").
   - Tooltip per month: in, out by group, left over, and big items.
   - Table toggle.
   - Use the existing charts (`Bars` handles negatives? if not, extend it the way BalanceLine
     draws); follow the dataviz rules already in src/client/charts.
3. **Where it goes.** Stacked bars of projected money out by group per month, with the same colours
   and order as Past. Saving is included.
   - Above the stack, a thin income tick per month as a marker on the same axis. The legend reads
     "Money in".
   - Table toggle.
4. **Months to watch.** The tightest month, plus any month whose left over is negative or whose end
   cash dips under the cushion.
   - Each one names its big items: "March: car insurance $612, registration $148."
   - If none: "No tight months ahead."
5. **Set-asides.** One row per planned cost: "Holidays & gifts: $310 now, about −$120 after Dec".
   - When a balance goes negative, the row is flagged with a word and an icon, not colour alone.
   - Suggested fix: "Set aside $X more a month to cover it". X is the shortfall divided by the months
     until then, rounded up to $5.
6. **Goals.** "Emergency fund: about Aug 2027 at your recent pace", or "Not on pace: nothing saved
   toward it lately".
7. **Habits.** "About $2,280 on habits over the next year at your usual pace". This line always shows
   12 months, whatever the horizon.
8. **What if…** This sits behind "Show more tools", reusing the control styles from Until payday.
   - Controls: habits usual / −25% / −50% / none; everyday usual / −10% / −20%; add a monthly cost;
     a one-off cost in a chosen month; and a pay change (+/− an amount per paycheck).
   - It shows the new end cash at the horizon and the difference.
9. **Footnote.** "Based on your bills, budget and the last 3 months of spending. The further out, the
   rougher."

**Empty states.**
- With no income source, say "Add your paydays to forecast money in" and link to Income. The
  projection still runs with $0 in.
- With fewer than 2 months of history, say that everyday spending is estimated from what exists.

## Testing

**Unit tests for `projectMonths`:**
- A partial current month.
- A month with 3 biweekly paydays.
- Quarterly and yearly bills landing in the right months.
- A due-day line carried forward without double counting a bill.
- Usual minus bills and planned-cost categories, floored at 0.
- Planned-cost spend taken from last year's same month versus from the set-aside.
- Savings line without its set-aside.
- Tightest month.
- A planned-cost balance going negative, with the suggested fix rounded to $5.
- Goal month projected or null.
- What-if adjustments.
- Horizon slicing for 3, 6 and 12 months.

**API tests:** two partners, private bill only for its owner; no income sources; CPU with 3,000
transactions.

**Full checks:** test suite, typecheck and build all pass.

**Browser check** at 390px and 1280px, light and dark: Past and Ahead switch, 3/6/12 switch,
tooltips and tables, months to watch, set-asides, goals, what-if, and hide amounts (every amount
blurs).

## Rulings made while building

Each one says what was decided, why, and what it costs if it's wrong.

- **P6b-R3 Totals include the rest of this month.** "Next 6 months" counts the rest of October plus 6 whole
  months, so it ends where the "by end of April" cash line ends. *Cost:* the "6 months" totals run about
  half a month longer than 6 months.
- **P6b-R4 One group per planned cost.** A cost's spending counts in the group where most of its last 12
  months of spending went, or its first linked category's group if it has none. A cost with no linked
  categories is left out: its spending can't be told apart, so it stays in usual. *Cost:* a cost whose
  categories straddle two groups puts all its spending in one, and a cost with no categories doesn't show
  under Set-asides.
- **P6b-R5 A planned cost's own confirmed bills are counted once.** Each month's expected spending leaves
  out bill occurrences in its categories, floored at 0. The usual taken out of its group is its usual less
  those bills' monthly amounts. The cost's balance still pays the bills. *Cost:* last year's bill at a
  different amount leaves a small remainder in or out.
- **P6b-R6 Expected spending counts shared charges only.** A partner's private charges never appear as
  "like last Dec". Today's balance counts every charge, matching the Planned Costs screen. *Cost:* a
  private purchase in a planned-cost category isn't expected again.
- **P6b-R7 This month a year from now uses the set-aside.** October is still running, so October next year
  has no full "last October" to go on. For the rest of this month, a set-aside is × the share of days left,
  and "like last year" is last year's month less what has gone out so far this month (fix round 1). *Cost:*
  a cost that peaks in the current month is underestimated a year out.
- **P6b-R8 Big items.** Big items are quarterly and yearly bills of $100 or more, and "like last <Mon>"
  planned-cost spends of $100 or more. Weekly and biweekly bills aren't. *Cost:* a large weekly bill is
  never called out.
- **P6b-R9 Saving lines are counted once.** Saving is every savings line in any timing, without its
  set-aside. Due-day savings lines, and recurring bills standing in for a savings line, are left out of
  Bills. *Cost:* none known. A recurring transfer into a savings category with no savings line stays in
  Bills.
- **P6b-R10 Paydays.** "3 paydays" counts distinct pay dates in the month. The month is flagged extra
  when any one source has more than its usual count. The rest of this month is never "extra". *Cost:* two
  sources paid on the same day count as one payday.
- **P6b-R11 The set-aside fix spreads over whole months.** The months run from next month through the
  lowest month, at least 1. *Cost:* a shortfall this month suggests the whole amount as one month's extra.
- **P6b-R12 Months to watch.** The tightest month is always named in a sentence. The list only has months
  that spend more than comes in or end under the cushion, so "No tight months ahead" can show.
- **P6b-R13 What-ifs.** A monthly cost starts next month. A one-off lands in the chosen month, which
  defaults to next month. A pay change applies to every payday. Habits over the year is the plain habits
  usual × 12, with no what-if.
- **P6b-R14 Goals.** A goal's month is this month + ⌈remaining ÷ recent average⌉. A reached goal says
  "reached".
- **P6b-R15 Twelve months of history** means the first transaction is at least 12 months before this
  month, the same rule as Planned Costs' "coming up".
- **P6b-R16 The Past/Ahead switch replaces the URL** instead of adding a history entry, as filters do.
  With no cash balance, Ahead still runs from $0 with a note.

### Fix round 1

- **P6b-R17 Other bills.** Bills-section money that no confirmed bill or due-day line covers is counted.
  - The amount is worked out per top-level Bills category: its average month over the last 12 full months
    (or the full months since history began), less its shared confirmed bills as monthly amounts and less
    this month's due-day lines in it. Each category is floored at 0, then they're added up.
  - Sub-categories linked to a planned cost are left out, and so is a category linked to one itself.
  - It goes into Bills each month (× the share of days left this month). It shows as "of it, other bills"
    in the cash tooltip and the Where it goes table.
  - *Cost:* a one-off big Bills charge last year raises every month by 1/12 of it, and a bill that ended
    still counts until it ages out of the 12 months.
- **P6b-R18 A planned cost's own bills under a set-aside come off as a monthly rate.** With under 12 months
  of history, expected spending is the set-aside less its own confirmed bills' monthly amount, floored at
  0. Each bill still comes out of the cost's balance when it falls due. This replaces subtracting the bill
  only in the month it falls, which counted it twice. *Cost:* none known.
- **P6b-R19 A due-day line filed in Everyday, Habits or Fun comes out of that group's usual.** It's counted
  as a bill, so it isn't counted again in usual. *Cost:* if the line is budgeted above what is really
  spent, the group's usual is understated.
- **P6b-R20 A bill on a parent category covers a due-day line on its sub-category.** This holds in every
  month, Until payday included. A sibling's bill doesn't. *Cost:* a parent bill and a child line that
  really are different money count once.
- **P6b-R21 A bounded D1 query count.**
  - Later months' budgets load in a fixed number of queries, whatever how many months have a budget.
  - Categories are loaded once.
  - Goals reuse the 13-month ledger when it reaches back far enough.
  - Measured: `/forecast/months` takes 29 queries and `/forecast` 22, middleware included, with 3 future
    months budgeted. The test bound is 30. Workers Free allows 50.
