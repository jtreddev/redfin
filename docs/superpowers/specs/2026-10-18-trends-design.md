# Trends: what the month costs, over time

Project 2 of 4 (1: automatic categorizing, shipped; 3: planned costs; 4: redesign).
Decisions were made by Claude on the user's standing instruction not to ask for approvals;
the user's answers it builds on: charts live in a new **Trends tab**; Home keeps only a small
this-month summary; Habits get **totals and trend only** (no limits, no nudges).

## Goal

Answer, at a glance and over 12 months:

1. What do our **bills / must-pay** costs add up to each month?
2. What does **everyday living** (groceries, gas, car upkeep, household, medical, kids) cost?
3. How much goes to **habits** (cigarettes, snacks, coffee & fast food), and what is that a year?
4. What changed this month compared with usual?

## Where it lives

- Tab bar becomes **Home · Activity · Trends · Plan · More**. Goals moves into Plan as a third
  view next to Budget and Bills (`#/plan?view=goals`); the old `#/goals` route redirects there.
- Home gets a compact "This month so far" card: Bills, Everyday, Habits spent so far, each with
  its usual monthly amount (average of the last 3 full months) in small text, tapping through
  to Trends.

## Data

`GET /api/trends?months=12` (default 12, allowed 3–24). Computed in the Worker from
`loadLedger` + `ledgerEntries` + `flowCents` (the same counting rules as budgets: ignored,
transfers and uncategorized transfer halves don't count). Response:

```ts
{
  months: MonthKey[];                       // oldest → newest; the last is the current month
  partialMonth: MonthKey;                   // the current month (incomplete)
  groups: { key: 'bills'|'everyday'|'habits'|'fun'|'saving'; name: string;
            byMonth: Cents[] }[];           // outflow per group per month (positive = money out)
  incomeByMonth: Cents[];
  uncategorizedByMonth: Cents[];            // money out with no category ("Needs a look")
  categories: { id: number; name: string; group: string; byMonth: Cents[] }[]; // only those with any activity
  usual: Record<groupKey, Cents>;           // average of the last 3 full months
}
```

Group membership comes from the category's section (Bills, Everyday, Habits, Fun & Wants,
Saving). Categories in Income/Transfers are not in `groups`. Debt-kind categories (Loans)
count as money out in Bills. Savings-kind count in Saving.

Privacy: the existing model holds. A partner's private charges only ever sit in that
partner's Fun Money category; Trends shows each Fun Money category's monthly total (the app
already shows a partner's remaining fun money) but never lists a partner's private
transactions. Category drill-down for a partner's Fun Money is not offered.

CPU: one query for the range plus one for splits; ≤ 2,500 rows for 12 months here. Must stay
well under the free plan's 10 ms CPU per request; measure in the test with 3,000 rows.

## The Trends screen

Top to bottom (phone first, one column; two columns on wide screens):

1. **Stat tiles** (not charts): Bills / Everyday / Habits — this month so far, "usually $X a
   month". The Habits tile adds "about $Y a year" (usual × 12).
2. **Monthly spending by group** — stacked bars, one bar per month, segments Bills, Everyday,
   Habits, Fun & Wants, Saving in that fixed order and fixed colors. The current month bar is
   drawn with a lighter fill and labeled "so far". Legend always present; direct labels on the
   latest full month's segments. Hover/tap a bar → tooltip with each group's amount and the
   month total. Tapping a segment opens Activity filtered to that month and group.
3. **One category over time** — a picker (default Habits; options: every category with
   activity, grouped by group) and a 12-month bar chart for it, with the usual (3-month
   average) as a thin reference line. Tooltip per bar.
4. **What changed this month** — a list (not a chart): categories whose month-so-far, scaled
   to the full month by days elapsed, differs most from their usual (top 5 up, top 3 down),
   ignoring changes under $20. Each row: name, this month so far, usual, arrow + difference.
   Before day 7 of a month, compare the last full month instead and say so.
5. **Table view** toggle on each chart (accessibility): the same numbers as a table.

Empty states: under 2 months of data → "Trends fill in as history builds up" plus whatever
months exist.

## Charts: how they're built

- Hand-written SVG React components in `src/client/charts/` (`StackedBars`, `Bars`,
  `Tooltip`), no chart library (keeps the bundle small).
- Follow the dataviz skill's method and reference palette
  (`/tmp/claude-1000/bundled-skills/2.1.302/5273b5e122a815463cd32f0cea26ee4f/dataviz/references/`):
  categorical slots 1–5 in order for Bills, Everyday, Habits, Fun & Wants, Saving (blue,
  orange, aqua, yellow, magenta) with light and dark values as CSS custom properties; validate
  with `scripts/validate_palette.js` for both modes. Thin marks, 4px rounded tops anchored to
  the baseline, 2px surface gap between stacked segments, recessive axes and grid, text in text
  colors never series colors, a legend for multi-series, at most one y-axis, y-axis in whole
  dollars with "k" above $1,000.
- Interaction: tooltip on hover and tap; hit targets at least 44px wide on phones; keyboard
  focusable bars (arrow keys move between months) with the tooltip shown on focus.
- Fit 360px phones without horizontal scroll (months may show as single letters "J F M …" on
  narrow widths, full "Jan" when there's room).

## Also in this project (parked from project 1)

- `applyRemoved` (sync.ts): when Plaid removes a transaction that is half of a transfer pair,
  clear the partner's `transfer_pair_id` and re-derive it.
- Hand-linking a personal-card charge as a transfer must keep it private when it was private.
- `applyModified` keeps the stored bank categories when Plaid sends null (COALESCE).
- The fix-time re-file prefilter must also find punctuated merchants (e.g. "CHICK-FIL-A").

## Testing

- `trends` unit tests on the pure aggregation (`src/shared/trends.ts`): groups, uncategorized,
  transfers excluded, splits, partial month, usual = last 3 full months, "what changed"
  scaling and the day-7 rule, privacy (partner's private charges only in their Fun Money).
- API test for `/api/trends` with two partners.
- Each parked fix gets a test.
- Browser check at 390px and 1280px, light and dark: tiles, stacked bars, tooltip on tap,
  category picker, table view, Home card, Goals reachable from Plan; no console errors; no
  horizontal scroll.
