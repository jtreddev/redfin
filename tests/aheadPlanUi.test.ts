import { describe, expect, it } from 'vitest';
import {
  allocationText,
  costReadout,
  debtFlags,
  debtFreeText,
  debtReadout,
  fillPlan,
  goalReadout,
  headlineText,
  isChanged,
  itemRepeatText,
  monthSheet,
  planChanges,
  rebase,
  saveBody,
  sliderMax,
  startWorking,
  suggestBill,
  type AheadResponse,
  type Working,
} from '../src/client/aheadPlan';
import type { MonthsAheadInput, PlannedCostInput } from '../src/shared/monthsAhead';
import { planAhead, type AheadDebt, type AheadInput, type AheadPlan, type DebtAhead } from '../src/shared/planAhead';

const TODAY = '2026-10-18';
const ZERO = { bills: 0, everyday: 0, habits: 0, fun: 0, saving: 0 };

function input(overrides: Partial<AheadInput> = {}): AheadInput {
  const months: MonthsAheadInput = {
    today: TODAY,
    startBalanceCents: 200_000,
    lowBalanceCents: 50_000,
    income: [],
    bills: [],
    usual: { ...ZERO },
    billsInUsual: [],
    saving: {},
    plannedCosts: [],
    historyStart: '2025-06',
    goals: [],
    otherBillsCents: 0,
  };
  return { ...months, debts: [], aheadGoals: [], items: [], surpriseCents: 15_000, surpriseSuggestedCents: 15_000, strategy: 'avalanche', ...overrides };
}

function debt(overrides: Partial<AheadDebt> = {}): AheadDebt {
  return {
    id: 1,
    name: 'Visa',
    kind: 'credit_card',
    balanceCents: 300_000,
    aprPercent: 24,
    minPaymentCents: 9_000,
    dueDay: 25,
    endMonth: null,
    paidInFull: false,
    sort: 0,
    covered: false,
    ...overrides,
  };
}

function cost(overrides: Partial<PlannedCostInput> = {}): PlannedCostInput {
  return {
    id: 7,
    name: 'Car',
    group: 'everyday',
    balanceNowCents: 20_000,
    startMonth: '2026-01',
    amounts: [{ month: '2026-01', monthlyCents: 6_000 }],
    spendByMonth: { '2025-11': 90_000 },
    usualCents: 0,
    ownBillsMonthlyCents: 0,
    ...overrides,
  };
}

const base = input({
  debts: [debt(), debt({ id: 2, name: 'Car loan', kind: 'car', balanceCents: 900_000, aprPercent: 6, minPaymentCents: 30_000, sort: 1 })],
  plannedCosts: [cost()],
  aheadGoals: [{ id: 5, name: 'Emergency fund', remainingCents: 400_000, targetDate: null }],
});

const savedPlan: AheadPlan = {
  debtExtra: { 1: 0, 2: 0 },
  costMonthly: { 7: 6_000 },
  goalMonthly: { 5: 0 },
  surpriseCents: 15_000,
  strategy: 'avalanche',
  order: [1, 2],
};

const data = (over: Partial<AheadResponse> = {}): Pick<AheadResponse, 'input' | 'saved' | 'surprise'> => ({
  input: base,
  saved: savedPlan,
  surprise: { suggestedCents: 15_000, savedCents: null },
  ...over,
});

const move = (w: Working, change: Partial<AheadPlan>, ownSurprise = w.ownSurprise): Working => ({ plan: { ...w.plan, ...change }, ownSurprise });

describe('the working plan', () => {
  it('starts from the saved plan, filled in for anything missing', () => {
    const w = startWorking(data({ saved: { ...savedPlan, debtExtra: {}, costMonthly: {}, goalMonthly: {}, order: [] } }));
    expect(w.plan.debtExtra).toEqual({ 1: 0, 2: 0 });
    expect(w.plan.costMonthly).toEqual({ 7: 6_000 });
    expect(w.plan.goalMonthly).toEqual({ 5: 0 });
    expect(w.plan.order).toEqual([1, 2]);
    expect(w.ownSurprise).toBe(false);
    expect(isChanged(base, data(), w)).toBe(false);
  });

  it('a missing key in the saved plan is not a change', () => {
    const d = data({ saved: { ...savedPlan, goalMonthly: {} } });
    expect(isChanged(base, d, startWorking(data()))).toBe(false);
    expect(saveBody(base, d, startWorking(data()))).toEqual({});
  });

  it('keeps unsaved moves across a reload, fills new debts from the saved plan and drops removed ones', () => {
    const w = move(startWorking(data()), { debtExtra: { 1: 5_000, 2: 0 } });
    const next = input({ ...base, debts: [base.debts[0]!, debt({ id: 3, name: 'Doctor', kind: 'medical', sort: 2 })] });
    const r = rebase(w, { input: next, saved: { ...savedPlan, debtExtra: { 1: 0, 3: 2_500 }, order: [1, 3] }, surprise: { suggestedCents: 20_000, savedCents: null } });
    expect(r.plan.debtExtra).toEqual({ 1: 5_000, 3: 2_500 });
    expect(r.plan.order).toEqual([1, 3]);
    // The suggestion moved, and it's still the suggestion.
    expect(r.plan.surpriseCents).toBe(20_000);
  });

  it('keeps your own cushion across a reload', () => {
    const w = move(startWorking(data()), { surpriseCents: 30_000 }, true);
    expect(rebase(w, data({ surprise: { suggestedCents: 20_000, savedCents: null } })).plan.surpriseCents).toBe(30_000);
  });

  it('fillPlan puts the saved order first, then any debt left out by sort', () => {
    expect(fillPlan({ ...savedPlan, order: [2] }, base).order).toEqual([2, 1]);
  });
});

describe('Save as my plan', () => {
  it('sends only what changed, and lists it in words', () => {
    const w = move(startWorking(data()), { debtExtra: { 1: 15_000, 2: 0 }, costMonthly: { 7: 8_500 }, goalMonthly: { 5: 20_000 } });
    expect(saveBody(base, data(), w)).toEqual({ debtExtra: { 1: 15_000 }, costMonthly: { 7: 8_500 }, goalMonthly: { 5: 20_000 } });
    expect(planChanges(base, data(), w).map((c) => c.text)).toEqual([
      'Visa: $150 extra a month (was $0)',
      'Car set-aside: $85 a month from Nov 2026 (was $60)',
      'Emergency fund: $200 a month (was $0)',
    ]);
  });

  it('a cushion typed in is yours; Use suggestion sends null', () => {
    const own = move(startWorking(data()), { surpriseCents: 20_000 }, true);
    expect(saveBody(base, data(), own)).toEqual({ surpriseCents: 20_000 });
    expect(planChanges(base, data(), own)[0]!.text).toBe('Surprises: $200 a month (was $150, suggested)');
    // Typing the suggestion's own amount still makes it yours.
    expect(saveBody(base, data(), move(startWorking(data()), {}, true))).toEqual({ surpriseCents: 15_000 });

    const saved = data({ surprise: { suggestedCents: 15_000, savedCents: 25_000 }, saved: { ...savedPlan, surpriseCents: 25_000 } });
    const back = move(startWorking(saved), { surpriseCents: 15_000 }, false);
    expect(saveBody(base, saved, back)).toEqual({ surpriseCents: null });
    expect(planChanges(base, saved, back)[0]!.text).toBe('Surprises: back to the suggestion, $150 a month');
  });

  it('sends the order only under My order, and only when it moved', () => {
    const w = startWorking(data());
    expect(saveBody(base, data(), move(w, { order: [2, 1] }))).toEqual({});
    expect(saveBody(base, data(), move(w, { strategy: 'snowball' }))).toEqual({ strategy: 'snowball' });
    const custom = move(w, { strategy: 'custom', order: [2, 1] });
    expect(saveBody(base, data(), custom)).toEqual({ strategy: 'custom', order: [2, 1] });
    expect(planChanges(base, data(), custom).map((c) => c.text)).toEqual(['Debt order: my order (was highest interest first)', 'My order: Car loan, Visa']);
  });
});

describe('readouts', () => {
  const d = (over: Partial<DebtAhead>): DebtAhead => ({
    id: 1,
    name: 'Visa',
    extraCents: 0,
    payoffMonth: '2028-03',
    interestCents: 124_000,
    balances: [],
    minimumOnly: { payoffMonth: '2028-03', interestCents: 124_000 },
    noRate: false,
    ...over,
  });

  it('says when a debt is paid off and what an extra changes', () => {
    expect(debtReadout(d({}))).toEqual({ text: 'Paid off Mar 2028 · $1,240 interest', change: null });
    expect(debtReadout(d({ extraCents: 5_000, payoffMonth: '2027-11', interestCents: 93_000 }))).toEqual({
      text: 'Paid off Nov 2027 · $930 interest',
      change: '4 months sooner · saves $310',
    });
    expect(debtReadout(d({ payoffMonth: null })).text).toBe('Not paid off at this rate');
    expect(debtReadout(d({ noRate: true, interestCents: 0 })).text).toBe('Paid off Mar 2028 · no interest rate yet');
    expect(debtReadout(d({ extraCents: 5_000, payoffMonth: '2027-01', minimumOnly: { payoffMonth: null, interestCents: 900_000 }, interestCents: 20_000 })).change).toBe(
      'Paid off, where the minimum alone never does · saves $8,800',
    );
  });

  it('set-asides, goals, the headline and the allocation bar', () => {
    expect(costReadout({ endCents: 42_000, runsShortMonth: null }, '2027-10')).toEqual({ text: '$420 by the end of Oct 2027', short: false });
    expect(costReadout({ endCents: -1, runsShortMonth: '2027-03' }, '2027-10')).toEqual({ text: 'Runs short in Mar 2027', short: true });
    expect(goalReadout({ reachedMonth: '2027-06' }, TODAY)).toBe('Reached Jun 2027');
    expect(goalReadout({ reachedMonth: null }, TODAY)).toBe('Not reached');
    expect(headlineText(45_000)).toBe('About $450 a month left over after bills, everyday spending, minimums and set-asides.');
    expect(headlineText(-2_000)).toMatch(/^About \$20 a month short/);
    expect(allocationText({ allocatedCents: 30_000, unallocatedCents: 15_000 })).toEqual({ text: '$300 given a job, $150 not yet', over: false });
    expect(allocationText({ allocatedCents: 60_000, unallocatedCents: -15_000 })).toEqual({ text: '$150 over what’s left', over: true });
  });

  it('the debt-free date against the saved plan', () => {
    const saved = { debtFreeMonth: '2029-01', totalInterestCents: 300_000 };
    expect(debtFreeText({ hasDebts: true, debtFreeMonth: '2029-01', totalInterestCents: 300_000 }, saved, TODAY)).toEqual({
      title: 'Debt-free by Jan 2029',
      interest: '$3,000 interest from now',
      change: null,
    });
    expect(debtFreeText({ hasDebts: true, debtFreeMonth: '2028-09', totalInterestCents: 250_000 }, saved, TODAY).change).toBe(
      'Against your saved plan: 4 months sooner, $500 less interest',
    );
    expect(debtFreeText({ hasDebts: false, debtFreeMonth: null, totalInterestCents: 0 }, saved, TODAY).title).toBe('No debts to pay down');
  });

  it('slider range: 2 × the left-over, the current value, or $500 at least, in $5 steps', () => {
    expect(sliderMax(45_000, 0)).toBe(90_000);
    expect(sliderMax(10_000, 60_000)).toBe(60_000);
    expect(sliderMax(-5_000, 0)).toBe(50_000);
    expect(sliderMax(45_001, 0)).toBe(90_500);
  });

  it('known items say how often', () => {
    expect(itemRepeatText({ repeat: 'once', month: '2027-03', endMonth: null })).toBe('Mar 2027');
    expect(itemRepeatText({ repeat: 'monthly', month: '2026-11', endMonth: '2027-02' })).toBe('Every month from Nov 2026 to Feb 2027');
    expect(itemRepeatText({ repeat: 'yearly', month: '2027-04', endMonth: null })).toBe('Every year from Apr 2027');
  });

  it('suggests a confirmed bill by name or merchant', () => {
    const bills = [
      { id: 1, name: 'Netflix', merchant: 'netflix' },
      { id: 2, name: 'Honda Financial', merchant: 'honda' },
    ];
    expect(suggestBill('Honda car loan', bills)?.id).toBe(2);
    expect(suggestBill('Honda Financial Services', bills)?.id).toBe(2);
    expect(suggestBill('Doctor', bills)).toBeNull();
    expect(suggestBill('ho', bills)).toBeNull();
  });
});

describe('the month sheet', () => {
  const full = input({
    ...base,
    income: [{ name: 'Paycheck', netPayCents: 300_000, schedule: { frequency: 'monthly', anchorDate: '2026-09-25' } }],
    bills: [
      { name: 'Rent', date: '2026-11-01', amountCents: 150_000, cadence: 'monthly', plannedCostId: null, group: 'bills' },
      { name: 'Savings', date: '2026-11-03', amountCents: 20_000, cadence: null, plannedCostId: null, group: 'saving' },
      { name: 'Car insurance', date: '2026-11-10', amountCents: 60_000, cadence: 'yearly', plannedCostId: 7, group: 'everyday' },
      { name: 'Late water', date: '2026-10-02', amountCents: 4_000, cadence: 'quarterly', plannedCostId: null, group: 'bills' },
    ],
    usual: { ...ZERO, everyday: 80_000, habits: 15_000, fun: 10_000 },
    saving: { '2026-11': 5_000 },
    otherBillsCents: 12_000,
    items: [
      { id: 9, name: 'Tax refund', amountCents: 90_000, month: '2026-11', repeat: 'once', endMonth: null },
      { id: 10, name: 'Birthday party', amountCents: -25_000, month: '2026-11', repeat: 'once', endMonth: null },
    ],
  });
  const plan: AheadPlan = { ...savedPlan, debtExtra: { 1: 10_000, 2: 0 }, goalMonthly: { 5: 15_000 }, costMonthly: { 7: 7_000 } };
  const result = planAhead(full, plan, 3);

  it('adds up to the month’s money in and out, each month', () => {
    result.projection.months.forEach((m, i) => {
      const sections = monthSheet(full, result.projection, i);
      const sum = (isIn: boolean) => sections.filter((s) => s.isIn === isIn).reduce((t, s) => t + s.totalCents, 0);
      expect(sum(true)).toBe(m.inCents);
      expect(sum(false)).toBe(m.outCents);
    });
  });

  it('says where each line came from', () => {
    const sections = monthSheet(full, result.projection, 1);
    const find = (name: string) => sections.flatMap((s) => s.lines).find((l) => l.name === name);
    expect(sections.map((s) => s.title)).toEqual([
      'Paydays',
      'Coming in',
      'Bills',
      'Usual spending',
      'Planned costs',
      'Debt payments',
      'Known items',
      'Surprises',
      'Set-asides and goals',
    ]);
    expect(find('Rent')?.source).toBe('Confirmed bill');
    expect(find('Savings')?.source).toBe('Your budget');
    expect(find('Other bills')?.source).toBe('Usual (last 3 months)');
    expect(find('Everyday')?.source).toBe('Usual (last 3 months)');
    expect(find('Car')?.source).toBe('Like last Nov');
    expect(find('Visa')?.source).toBe('Minimum + extra');
    expect(find('Car loan')?.source).toBe('Minimum');
    expect(find('Tax refund')).toMatchObject({ source: 'You added', amountCents: 90_000 });
    expect(find('Emergency fund')?.source).toBe('Your plan');
    // The rest of this month carries the overdue bill.
    expect(monthSheet(full, result.projection, 0).flatMap((s) => s.lines).some((l) => l.name === 'Late water')).toBe(true);
  });
});

describe('debt flags', () => {
  it('asks for a rate and marks an estimate, but not on a card paid in full', () => {
    const d = { aprPercent: 0, balanceCents: 45_000, minEstimated: true, endMonth: null, paidInFull: false };
    expect(debtFlags(d)).toEqual({ noRate: true, estimated: true });
    expect(debtFlags({ ...d, endMonth: '2027-02' }).noRate).toBe(false);
    expect(debtFlags({ ...d, paidInFull: true })).toEqual({ noRate: false, estimated: false });
  });

  it('estimates read in whole dollars', () => {
    expect(headlineText(111_736)).toMatch(/^About \$1,117 a month left over/);
    expect(allocationText({ allocatedCents: 3_000, unallocatedCents: 108_736 }).text).toBe('$30 given a job, $1,087 not yet');
  });
});
