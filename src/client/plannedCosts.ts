/** Planned costs on Plan › Goals: API shapes and the screen's wording (no React, so it's testable). */
import type { ComingUpItem } from '../shared/plannedCosts';
import { suggestMonthly } from '../shared/plannedCosts';
import { money, plural, shortDate } from './format';

export interface PlannedCost {
  id: number;
  name: string;
  startMonth: string;
  startBalanceCents: number;
  categoryIds: number[];
  monthlyCents: number;
  balanceCents: number;
  spent12Cents: number;
  /** Null with under 3 months of history. */
  suggestedMonthlyCents: number | null;
  comingUp: ComingUpItem[];
}

export interface PlannedCostCategory {
  id: number;
  name: string;
  section: string;
  plannedCostId: number | null;
  spent12Cents: number;
}

export interface PlannedCostsResponse {
  month: string;
  costs: PlannedCost[];
  totalMonthlyCents: number;
  suggestionMonths: number;
  categories: PlannedCostCategory[];
}

/** Whole dollars when the amount is round, cents otherwise. */
const amount = (cents: number) => money(cents, { whole: cents % 100 === 0 });

export const totalLine = (totalMonthlyCents: number, count: number) =>
  `${amount(totalMonthlyCents)} a month set aside for ${plural(count, 'cost')}`;

export function balanceText(balanceCents: number): { text: string; short: boolean } {
  const short = balanceCents < 0;
  return { text: `${amount(Math.abs(balanceCents))} ${short ? 'short' : 'ready'}`, short };
}

export const monthlyText = (monthlyCents: number) => (monthlyCents > 0 ? `${amount(monthlyCents)} a month` : 'Nothing set aside each month');

export const spentText = (spent12Cents: number) =>
  spent12Cents > 0 ? `${amount(spent12Cents)} spent in the last 12 months` : 'Nothing spent in the last 12 months';

const monthOnly = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' });

export function comingUpText(item: ComingUpItem): string {
  if (item.kind === 'bill') return `${item.name}, about ${amount(item.amountCents)}, due ${shortDate(item.date)}`;
  return `${monthOnly.format(new Date(`${item.month}-01T12:00:00Z`))} usually costs about ${amount(item.amountCents)}`;
}

/** What history suggests for these categories (null under 3 months). */
export function suggestFor(categoryIds: readonly number[], categories: readonly { id: number; spent12Cents: number }[], months: number): number | null {
  const spent = categories.filter((c) => categoryIds.includes(c.id)).reduce((total, c) => total + c.spent12Cents, 0);
  return suggestMonthly(spent, months);
}

const sameIds = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((id) => b.includes(id));

/**
 * The suggestion to show in the sheet. While the categories are the cost's own, the server's number
 * is used (it applies the defaults' starter amounts); otherwise it's worked out from the picks.
 */
export function suggestionFor(input: {
  cost: PlannedCost | null;
  categoryIds: readonly number[];
  categories: readonly { id: number; spent12Cents: number }[];
  months: number;
}): { cents: number; text: string } | null {
  const { cost, categoryIds, categories, months } = input;
  const unchanged = cost !== null && sameIds(cost.categoryIds, categoryIds);
  if (!unchanged && categoryIds.length === 0) return null;
  const cents = unchanged ? cost.suggestedMonthlyCents : suggestFor(categoryIds, categories, months);
  if (cents === null) return null;
  const starter = unchanged && cost.spent12Cents === 0 && cents > 0;
  return {
    cents,
    text: starter ? `Suggested: ${amount(cents)} to start` : `Suggested: ${amount(cents)} from the last ${plural(months, 'month')}`,
  };
}

export interface CostDraft {
  name: string;
  monthlyCents: number | null;
  startBalanceCents: number | null;
  categoryIds: number[];
}

/** The PATCH body: only what changed. Empty means there's nothing to save. */
export function changedFields(cost: PlannedCost, draft: CostDraft): Partial<Pick<PlannedCost, 'name' | 'monthlyCents' | 'startBalanceCents' | 'categoryIds'>> {
  const body: Partial<Pick<PlannedCost, 'name' | 'monthlyCents' | 'startBalanceCents' | 'categoryIds'>> = {};
  const name = draft.name.trim();
  if (name !== cost.name) body.name = name;
  if (draft.monthlyCents !== null && draft.monthlyCents !== cost.monthlyCents) body.monthlyCents = draft.monthlyCents;
  const start = draft.startBalanceCents ?? 0;
  if (start !== cost.startBalanceCents) body.startBalanceCents = start;
  if (!sameIds(cost.categoryIds, draft.categoryIds)) body.categoryIds = [...draft.categoryIds];
  return body;
}
