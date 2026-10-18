import { describe, expect, it } from 'vitest';
import {
  fallbackLastDate,
  monthlyEquivalent,
  nextPayday,
  NO_PAYDAY_NOTE,
  projectToPayday,
  yearlyChangeCents,
  type ProjectionEvent,
  type ProjectionInput,
  usualLessBills,
} from '../src/shared/projection';

const TODAY = '2026-10-18'; // a Sunday

function input(overrides: Partial<ProjectionInput> = {}): ProjectionInput {
  return {
    today: TODAY,
    startBalanceCents: 200_000,
    payday: { date: '2026-10-23', amountCents: 250_000, name: 'Paycheck' },
    events: [],
    dailySpend: { everyday: 3_000, habits: 1_000, fun: 500 },
    lowBalanceCents: 50_000,
    ...overrides,
  };
}

const bill = (id: string, date: string, amountCents: number): ProjectionEvent => ({ id, date, name: id, amountCents, kind: 'bill' });

describe('nextPayday', () => {
  const weekly = { name: 'Weekly', netPayCents: 100_000, schedule: { frequency: 'weekly' as const, anchorDate: '2026-10-02' } };
  const monthly = { name: 'Monthly', netPayCents: 300_000, schedule: { frequency: 'monthly' as const, anchorDate: '2026-09-23' } };

  it('is the earliest payday after today across sources', () => {
    expect(nextPayday([monthly, weekly], TODAY)).toEqual({ date: '2026-10-23', amountCents: 400_000, name: 'Monthly and Weekly' });
    expect(nextPayday([weekly], '2026-10-23')?.date).toBe('2026-10-30'); // today's payday isn't "next"
  });

  it('skips a payday that already has its deposit', () => {
    expect(nextPayday([{ ...weekly, receivedPayDates: ['2026-10-23'] }, monthly], TODAY)).toEqual({
      date: '2026-10-23',
      amountCents: 300_000,
      name: 'Monthly',
    });
    expect(nextPayday([{ ...weekly, receivedPayDates: ['2026-10-23'] }], TODAY)?.date).toBe('2026-10-30');
  });

  it('crosses into next month', () => {
    const early = { name: 'Monthly', netPayCents: 300_000, schedule: { frequency: 'monthly' as const, anchorDate: '2026-09-05' } };
    expect(nextPayday([early], TODAY)?.date).toBe('2026-11-05');
  });

  it('is null with no sources or none within 45 days', () => {
    expect(nextPayday([], TODAY)).toBeNull();
    const far = { name: 'Bonus', netPayCents: 1, schedule: { frequency: 'monthly' as const, anchorDate: '2026-10-17' } };
    expect(nextPayday([{ ...far, receivedPayDates: ['2026-11-17'] }], '2026-10-18')).toBeNull();
  });
});

describe('projectToPayday', () => {
  it('runs from today to the day before payday, spending the usual each day', () => {
    const p = projectToPayday(input());
    expect(p.points.map((x) => x.date)).toEqual(['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22']);
    expect(p.points[0]!.balanceCents).toBe(200_000);
    expect(p.spendTotalCents).toBe(4 * 4_500);
    expect(p.dayBeforeCents).toBe(200_000 - 18_000);
    expect(p.lastDate).toBe('2026-10-22');
    expect(p.note).toBeNull();
  });

  it('crosses the month end for a payday next month', () => {
    const p = projectToPayday(input({ payday: { date: '2026-11-05', amountCents: 1, name: 'Pay' }, events: [bill('rent', '2026-11-01', 150_000)] }));
    expect(p.points.at(-1)!.date).toBe('2026-11-04');
    expect(p.points).toHaveLength(18);
    expect(p.events.map((e) => e.id)).toEqual(['rent']);
    expect(p.dayBeforeCents).toBe(200_000 - 17 * 4_500 - 150_000);
  });

  it('falls back to the end of the month, with a note, when there is no payday', () => {
    const p = projectToPayday(input({ payday: null }));
    expect(p.note).toBe(NO_PAYDAY_NOTE);
    expect(p.lastDate).toBe('2026-10-31');
    expect(fallbackLastDate('2026-10-24')).toBe('2026-10-31'); // 7 days away
    expect(fallbackLastDate('2026-10-25')).toBe('2026-11-30');
  });

  it('counts a bill on the day before payday but not one on payday', () => {
    const p = projectToPayday(input({ events: [bill('before', '2026-10-22', 10_000), bill('payday', '2026-10-23', 20_000)] }));
    expect(p.events.map((e) => e.id)).toEqual(['before']);
    expect(p.dayBeforeCents).toBe(200_000 - 18_000 - 10_000);
  });

  it('lands an overdue or due-today bill on tomorrow', () => {
    const p = projectToPayday(input({ events: [bill('late', '2026-10-12', 10_000), bill('today', TODAY, 5_000)] }));
    expect(p.events.map((e) => [e.id, e.date])).toEqual([
      ['late', '2026-10-19'],
      ['today', '2026-10-19'],
    ]);
    expect(p.points[1]!.balanceCents).toBe(200_000 - 4_500 - 15_000);
  });

  it('finds the lowest point and what is free above the cushion', () => {
    const p = projectToPayday(input({ events: [bill('rent', '2026-10-20', 150_000)] }));
    expect(p.lowest).toEqual({ date: '2026-10-22', balanceCents: 200_000 - 18_000 - 150_000 });
    expect(p.freeCents).toBe(0); // $320 is under the $500 cushion
    expect(projectToPayday(input()).freeCents).toBe(182_000 - 50_000);
  });

  it('starts from today when payday is tomorrow', () => {
    const p = projectToPayday(input({ payday: { date: '2026-10-19', amountCents: 1, name: 'Pay' }, events: [bill('late', '2026-10-10', 9_000)] }));
    expect(p.points).toEqual([{ date: TODAY, balanceCents: 200_000 }]);
    expect(p.dayBeforeCents).toBe(200_000);
    expect(p.lowest.date).toBe(TODAY);
    expect(p.events).toEqual([]);
    expect(p.spendTotalCents).toBe(0);
  });

  it('spends nothing extra with no history', () => {
    const p = projectToPayday(input({ dailySpend: { everyday: 0, habits: 0, fun: 0 } }));
    expect(p.points.every((x) => x.balanceCents === 200_000)).toBe(true);
    expect(p.spendTotalCents).toBe(0);
  });

  describe('what-if', () => {
    const base = input({ events: [bill('gym', '2026-10-21', 4_000)] });

    it('trims habits and everyday spending', () => {
      const before = projectToPayday(base).dayBeforeCents;
      const after = projectToPayday({ ...base, whatIf: { habitsFactor: 0, everydayFactor: 0.9 } }).dayBeforeCents;
      expect(after - before).toBe(4 * (1_000 + 300));
      expect(yearlyChangeCents(base.dailySpend, { habitsFactor: 0.5 })).toBe(500 * 365);
    });

    it('adds a one-off cost tomorrow, or a monthly one each month', () => {
      const once = projectToPayday({ ...base, whatIf: { addCents: 2_500, addRepeat: 'once' } });
      expect(once.events.find((e) => e.kind === 'oneoff')).toMatchObject({ date: '2026-10-19', amountCents: 2_500 });
      expect(once.dayBeforeCents).toBe(projectToPayday(base).dayBeforeCents - 2_500);
      expect(yearlyChangeCents(base.dailySpend, { addCents: 2_500, addRepeat: 'once' })).toBe(0);

      const long = { ...base, payday: { date: '2026-11-25', amountCents: 1, name: 'Pay' } };
      const monthly = projectToPayday({ ...long, whatIf: { addCents: 2_500, addRepeat: 'monthly' } });
      expect(monthly.events.filter((e) => e.kind === 'oneoff').map((e) => e.date)).toEqual(['2026-10-19', '2026-11-19']);
      expect(yearlyChangeCents(base.dailySpend, { addCents: 2_500, addRepeat: 'monthly' })).toBe(-30_000);
    });

    it('skips a bill', () => {
      const p = projectToPayday({ ...base, whatIf: { skip: ['gym'] } });
      expect(p.events).toEqual([]);
      expect(p.dayBeforeCents - projectToPayday(base).dayBeforeCents).toBe(4_000);
    });
  });
});

describe('usual spending less bills', () => {
  it('turns a bill into a monthly amount', () => {
    expect(monthlyEquivalent(1_000, 'weekly')).toBe(4_333);
    expect(monthlyEquivalent(1_000, 'biweekly')).toBe(2_167);
    expect(monthlyEquivalent(1_500, 'monthly')).toBe(1_500);
    expect(monthlyEquivalent(3_000, 'quarterly')).toBe(1_000);
    expect(monthlyEquivalent(12_000, 'yearly')).toBe(1_000);
  });

  it('takes bills out of their group, never below 0', () => {
    const usual = { bills: 90_000, everyday: 30_000, habits: 5_000, fun: 2_000, saving: 10_000 };
    expect(
      usualLessBills(usual, [
        { group: 'fun', cadence: 'monthly', amountCents: 1_500 },
        { group: 'habits', cadence: 'weekly', amountCents: 2_000 },
        { group: 'bills', cadence: 'monthly', amountCents: 50_000 },
        { group: null, cadence: 'monthly', amountCents: 9_999 },
      ]),
    ).toEqual({ everyday: 30_000, habits: 0, fun: 500 });
  });
});
