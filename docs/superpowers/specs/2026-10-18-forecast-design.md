# Forecast to payday, what-ifs, bill alerts, subscriptions, hide amounts

Project 6. The user asked how to forecast "a little", what to add and what to take away. Their
answers: forecast **until the next payday only**; add **what-if sliders, a "bill went up"
alert, a subscriptions list, and hide amounts**. They didn't answer the take-away question, so
nothing visible is removed. Claude makes the remaining design calls on the user's standing
instruction not to ask for approvals. Each call is recorded as a ruling (P6-Rn).

## 1. Until payday (Home)

**Pure function.** `projectToPayday(input): Projection` lives in a new file,
`src/shared/projection.ts`. It has no I/O, so the client can re-run it for what-ifs.

Input:
- `today`
- `startBalanceCents`: today's cash. This is the sum of `current_balance_cents` over
  `is_cash` accounts, the same accounts the planner uses. A manual starting balance doesn't
  apply, because this projection starts today.
- `payday`: `{ date, amountCents, name }` or null.
- `events`: `{ date, name, amountCents (positive = money out), kind: 'bill' | 'budget' | 'oneoff' }[]`.
- `dailySpend`: `{ everyday, habits, fun }` in cents per day.
- `lowBalanceCents`.
- An optional `whatIf`, described in section 2.

The pieces are worked out as follows:
- **Next payday.** It is the earliest expected pay date after today across active
  `income_sources` (`payDatesBetween` in paySchedule.ts). Dates that already have a matched
  deposit are skipped. The amount is `net_pay_cents`, and paydays on the same date add up.
  - If there's no payday within 45 days, the horizon is the end of next month, with the note
    "No payday set up — showing to the end of the month" (P6-R1). Use the current month's
    end when that is at least 7 days away.
- **Horizon.** It runs from tomorrow to the day before payday, inclusive. The last point is
  "the day before payday".
- **Events.** Use the existing `upcomingBills` (planner.ts). It covers due-day budget lines
  with money still left, plus confirmed recurring bills with stale dates rolled forward and
  categories that have a due-day line skipped. Its horizon is set to the payday.
  - Bills that are overdue or due today land on tomorrow (P6-R2).
  - A payday that falls in next month still needs next month's due-day lines. For the window
    after the month ends, use only recurring bills, because next month's budget may not exist
    (P6-R3).
- **Daily spend.** Use the Trends "usual" (`usualOf` in trends.ts, the last 3 full months)
  for the everyday, habits and fun groups, each divided by 30.4. Bills and Saving are left
  out, because events cover them (P6-R4).
  - Fun Money totals count as group totals only, under the same privacy rules as Trends. No
    partner's private charge is ever listed.
  - Usual is 0 when there's no history.
- **Planned-cost set-asides are not subtracted** (P6-R5). They are tracked balances, and the
  money doesn't leave the account. *Cost if wrong:* the result looks rosier by the
  set-asides. The Home copy says "before set-asides" when any planned cost exists.

Output:
- `points: { date, balanceCents }[]`, one per day.
- `payday`.
- `dayBeforeCents`.
- `lowest: { date, balanceCents }`.
- `freeCents`: `max(0, lowest.balanceCents − lowBalanceCents)`. This is "free to spend until
  payday", and it is based on the lowest point, not the last one.
- `events` within the window.
- `spendTotalCents`: the daily spend multiplied by the days.
- `note`.

**Route.** `GET /api/forecast` returns the projection plus the raw inputs (`startBalanceCents`,
`payday`, `events`, `dailySpend`, `lowBalanceCents`), so the client can re-run
`projectToPayday` with a what-if.
- Privacy follows the existing model: private bills come only from the viewer's own bills
  (R17), and money comes only from cash accounts.
- CPU must stay well under 10 ms. Add a test with 3,000 transactions.

**Home.** Add an "Until payday" section under the hero / month ribbon.
- Headline: "Payday Fri, Oct 24". Below it: "About $1,180 the day before · lowest $412 on
  Oct 21", and "$X free to spend until then" when a low-balance cushion is set.
- A small hand-written SVG line of daily balance, following the dataviz rules:
  - a single series, so no legend;
  - a dashed reference line at the low-balance cushion, labeled;
  - a marker at the lowest point;
  - a tooltip per day on hover, tap and keyboard;
  - a "Table" toggle.
  - It must fit 360px.
- Below the chart: "Coming out before payday", listing events with date and amount (top 6,
  then "and N more").
- The existing safe-to-spend hero number stays as is.

## 2. What-if (behind "Show more tools")

A "What if…" disclosure sits under the forecast. It only shows when the viewer's
`power_tools` is on. Its controls:
- Habits: segmented control for usual / −25% / −50% / none.
- Everyday: segmented control for usual / −10% / −20%.
- Add a cost: an amount, plus a segmented control for once (tomorrow) / every month.
- Skip a bill: checkboxes on the listed bill events.

The client re-runs `projectToPayday` with `whatIf` and shows:
- the new day-before-payday balance and how it differs from the original ("+$84");
- for recurring changes (habits, everyday, monthly cost), "about $X a year", which is the
  daily or monthly change annualised.

Nothing is saved, and Reset clears the controls.

## 3. Bill went up

**When to flag.** A confirmed bill is flagged when the latest charge matching it is more than
`expected_amount_cents` by at least $5 and at least 10%. Matching uses the same matching as
bill detection, `sameBill`, with the latest charge in the last 45 days. Dismissed alerts are
excluded with `charge > increase_seen_cents`, or when `increase_seen_cents` is null.

**Data.** Migration `0010_forecast.sql`:
- `ALTER TABLE recurring_bills ADD COLUMN increase_seen_cents INTEGER;`
- `ALTER TABLE members ADD COLUMN hide_amounts INTEGER NOT NULL DEFAULT 0;`

**API.**
- `GET /home` gains `billIncreases: { billId, name, usualCents, latestCents, date }[]`.
- `POST /bills/:id/increase` with `{ action: 'update' | 'dismiss' }`.
  - `update` sets `expected_amount_cents` to the latest charge.
  - `dismiss` sets `increase_seen_cents` to the latest charge, so a later, bigger increase
    flags again.
- Privacy: the bills a viewer can see (R17).

**UI.**
- Home shows one row per flagged bill: "Internet was $15 more than usual ($75 vs $60)", with
  "Use $75 from now on" and "Dismiss" buttons.
- Plan › Bills shows a small "Went up" badge on the bill, with the same actions in its edit
  sheet.

## 4. Subscriptions

Plan › Bills gets a "Subscriptions" filter chip next to the status filters.
- **What counts.** Confirmed bills with a monthly or yearly cadence, $50 or less a month (a yearly charge counts as a twelfth),
  and a category outside the core household bills. The excluded categories are housing (rent
  or mortgage), utilities, phone, internet, insurance, loans and childcare, matched by
  categorySet names or ids (P6-R6).
- **Each row** shows the name, "$X a month · $Y a year" (yearly bills show the yearly amount
  and its monthly equivalent) and when it was last charged.
- **Header:** "N subscriptions · $Z a year".

## 5. Hide amounts

This is a per-person switch, stored in `members.hide_amounts`.
- **Where to toggle it:** Settings › "Hide amounts", and an eye button in the page header on
  the phone and in the side menu on desktop. The button's label is "Hide amounts" or "Show
  amounts".
- **When on,** a `hide-amounts` class on the app root blurs every element rendered by the
  shared `Money` component (ui.tsx), plus chart value labels, axis numbers and tooltips.
  - Use `filter: blur(6px)` together with `user-select: none`.
  - Screen readers get "hidden amount".
  - Tapping or clicking a blurred amount reveals it for 5 seconds.
  - Inputs are not blurred, so you can still type.
- Any place that prints money without `Money` must be covered too. Grep for formatter calls
  (`formatCents`/`money(`) in rendered text and route them through `Money`, or add the class.

## 6. Internal: one "coming up"

The forecast and Home both use `upcomingBills`. Check-in's upcoming list (planning.ts around
line 724) switches to it too if it can do so without behaviour changes visible in its tests.
Otherwise it stays as it is (P6-R7).

## Testing

- **Projection unit tests:**
  - a payday next month that crosses the month end;
  - no income sources, falling back with the note;
  - a bill on the day before payday (counted) and on payday (not counted);
  - an overdue bill landing on tomorrow;
  - the lowest point and free-to-spend amount;
  - the what-if adjustments and the annualised difference;
  - zero history.
- **API tests:**
  - `/api/forecast` with two partners, where a private bill is visible only to its owner;
  - bill-increase flag and threshold edges ($4.99, 9.9%);
  - dismiss, then a bigger increase flagging again;
  - update;
  - the subscriptions filter;
  - `hide_amounts` round trip via the existing member prefs route.
- **Checks:** the full suite, typecheck and build all pass.
- **Browser check** at 390px and 1280px, in light and dark mode:
  - the Home forecast, tooltip and table;
  - what-if;
  - the bill alert;
  - subscriptions;
  - hide amounts on Home, Activity, Trends and Plan.
