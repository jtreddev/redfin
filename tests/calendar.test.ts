import { describe, expect, it } from 'vitest';
import { distribute, allocateLine } from '../src/shared/allocation';
import { addMonthsToDate, monthsBetween, previousWeekday, todayIn } from '../src/shared/dates';
import { formatCents, parseMoney } from '../src/shared/money';
import { extraPaychecks, nearestPayDate, payDatesInMonth } from '../src/shared/paySchedule';
import { monthWeeks, weekIndexOfDay } from '../src/shared/weeks';

describe('money', () => {
  it('parses bank-style amounts', () => {
    expect(parseMoney('$1,234.56')).toBe(123456);
    expect(parseMoney('-12.34')).toBe(-1234);
    expect(parseMoney('(12.34)')).toBe(-1234);
    expect(parseMoney('12.34-')).toBe(-1234);
    expect(parseMoney('.5')).toBe(50);
    expect(parseMoney('7')).toBe(700);
    expect(parseMoney('0.005')).toBe(1);
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
  });

  it('formats cents', () => {
    expect(formatCents(123456)).toBe('$1,234.56');
    expect(formatCents(-500, { whole: true })).toBe('-$5');
    expect(formatCents(500, { signed: true })).toBe('+$5.00');
  });
});

describe('dates', () => {
  it('handles month-end and weekends', () => {
    expect(addMonthsToDate('2026-01-31', 1)).toBe('2026-02-28');
    expect(monthsBetween('2026-09-13', '2026-12-12')).toBe(2);
    expect(previousWeekday('2026-10-31')).toBe('2026-10-30');
    expect(todayIn('America/Chicago', new Date('2026-09-14T03:00:00Z'))).toBe('2026-09-13');
  });
});

describe('weeks', () => {
  it('splits months the way the spreadsheet does', () => {
    const sep = monthWeeks('2026-09');
    expect(sep.map((w) => [w.start, w.end, w.days])).toEqual([
      ['2026-09-01', '2026-09-07', 7],
      ['2026-09-08', '2026-09-14', 7],
      ['2026-09-15', '2026-09-21', 7],
      ['2026-09-22', '2026-09-28', 7],
      ['2026-09-29', '2026-09-30', 2],
    ]);
    expect(monthWeeks('2026-02')).toHaveLength(4);
    expect(monthWeeks('2028-02').at(-1)?.days).toBe(1);
    expect([1, 7, 8, 28, 29, 31].map(weekIndexOfDay)).toEqual([1, 1, 2, 4, 5, 5]);
  });
});

describe('pay schedules', () => {
  const weekly = { frequency: 'weekly' as const, anchorDate: '2026-09-04' };

  it('finds weekly paydays and 5-paycheck months', () => {
    expect(payDatesInMonth(weekly, '2026-09')).toEqual(['2026-09-04', '2026-09-11', '2026-09-18', '2026-09-25']);
    expect(extraPaychecks(weekly, '2026-09')).toBe(0);
    expect(payDatesInMonth(weekly, '2026-10')).toHaveLength(5);
    expect(extraPaychecks(weekly, '2026-10')).toBe(1);
  });

  it('finds 3-paycheck biweekly months', () => {
    const biweekly = { frequency: 'biweekly' as const, anchorDate: '2026-01-02' };
    expect(payDatesInMonth(biweekly, '2026-01')).toEqual(['2026-01-02', '2026-01-16', '2026-01-30']);
    expect(extraPaychecks(biweekly, '2026-01')).toBe(1);
  });

  it('moves weekend paydays back to Friday', () => {
    const semimonthly = { frequency: 'semimonthly' as const, anchorDate: '2026-01-15', semimonthlyDays: [15, 31] as [number, number] };
    expect(payDatesInMonth(semimonthly, '2026-10')).toEqual(['2026-10-15', '2026-10-30']);
    const firstAndFifteenth = { ...semimonthly, semimonthlyDays: [1, 15] as [number, number] };
    // Nov 1, 2026 is a Sunday, so that paycheck arrives Friday Oct 30.
    expect(payDatesInMonth(firstAndFifteenth, '2026-10')).toEqual(['2026-10-01', '2026-10-15', '2026-10-30']);
    const monthly = { frequency: 'monthly' as const, anchorDate: '2026-01-31' };
    expect(payDatesInMonth(monthly, '2026-02')).toEqual(['2026-02-27']);
  });

  it('matches early deposits to the expected payday', () => {
    expect(nearestPayDate(weekly, '2026-09-02')).toBe('2026-09-04');
    expect(nearestPayDate(weekly, '2026-09-07')).toBe('2026-09-04');
  });
});

describe('allocation', () => {
  it('distributes cents exactly', () => {
    expect(distribute(20000, [7, 7, 7, 7, 2])).toEqual([4667, 4667, 4667, 4666, 1333]);
    expect(distribute(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
    expect(distribute(5, [0, 0])).toEqual([5, 0]);
    const parts = distribute(12345, [7, 7, 7, 7, 3]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(12345);
  });

  it('puts due-day bills in their week, clamping to month end', () => {
    expect(allocateLine({ amountCents: 1000, timing: 'due_day', dueDay: 31 }, '2026-02')).toEqual([0, 0, 0, 1000]);
    expect(allocateLine({ amountCents: 1000, timing: 'due_day', dueDay: 31 }, '2026-09')).toEqual([0, 0, 0, 0, 1000]);
    expect(allocateLine({ amountCents: 1000, timing: 'due_day', dueDay: null }, '2026-02')).toEqual([250, 250, 250, 250]);
  });
});
