import { describe, expect, it } from 'vitest';
import {
  balanceText,
  changedFields,
  comingUpText,
  monthlyText,
  spentText,
  suggestFor,
  suggestionFor,
  totalLine,
  type PlannedCost,
} from '../src/client/plannedCosts';

const cost = (over: Partial<PlannedCost> = {}): PlannedCost => ({
  id: 1,
  name: 'Car',
  startMonth: '2026-10',
  startBalanceCents: 0,
  categoryIds: [3, 7],
  monthlyCents: 6000,
  balanceCents: 34000,
  spent12Cents: 66000,
  suggestedMonthlyCents: 5500,
  comingUp: [],
  ...over,
});

describe('planned costs screen text', () => {
  it('sums up the month', () => {
    expect(totalLine(16500, 3)).toBe('$165 a month set aside for 3 costs');
    expect(totalLine(5000, 1)).toBe('$50 a month set aside for 1 cost');
  });

  it('says ready or short, never a minus sign', () => {
    expect(balanceText(34000)).toEqual({ text: '$340 ready', short: false });
    expect(balanceText(0)).toEqual({ text: '$0 ready', short: false });
    expect(balanceText(-12000)).toEqual({ text: '$120 short', short: true });
    expect(balanceText(-12050)).toEqual({ text: '$120.50 short', short: true });
  });

  it('describes the monthly amount and the last year of spending', () => {
    expect(monthlyText(6000)).toBe('$60 a month');
    expect(monthlyText(0)).toBe('Nothing set aside each month');
    expect(spentText(66000)).toBe('$660 spent in the last 12 months');
    expect(spentText(0)).toBe('Nothing spent in the last 12 months');
    expect(spentText(-2500)).toBe('Nothing spent in the last 12 months'); // refunds outweighed charges
  });

  it('describes what is coming up', () => {
    expect(comingUpText({ kind: 'bill', name: 'Amazon Prime', date: '2027-03-03', amountCents: 13900 })).toBe('Amazon Prime, about $139, due Mar 3');
    expect(comingUpText({ kind: 'usual', month: '2026-12', amountCents: 42000 })).toBe('December usually costs about $420');
  });
});

describe('the suggested monthly amount', () => {
  const categories = [
    { id: 3, spent12Cents: 40000 },
    { id: 7, spent12Cents: 20000 },
    { id: 9, spent12Cents: 0 },
  ];

  it('works out a suggestion for picked categories from their history', () => {
    expect(suggestFor([3, 7], categories, 12)).toBe(5000); // $600 / 12
    expect(suggestFor([3], categories, 5)).toBe(8000); // $400 / 5
    expect(suggestFor([9], categories, 12)).toBe(0);
    expect(suggestFor([3], categories, 2)).toBeNull(); // under 3 months
    expect(suggestFor([], categories, 12)).toBe(0);
  });

  it('uses the server suggestion while the categories are unchanged (it knows starter amounts)', () => {
    const c = cost({ categoryIds: [3], spent12Cents: 0, suggestedMonthlyCents: 5000 });
    expect(suggestionFor({ cost: c, categoryIds: [3], categories, months: 12 })).toEqual({ cents: 5000, text: 'Suggested: $50 to start' });
    const d = cost({ categoryIds: [3, 7], suggestedMonthlyCents: 5500 });
    expect(suggestionFor({ cost: d, categoryIds: [7, 3], categories, months: 12 })).toEqual({
      cents: 5500,
      text: 'Suggested: $55 from the last 12 months',
    });
  });

  it('recomputes when the categories change, and says how many months it used', () => {
    const d = cost({ categoryIds: [3, 7] });
    expect(suggestionFor({ cost: d, categoryIds: [3], categories, months: 5 })).toEqual({ cents: 8000, text: 'Suggested: $80 from the last 5 months' });
    expect(suggestionFor({ cost: null, categoryIds: [3, 7], categories, months: 12 })?.text).toBe('Suggested: $50 from the last 12 months');
  });

  it('offers nothing without enough history or without categories', () => {
    expect(suggestionFor({ cost: null, categoryIds: [3], categories, months: 2 })).toBeNull();
    expect(suggestionFor({ cost: null, categoryIds: [], categories, months: 12 })).toBeNull();
    expect(suggestionFor({ cost: cost({ suggestedMonthlyCents: null }), categoryIds: [3, 7], categories, months: 2 })).toBeNull();
  });
});

describe('saving changes', () => {
  const draft = { name: 'Car', monthlyCents: 6000 as number | null, startBalanceCents: 0 as number | null, categoryIds: [7, 3] };

  it('sends nothing when nothing changed (category order and spaces around the name do not count)', () => {
    expect(changedFields(cost(), { ...draft, name: ' Car ' })).toEqual({});
  });

  it('sends only the fields that changed', () => {
    expect(changedFields(cost(), { ...draft, monthlyCents: 5500 })).toEqual({ monthlyCents: 5500 });
    expect(changedFields(cost(), { ...draft, name: 'Cars', categoryIds: [3] })).toEqual({ name: 'Cars', categoryIds: [3] });
    expect(changedFields(cost(), { ...draft, startBalanceCents: 20000 })).toEqual({ startBalanceCents: 20000 });
  });

  it('reads an emptied starting balance as $0', () => {
    expect(changedFields(cost({ startBalanceCents: 5000 }), { ...draft, startBalanceCents: null })).toEqual({ startBalanceCents: 0 });
    expect(changedFields(cost(), { ...draft, startBalanceCents: null })).toEqual({});
  });
});
