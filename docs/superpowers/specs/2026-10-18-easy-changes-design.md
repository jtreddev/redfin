# Easy to change: search, one-off fixes, categories and kids

Project 5. Design calls made by Claude on the user's standing instruction not to ask for
approvals. The user's feedback after using the app (2026-10-18): "It should be simple to do
easy things and possible to do hard things. I can't just search all of my bills or search for
a month. I can't seem to categorize a single transaction without changing all transactions. I
can't add a kid or a category / sub category very easily nor can I reorder categories … as I
use this more I want it easy to change things in the live app."

## 1. Find anything

Activity gets a search-and-filter bar that does what people expect:

- **Search** matches the bank description, the merchant name, the normalized merchant, notes,
  the category name, and amounts: typing `45` or `45.12` or `$45.12` matches charges of that
  amount (either sign); `>100` / `<20` filter by size. Case-insensitive.
- **Month**: a month picker (‹ Oct 2026 ›, plus "All time"). Defaults to All time when searching,
  this month otherwise. The URL keeps it (`#/activity?month=2026-09&q=shell`).
- **Filters** as removable chips: category (picker grouped by group, sub-categories nested),
  account, kid, "Needs a look", "Private", "Left out". Several at once.
- A result summary line: "23 charges · $412.60 out · $0 in".
- **Bills**: Plan › Bills gets the same search box (name, merchant, amount) and a status filter
  (Suggested / Confirmed / Dismissed — dismissed ones become findable and restorable).
- Server: extend `GET /transactions` (`q` covers the fields above; `minCents`, `maxCents`;
  multiple `categoryId` values; a category filter includes its sub-categories); returns totals
  for the whole result set (not just the page). Privacy rules unchanged (PRIVACY_SQL).

## 2. Change one charge without changing the rest

The fix-and-learn flow (project 1) moved similar charges quietly. The user now wants a plain
one-off change to be the default.

- Picking a category on a charge changes **that charge only**.
- Under the category field, when other charges would match: a checkbox
  "**Also file 41 other Shell charges this way, and new ones**" — unchecked by default. Checking
  it (before or right after picking) runs the existing learn-and-refile with Undo.
- The count comes from a cheap preview endpoint (`GET /transactions/:id/similar?categoryId=` →
  `{ count, merchant }`) using the same matching as learning (whole words, generic-key guards,
  gas-station amount ranges, privacy scoping).
- Bulk edit for the hard case: in Activity, a "Select" mode with checkboxes; with N selected:
  set category, set kid, mark private (own charges only), leave out of budget. One request,
  one Undo.

## 3. Categories: add, rename, sub-categories, reorder, hide

A **Categories** screen (More › Categories; also reachable from "＋ New category" at the bottom
of every category picker):

- Groups (Bills, Everyday, Habits, Fun & Wants, Saving, Income, Transfers) listed in order with
  their categories.
- **Add** a category inline in any group (name; kind follows the group; Kids-style "asks which
  kid" toggle).
- **Sub-categories**: one level. A category can have sub-categories (e.g. Habits › Cigarettes,
  Habits › Snacks). Charges can be filed to a parent or a child. Everywhere totals are shown
  (budget, Trends, planned costs), a child counts toward its parent; the parent's detail lists
  children. Budget lines may be set on the parent (children roll up) or on children (then the
  parent shows their sum). Rules, learned rules and bills can target children.
- **Reorder**: drag handles on desktop; on a phone, a "Reorder" mode with ↑/↓ buttons
  (44px targets, keyboard accessible). Categories can move between groups (kind changes with
  the group; refuse moving Fun Money categories; refuse kind changes that would move
  income↔spending for categories with transactions unless confirmed).
- **Rename**, **hide** (archive; hidden categories keep history, can be shown and restored),
  **merge** into another category (moves transactions, splits, rules, budgets, bills, goals,
  planned-cost links — reuse the migration 0003 re-pointing logic as a server function; Undo is
  not offered, so confirm with the counts first).
- Order and nesting are used everywhere categories appear (pickers, Plan, Trends tables).
- Data: migration 0007 adds `categories.parent_id INTEGER REFERENCES categories(id)` (one level:
  a parent can't have a parent; a category with children can't become a child). Reorder API:
  `POST /categories/reorder { groupId, ids[] }`; move: `PATCH /categories/:id { sectionId, parentId }`;
  merge: `POST /categories/:id/merge { intoId }`.

## 4. Kids

- More › Kids gets a clear "Add a kid" (name, optional birth date, color) at the top; rename,
  reorder, hide.
- The kid picker on a charge has "＋ Add a kid" which opens the same small form and selects the
  new kid on save.

## 5. Small "change it right here" touches

- Every category name shown in Plan, Trends tables, and a charge's sheet has an edit affordance
  (rename/move/sub-category) via a small "Edit category" link that opens the Categories screen
  scrolled to it.
- Plan › Bills: edit a bill's name, amount, how often, next date, category inline (the API
  supports it); restore dismissed bills.

## 6. Simple by default, more when you want it

Follow-up from the user: "I would like to be able to turn off the getting started … what other
things might this be able to do to accommodate power use as well as simple use?"

- **Hide "Getting set up"**: a × on the Home checklist card ("Hide this") and a Settings switch
  "Show the setup checklist" — stored per person (members.hide_setup), so each partner decides.
  It also hides itself once every step is done.
- **Settings › "Show more tools"** (per person, off by default): reveals the power features below
  in menus and screens; with it off, the app stays as simple as now. Search, one-off fixes,
  categories and kids (sections 1–5) are always available — they're basics.
- Power features behind that switch, in this project:
  - **Keyboard shortcuts** on a computer: `/` search, `j`/`k` next/previous charge, `c` change
    category, `x` select, `u` undo, `?` shows the list.
  - **Saved searches**: save the current search + filters with a name; they appear as chips at
    the top of Activity (per person).
  - **Export what you see**: "Download CSV" of the current search/filter results (the existing
    CSV export code, formula-safe).
  - **Rule preview**: on the Rules screen, editing or creating a rule shows "Matches 41 charges"
    with a sample before saving, and "Apply to past charges" as an explicit choice.
- Suggested for a later project (not built here): tags across categories (e.g. "Vacation 2026"),
  receipt photos on charges, budget rollover for a category, custom date ranges and
  period-vs-period comparisons in Trends, recurring manual entries for cash.

## Testing

- Server: search fields and amount matching, multi-category + sub-category filters, totals,
  privacy; similar-count preview equals what learning would move; bulk edit (+ Undo, privacy:
  can't touch partner's private charges); categories reorder/move/merge (every category_id
  table re-pointed — reuse the coverage guard from tests/categorySet.test.ts), sub-category
  constraints and roll-ups in budget, Trends and planned costs; kids add/reorder/hide.
- Client: browser check at 390/1280, light and dark: search by amount and month, one-off fix
  vs "also file", bulk select, add/reorder/nest/merge categories, add a kid from a charge.
