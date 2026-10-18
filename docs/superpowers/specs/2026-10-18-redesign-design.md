# Redesign: calm and clear, on a phone and a computer

Project 4 of 4. Design calls made by Claude on the user's standing instruction not to ask for
approvals, using the frontend-design skill. The user's direction: **calm and clear** — white
space, soft colors, big readable numbers, one accent color; **bottom tabs on a phone, a side
menu on a computer**; can be **added to the phone's home screen** like an app.

## Subject, audience, job

A two-person household's money app, opened on a phone several times a week, often for ten
seconds: "can we spend this?", "did the bills go out?", "what's this charge?". On a computer
it's used for the monthly check-in and the plan. Its job is to make money feel *handled*:
quiet, legible, nothing shouting unless something needs attention.

## What's wrong today

- A warm cream page (#f6f5f1) with green — close to the generic generated look.
- Every block is a shadowed rounded card; hierarchy comes from boxes, not type and space.
- Unicode glyphs as tab icons (⌂ ☰ ▦); system font; numbers at body size in most places.
- On a computer it's a stretched phone: bottom tab bar, one narrow column.

## Design plan

### Color (light)
| Token | Hex | Role |
|---|---|---|
| paper | `#fbfcfd` | page — a cool, clean white (not cream) |
| surface | `#ffffff` | sheets, inputs, raised rows |
| ink | `#1b2430` | text, big numbers |
| slate | `#5c6877` | secondary text, axis labels |
| hairline | `#e4e8ee` | dividers, input borders |
| accent | `#3f4aa6` | the single accent: active tab, primary button, links, focus ring |
| accent-soft | `#eceefa` | selected rows, accent backgrounds |

Dark mode is its own palette (not an inversion): paper `#111419`, surface `#181c22`, ink
`#e8ebf0`, slate `#9aa4b1`, hairline `#262c35`, accent `#8f98ec`, accent-soft `#23284a`.
Status colors keep their meaning (good / warning / bad) and always come with a word or icon.
The accent was chosen to sit apart from the chart series colors (blue, orange, aqua, yellow,
magenta) so charts never look "selected".

### Type
- **Public Sans** (OFL, the U.S. government's plain-spoken typeface) for everything, self-hosted
  as one variable woff2 in `public/fonts/` (the CSP allows only same-origin fonts; offline
  works). Fallback: system-ui.
- Numbers: `font-variant-numeric: tabular-nums` everywhere money appears; big amounts at weight
  650, letter-spacing −0.01em.
- Scale (1.25): 13 · 15 · 17 (body) · 21 · 27 · 34 · 44 (hero number). Sentence case; no
  all-caps labels; labels sit beside or below numbers, not as eyebrows above everything.
- Line length ≤ 72ch on text-heavy screens (Settings, Import help).

### Layout
Phone (< 900px): one column, 16px gutters, bottom tab bar (64px + safe-area) with SVG icons and
labels; sheets slide up from the bottom.

```
┌─────────────────────────┐
│ Hi, Sam        Sync now │
│                         │
│  $412                   │  ← the hero number: safe to spend this week
│  safe to spend this week│
│  ▇▇▇▇▇▇▇▇▇▅▅▅▅▃▃▂       │  ← the month ribbon (signature)
│  Bills · Everyday · ... │
│ ─────────────────────── │
│ Needs a look        (2) │
│ Coming up               │
│ ...                     │
├─────────────────────────┤
│ ⌂  ≡  ⌁  ▦  ⋯           │  tab bar
└─────────────────────────┘
```

Computer (≥ 900px): a 232px left side menu (app name, the five destinations, then the More
items listed directly: Accounts, Income, Rules, Kids, Fun money, Check-in, Import, Export,
Settings), content column max 760px left-aligned beside it; Trends and Plan may use up to
1120px with two columns. Sheets become centered dialogs (max 560px).

### The one memorable thing: the month ribbon
On Home, under the safe-to-spend number: a single full-width bar showing this month's spending
so far split by group (Bills, Everyday, Habits, Fun & Wants, Saving) in the Trends colors, with
the month's usual total as a faint end mark. One glance says "where the money has gone and how
that compares with a normal month". Tapping it opens Trends. Everything else on the page stays
quiet: no shadows, hairline dividers, generous space.

### Principles
- Structure from space and type, not boxes. Cards only where a group is genuinely separate
  (e.g. a bank connection); lists are rows divided by hairlines.
- One accent, used only for "you can act here" and "you are here".
- Big numbers for the few things that matter on each screen; everything else at body size.
- Motion only in answer to an action (sheet opening, toast, undo); respect reduced motion.
- Copy: plain verbs, sentence case, specific; errors say what happened and what to do.

## Scope

- New tokens and base styles in `src/client/styles.css` (rewrite in place; keep class names the
  components use, or update the components), self-hosted Public Sans, SVG icon set
  (`src/client/icons.tsx`: home, activity, trends, plan, more, plus the More items).
- Navigation: bottom tabs on phone; side menu on computer (same `TABS`, plus More items).
- Home: hero number + month ribbon + the existing cards restyled as quiet sections.
- Every screen restyled through shared components (`ui.tsx`: PageHeader, Card, Button, Field,
  Sheet, Segmented, Toggle, Money, Progress, Empty, ErrorNote, Loading) — screens change only
  where layout needs it.
- PWA: update `manifest.webmanifest` colors (background `#fbfcfd`, theme `#3f4aa6`), new icons
  (a simple mark in the accent on paper) at 180/192/512 + maskable, `theme-color` meta for
  light and dark, bump the service worker cache name. iOS: `apple-mobile-web-app-status-bar-style`
  `default`.
- Charts (project 2) pick up the new tokens for axes/text/surfaces; series colors unchanged.

## Quality floor

- 360px wide without horizontal scroll; tap targets ≥ 44px; visible keyboard focus (2px accent
  ring, 2px offset); `prefers-reduced-motion` honored; text contrast ≥ 4.5:1 (check ink/slate
  on paper and surface in both modes); dark mode on every screen.
- Browser check of every screen at 390px and 1280px, light and dark, with screenshots reviewed;
  no console errors.

## Appendix: tokens as built, with measured contrast

Tokens the plan left open, chosen while building (WCAG 2 contrast ratios, computed from the hex values):

| Token | Light | Dark | Role |
|---|---|---|---|
| tint | `#f1f3f6` | `#20252d` | tracks, chips, pressed rows |
| control | `#848e9c` | `#6b7480` | input, switch and secondary-button edges; chart axis |
| accent-ink | `#ffffff` | `#111419` | text on the accent (white on `#8f98ec` would be 2.6:1) |
| good / warn / bad | `#1d7447` / `#935700` / `#b3352b` | `#6cc795` / `#e0b25a` / `#f08a78` | status text, always with a word |
| good- / warn- / bad-soft | `#e5f3eb` / `#fbf0dc` / `#fbe8e4` | `#16301f` / `#33290f` / `#3a1d1a` | banners and chips |

Text (needs 4.5:1), light / dark:

| Pair | Light | Dark |
|---|---|---|
| ink on paper / surface / tint | 15.24 / 15.65 / 14.08 | 15.44 / 14.31 / 12.88 |
| slate on paper / surface / tint | 5.52 / 5.67 / 5.10 | 7.31 / 6.77 / 6.10 |
| accent on paper / surface / tint | 7.46 / 7.66 / 6.89 | 6.92 / 6.41 / 5.77 |
| accent on accent-soft (active tab, chips) | 6.63 | 5.34 |
| slate on accent-soft | 4.91 | 5.64 |
| accent-ink on accent (primary button) | 7.66 | 6.92 |
| good / warn / bad on paper | 5.61 / 5.67 / 5.91 | 9.00 / 9.39 / 7.57 |
| good / warn / bad on their soft | 5.04 / 5.16 / 5.13 | 6.94 / 7.29 / 6.28 |
| slate on warn- / bad- / good-soft | 5.02 / 4.80 / 4.96 | 5.68 / 6.07 / 5.63 |
| paper on ink (toast) | 15.24 | 15.44 |
| surface on bad (error toast) | 6.07 | 7.01 |

Non-text (needs 3:1): control on paper / surface 3.23 / 3.32 light, 3.90 / 3.61 dark. Hairlines
(`#e4e8ee`, `#262c35`) only divide content; they never mark a control's edge.

The current month's chart bars are hatched with page-colored stripes rather than faded, so their
color keeps the series' own contrast.
