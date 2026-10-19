# Plan › Ahead: API contract for the UI

This is what the UI task builds on. The design is in `2026-10-18-plan-ahead-design.md`, and its rulings are
P7-R1 to P7-R24. All amounts are integer cents. Months are `'YYYY-MM'`.

## Running the plan in the browser

Nothing is requested while a slider moves. The client:

1. Loads `GET /api/ahead` once.
2. Holds a working copy of `saved` (an `AheadPlan`) as the slider state.
3. On every change, calls `planAhead(body.input, plan, horizon)` from `src/shared/planAhead.ts`. It takes
   about 2 ms for 12 months, 10 debts and a 30-year tail.
4. For **Fill automatically**, calls `autoFill(body.input, horizon)`. It returns a new `AheadPlan`.
5. For the "changed vs saved" readouts, also runs `planAhead(body.input, body.saved, horizon)`. That covers the
   debt-free change, "4 months sooner · saves $310" (or use `debts[i].minimumOnly`) and the Save button's
   enabled state (deep-compare the plan with `saved`).
6. For **Save as my plan**, POSTs the plan to `/api/ahead/plan`, then reloads `GET /api/ahead`.

Everything else comes from `src/shared/planAhead.ts` and `src/shared/monthsAhead.ts`:

```ts
import { planAhead, autoFill, emptyPlan, currentMonthly, DEBT_KINDS, DEBT_STRATEGIES,
         type AheadInput, type AheadPlan, type PlanAheadResult, type DebtKind, type DebtStrategy } from '../shared/planAhead';
import { monthsToWatch, type Horizon, type AheadLine } from '../shared/monthsAhead';
```

## GET /api/ahead

Runs debt auto-link first: every credit or loan account gets a debt, which is idempotent. Then it returns:

```ts
interface AheadResponse {
  today: ISODate;
  /** Months ahead's input plus Plan › Ahead's. It has no `ahead` lines: planAhead adds them from the plan. */
  input: AheadInput;
  /** The plan as saved: where the sliders start. */
  saved: AheadPlan;
  /** savedCents null: the suggestion is in use ("(suggested)"); otherwise "(your amount)". */
  surprise: { suggestedCents: Cents; savedCents: Cents | null };
  /** Every debt that isn't archived, paid-in-full ones included (shown in their own "Paid in full" group). */
  debts: DebtRow[];
  /** As GET /api/goals returns them, plus monthlyCents (null = not set). */
  goals: (GoalRow & { savedCents: Cents; contributionsByMonth: Cents[]; progress: GoalProgress })[];
  items: AheadItem[];
  hasBalance: boolean;
  hasIncome: boolean;
}

interface AheadInput extends MonthsAheadInput {
  debts: AheadDebt[];            // engine view of `debts` (balances live from the account)
  aheadGoals: { id: number; name: string; remainingCents: Cents; targetDate: ISODate | null }[];
  items: AheadItem[];
  surpriseCents: Cents;          // saved, or the suggestion when none is saved
  surpriseSuggestedCents: Cents;
  strategy: 'avalanche' | 'snowball' | 'custom';
}

interface AheadDebt {
  id: number; name: string; kind: DebtKind;
  balanceCents: Cents; aprPercent: number; minPaymentCents: Cents; dueDay: number | null;
  endMonth: MonthKey | null; paidInFull: boolean; sort: number;
  /** A linked confirmed bill, or a due-day line in its category, counts this month's payment (P7-R11). */
  covered: boolean;
}

interface AheadPlan {
  debtExtra: Record<number, Cents>;    // by debt id, on top of the minimum
  costMonthly: Record<number, Cents>;  // by planned-cost id; the set-aside from next month
  goalMonthly: Record<number, Cents>;  // by goal id
  surpriseCents: Cents;
  strategy: 'avalanche' | 'snowball' | 'custom';
  order: number[];                     // debt ids, for 'custom' ("My order")
}

interface AheadItem {
  id: number; name: string;
  amountCents: Cents;                  // + money in, − money out
  month: MonthKey; repeat: 'once' | 'monthly' | 'yearly'; endMonth: MonthKey | null;
}

/** Also what GET /api/debts returns (auto-link runs there too). */
interface DebtRow {
  id: number; name: string; kind: DebtKind;
  accountId: number | null; accountName: string | null; source: 'manual' | 'plaid';
  balanceCents: Cents;                 // linked: the account's, read live; can't be edited by hand
  aprPercent: number;                  // 0 with a balance: "Add the interest rate" / "no interest rate yet"
  minPaymentCents: Cents; minEstimated: boolean;   // "estimated" until edited
  dueDay: number | null; extraCents: Cents; sort: number;
  paidInFull: boolean;                 // "Paid in full each month" toggle
  endMonth: MonthKey | null;           // fixed-term loans
  billId: number | null; billName: string | null; billConfirmed: boolean;
  categoryId: number | null; categoryName: string | null;
  balanceAsOf: ISODate | null;         // manual debts: "Balance as of <date>"
  suggestedBillId: number | null; suggestedBillName: string | null;  // show, never apply silently
  updatedAt: string;
}
```

Sliders exist for:
- each `input.plannedCosts` entry, with its current value `currentMonthly(cost, today)`;
- each `input.debts` entry that has `!paidInFull && balanceCents > 0`;
- each `input.aheadGoals` entry.

The slider range is 0 to max(2 × `leftOverCents`, the current value), in $5 steps.

## planAhead(input, plan, horizon = 12): PlanAheadResult

```ts
interface PlanAheadResult {
  projection: MonthsAhead;     // Project 6b's months; each month has `ahead: { inCents, outCents, lines: AheadLine[] }`
  leftOverCents: Cents;        // headline "About $X a month left over" (average whole month, before any extra)
  allocatedCents: Cents;       // debt extras + set-aside changes + goal amounts
  unallocatedCents: Cents;     // < 0: "$Y over what's left"
  debts: { id; name; extraCents; payoffMonth: MonthKey | null /* null: not paid off within 30 years */;
           interestCents; balances: Cents[] /* end of each projection month */;
           minimumOnly: { payoffMonth: MonthKey | null; interestCents: Cents }; noRate: boolean }[];
  debtTotals: Cents[];         // total debt at the end of each projection month (the balance chart)
  debtFreeMonth: MonthKey | null;  // null with hasDebts: not within 30 years
  hasDebts: boolean;
  totalInterestCents: Cents;   // "$X interest from now"
  costs: { id; name; currentMonthlyCents; monthlyCents; balances: Cents[]; endCents; runsShortMonth: MonthKey | null }[];
  goals: { id; name; monthlyCents; reachedMonth: MonthKey | null /* null: "Not reached" */ }[];
}

interface AheadLine { kind: 'debt' | 'item' | 'surprise' | 'setAside' | 'goal'; id: number | null; name: string;
                      amountCents: Cents /* + out, − in */ }
```

In each projection month:
- `outCents` = Σ `byGroup` + `addedCents` + `ahead.outCents`;
- `inCents` includes `ahead.inCents` (known items coming in).

`byGroup` doesn't include the plan's lines. A stacked chart adds `ahead` as its own series, or shows it in the
month sheet.

The month sheet:
- **Paydays:** `input.income`.
- **Bills:** `input.bills` in that month. Each has `cadence`, which is null for "Your budget" due-day lines.
- **Usual spending:** from `byGroup`.
- **Planned-cost spends:** `bigItems` and `plannedCosts`.
- **Plan lines:** `ahead.lines`, which covers debt payments, known items, surprises, set-aside changes and goals.

## POST /api/ahead/plan

The body is an `AheadPlan`. Every field is optional, and a field left out is kept.
- `surpriseCents: null` switches back to the suggestion ("Use suggestion").
- Unknown ids, negative amounts and an unknown strategy return 400.

The route writes, in one D1 batch, only what changed (P7-R19):
- `debts.extra_cents`;
- `debts.sort` from `order`;
- next month's `planned_cost_amounts`;
- `goals.monthly_cents`;
- the budget lines of later months that already exist (goal lines, and min + extra for debt-linked
  categories);
- `household.surprise_cents` and `household.debt_strategy`.

Response: `{ ok: true, changes: number }`. The confirm sheet lists the differences between the working plan and
`saved`. The client works these out.

## Known items: /api/ahead/items

| Call | Body | Reply |
| --- | --- | --- |
| `GET /api/ahead/items` | | `AheadItem[]` (by month, then id) |
| `POST /api/ahead/items` | `{ name, amountCents (≠ 0, + in / − out), month, repeat?: 'once' \| 'monthly' \| 'yearly', endMonth?: MonthKey \| null }` | `201 { id }` |
| `PATCH /api/ahead/items/:id` | any of the above | `{ ok: true }` |
| `DELETE /api/ahead/items/:id` | | `{ ok: true }`, or 404 |

An `endMonth` before `month` returns 400. A 'once' item never has an end month.

## Debts: /api/debts

- `GET /api/debts`: `DebtRow[]`. Auto-link runs first.
- `POST /api/debts`: ＋ Add a debt. Returns `201 { id }`. The body takes:
  - `name` and `balanceCents` (required);
  - `kind` (`DEBT_KINDS`, default 'other');
  - `aprPercent`, `dueDay` and `endMonth`;
  - `minPaymentCents` (left out: estimated);
  - `billId` (a bill the viewer can see), `categoryId` and `extraCents`.
  - `balanceAsOf` is set to today.
- `PATCH /api/debts/:id`: any of the above, plus `paidInFull`, `sort` and `archived`.
  - `balanceCents` on a linked debt returns 400 ("This balance comes from the account.").
  - `minPaymentCents` ends the estimate.
  - A new balance or rate re-estimates an estimated minimum.
  - `null` clears `billId`, `categoryId`, `endMonth` or `dueDay`.

## Months ahead and Until payday

- `GET /api/forecast/months` returns the same body as before. Its `input` now carries the saved plan as
  `input.ahead`, so `projectMonths(input, horizon, whatIf)` on the client includes it. (Its `input` also has the
  Ahead fields above.)
- `GET /api/forecast` events include the saved plan:
  - debt payments, named after the debt, with ids `debt-<id>-<date>`;
  - goal amounts on the 1st of later months, with ids `goal-<id>-<date>` and kind 'budget'.
