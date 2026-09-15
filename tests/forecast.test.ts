import { describe, expect, it } from 'vitest';
import { buildForecast, type ForecastInput, type ForecastLine } from '../src/shared/forecast';
import { safeToSpend } from '../src/shared/safeToSpend';
import { SHEET_LINES, SHEET_WEEKS } from './fixtures/sheetSeptember2026';

const weeklyPay = {
  id: 'pay',
  netPayCents: 193500,
  schedule: { frequency: 'weekly' as const, anchorDate: '2026-09-04' },
};

const sheetLines: ForecastLine[] = SHEET_LINES.map((line, i) => ({
  id: i,
  kind: 'expense',
  budgetCents: line.dollars * 100,
  timing: line.timing,
  dueDay: line.dueDay ?? null,
}));

function sheetInput(overrides: Partial<ForecastInput> = {}): ForecastInput {
  return {
    month: '2026-09',
    today: '2026-08-31',
    startingBalanceCents: 100000,
    lowBalanceCents: 75000,
    paySources: [weeklyPay],
    lines: sheetLines,
    ...overrides,
  };
}

describe('forecast — golden month from the spreadsheet', () => {
  const forecast = buildForecast(sheetInput());

  it('matches weekly income', () => {
    expect(forecast.weeks.map((w) => w.plannedIncome)).toEqual(SHEET_WEEKS.income.map((d) => d * 100));
    expect(forecast.extraPaychecks).toBe(0);
  });

  it('matches weekly outflow within a dollar (the sheet rounds for display)', () => {
    forecast.weeks.forEach((week, i) => {
      expect(Math.abs(week.plannedOutflow - (SHEET_WEEKS.outflow[i] ?? 0) * 100)).toBeLessThanOrEqual(100);
    });
    expect(forecast.totals.plannedOutflow).toBe(1050100);
  });

  it('matches ending balances and flags every week as negative', () => {
    forecast.weeks.forEach((week, i) => {
      expect(Math.abs(week.endBalance - (SHEET_WEEKS.endBalance[i] ?? 0) * 100)).toBeLessThanOrEqual(100);
      expect(week.status).toBe('negative');
    });
  });

  it('is entirely planned before the month starts', () => {
    expect(forecast.currentWeekPosition).toBeNull();
    expect(forecast.weeks.every((w) => !w.isPast && !w.isCurrent)).toBe(true);
    expect(forecast.weeks.map((w) => w.projectedOutflow)).toEqual(forecast.weeks.map((w) => w.plannedOutflow));
  });
});

describe('forecast — mid-month', () => {
  const groceries: ForecastLine = { id: 'groceries', kind: 'expense', budgetCents: 120000, timing: 'even' };
  const mortgage: ForecastLine = { id: 'mortgage', kind: 'expense', budgetCents: 160000, timing: 'due_day', dueDay: 1 };
  const autoInsurance: ForecastLine = { id: 'auto', kind: 'expense', budgetCents: 16000, timing: 'due_day', dueDay: 5 };

  function midMonth(groceryWeek2 = 0, startingBalanceCents = 1_000_000, extraLines: ForecastLine[] = []) {
    return buildForecast({
      month: '2026-09',
      today: '2026-09-10',
      startingBalanceCents,
      lowBalanceCents: 75000,
      paySources: [{ ...weeklyPay, receivedPayDates: ['2026-09-04'] }],
      lines: [
        { ...groceries, actualByWeek: [16842, groceryWeek2] },
        { ...mortgage, actualByWeek: [159500] },
        autoInsurance,
        ...extraLines,
      ],
      otherActual: { incomeByWeek: [193500] },
    });
  }

  it('treats paid bills as done and moves unpaid past bills into this week', () => {
    const f = midMonth();
    expect(f.currentWeekPosition).toBe(1);
    expect(f.remainingByLine.get('mortgage')).toEqual([0, 0, 0, 0, 0]);
    expect(f.remainingByLine.get('auto')).toEqual([0, 16000, 0, 0, 0]);
  });

  it('spreads last week’s grocery underspend over the rest of the month', () => {
    const f = midMonth();
    const remaining = f.remainingByLine.get('groceries') ?? [];
    expect(remaining[0]).toBe(0);
    // Total remaining = budget − spent.
    expect(remaining.reduce((a, b) => a + b, 0)).toBe(120000 - 16842);
  });

  it('counts only paychecks not yet received', () => {
    const f = midMonth();
    expect(f.weeks[0]?.projectedIncome).toBe(193500);
    expect(f.weeks[1]?.projectedIncome).toBe(193500);
  });

  it('a $40 grocery purchase lowers safe-to-spend by exactly $40', () => {
    const before = safeToSpend(midMonth(0), 75000);
    const after = safeToSpend(midMonth(4000), 75000);
    expect(before.safeCents - after.safeCents).toBe(4000);
    expect(after.cushionCents).toBe(before.cushionCents);
  });

  it('takes a future shortfall out of this week’s safe-to-spend', () => {
    const roof: ForecastLine = { id: 'roof', kind: 'expense', budgetCents: 700000, timing: 'due_day', dueDay: 26 };
    const tight = safeToSpend(midMonth(0, 0, [roof]), 75000);
    expect(tight.cushionCents).toBeLessThan(0);
    expect(tight.safeCents).toBe(Math.max(0, tight.flexibleLeftCents + tight.cushionCents));
    expect(tight.safeCents).toBeLessThan(tight.flexibleLeftCents);
  });
});
