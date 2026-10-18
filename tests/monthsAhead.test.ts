import { describe, expect, it } from 'vitest';
import {
  monthsToWatch,
  projectMonths,
  type MonthBill,
  type MonthsAheadInput,
  type PlannedCostInput,
} from '../src/shared/monthsAhead';

const TODAY = '2026-10-18'; // 13 days left in October (19th–31st)
const ZERO = { bills: 0, everyday: 0, habits: 0, fun: 0, saving: 0 };

function input(overrides: Partial<MonthsAheadInput> = {}): MonthsAheadInput {
  return {
    today: TODAY,
    startBalanceCents: 200_000,
    lowBalanceCents: 50_000,
    income: [],
    bills: [],
    usual: { ...ZERO },
    billsInUsual: [],
    saving: {},
    plannedCosts: [],
    historyStart: '2026-01',
    goals: [],
    ...overrides,
  };
}

const bill = (name: string, date: string, amountCents: number, cadence: MonthBill['cadence'] = 'monthly', plannedCostId: number | null = null): MonthBill => ({
  name,
  date,
  amountCents,
  cadence,
  plannedCostId,
  group: 'bills',
});

const monthly = { name: 'Paycheck', netPayCents: 300_000, schedule: { frequency: 'monthly' as const, anchorDate: '2026-09-25' } };
const biweekly = { name: 'Biweekly', netPayCents: 100_000, schedule: { frequency: 'biweekly' as const, anchorDate: '2026-10-02' } };

function cost(overrides: Partial<PlannedCostInput> = {}): PlannedCostInput {
  return {
    id: 1,
    name: 'Holidays & gifts',
    group: 'fun',
    balanceNowCents: 31_000,
    startMonth: '2026-01',
    amounts: [{ month: '2026-01', monthlyCents: 5_000 }],
    spendByMonth: {},
    usualCents: 0,
    ...overrides,
  };
}

describe('projectMonths', () => {
  it('counts only the rest of the current month, then whole months', () => {
    const r = projectMonths(input({ income: [monthly], usual: { ...ZERO, everyday: 31_000 } }), 3);
    expect(r.months.map((m) => [m.month, m.label, m.partial])).toEqual([
      ['2026-10', 'Rest of Oct', true],
      ['2026-11', 'Nov 2026', false],
      ['2026-12', 'Dec 2026', false],
      ['2027-01', 'Jan 2027', false],
    ]);
    // Usual × the share of days left: 31,000 × 13/31.
    expect(r.months[0]!.byGroup.everyday).toBe(13_000);
    expect(r.months[1]!.byGroup.everyday).toBe(31_000);
    // Oct 23 is still to come (the 25th is a Sunday); November's is on the 25th.
    expect(r.months.map((m) => m.payDays)).toEqual([1, 1, 1, 1]);
    expect(r.months[0]!.inCents).toBe(300_000);
  });

  it('skips a payday already received this month', () => {
    const r = projectMonths(input({ income: [{ ...monthly, receivedPayDates: ['2026-10-23'] }] }), 3);
    expect(r.months[0]!.payDays).toBe(0);
    expect(r.months[0]!.inCents).toBe(0);
  });

  it('says when a month has 3 biweekly paydays', () => {
    const r = projectMonths(input({ income: [biweekly] }), 12);
    const april = r.months.find((m) => m.month === '2027-04')!;
    expect(april.payDays).toBe(3);
    expect(april.extraPay).toBe(true);
    expect(april.inCents).toBe(300_000);
    expect(r.months.find((m) => m.month === '2027-03')!.extraPay).toBe(false);
    // The rest of October has one payday (the 30th); a part month is never "extra".
    expect(r.months[0]!.payDays).toBe(1);
    expect(r.months[0]!.extraPay).toBe(false);
  });

  it('lands quarterly and yearly bills in their months, and lists the big ones', () => {
    const bills = [
      bill('Car insurance', '2027-03-04', 61_200, 'yearly'),
      bill('Water', '2026-11-10', 12_000, 'quarterly'),
      bill('Water', '2027-02-10', 12_000, 'quarterly'),
      bill('Internet', '2026-11-20', 15_000, 'monthly'),
      bill('Trash', '2027-02-01', 9_000, 'quarterly'),
    ];
    const r = projectMonths(input({ bills }), 6);
    const by = (month: string) => r.months.find((m) => m.month === month)!;
    expect(by('2026-11').byGroup.bills).toBe(27_000);
    expect(by('2027-02').byGroup.bills).toBe(21_000);
    expect(by('2027-03').byGroup.bills).toBe(61_200);
    expect(by('2027-03').bigItems).toEqual([{ name: 'Car insurance', amountCents: 61_200, note: null }]);
    // Monthly bills and ones under $100 aren't big items.
    expect(by('2026-11').bigItems).toEqual([{ name: 'Water', amountCents: 12_000, note: null }]);
    expect(by('2027-02').bigItems.map((b) => b.name)).toEqual(['Water']);
  });

  it('counts the viewer’s private bill in fun', () => {
    const r = projectMonths(input({ bills: [{ ...bill('Gym', '2026-11-03', 4_000), group: 'fun' }] }), 3);
    expect(r.months[1]!.byGroup).toEqual({ ...ZERO, fun: 4_000 });
  });

  it('puts overdue bills in the rest of this month and leaves bills past the horizon out', () => {
    const r = projectMonths(input({ bills: [bill('Phone', '2026-10-16', 5_000), bill('Later', '2027-02-01', 9_000)] }), 3);
    expect(r.months[0]!.byGroup.bills).toBe(5_000);
    expect(r.months.reduce((sum, m) => sum + m.byGroup.bills, 0)).toBe(5_000);
  });

  it('takes bills and planned-cost categories out of usual, never below 0', () => {
    const r = projectMonths(
      input({
        usual: { bills: 99_000, everyday: 60_000, habits: 10_000, fun: 20_000, saving: 40_000 },
        billsInUsual: [
          { group: 'everyday', cadence: 'monthly', amountCents: -5_000 },
          { group: 'habits', cadence: 'yearly', amountCents: -240_000 },
          { group: 'bills', cadence: 'monthly', amountCents: -50_000 },
        ],
        plannedCosts: [cost({ group: 'everyday', usualCents: 8_000 }), cost({ id: 2, name: 'Gifts', group: 'fun', usualCents: 30_000 })],
      }),
      3,
    );
    const nov = r.months[1]!;
    // Each planned cost comes back in as its own expected spending (its set-aside: under a year of history).
    expect(nov.byGroup.everyday).toBe(60_000 - 5_000 - 8_000 + 5_000);
    expect(nov.byGroup.habits).toBe(0); // 10,000 − 20,000 a month
    expect(nov.byGroup.fun).toBe(0 + 5_000); // 20,000 − 30,000, then the cost's 5,000
  });

  it('expects a planned cost’s spending like last year once there are 12 months of history', () => {
    const holidays = cost({ spendByMonth: { '2025-10': 3_100, '2025-11': 0, '2025-12': 54_000, '2026-01': 2_000 } });
    const r = projectMonths(input({ historyStart: '2025-06', plannedCosts: [holidays] }), 3);
    expect(r.months.map((m) => m.byGroup.fun)).toEqual([1_300, 0, 54_000, 2_000]); // October × 13/31
    expect(r.months[2]!.bigItems).toEqual([{ name: 'Holidays & gifts', amountCents: 54_000, note: 'like last Dec' }]);
    expect(r.months[3]!.bigItems).toEqual([]);
  });

  it('uses the set-aside with less than 12 months of history, and in the month a year from this one', () => {
    const holidays = cost({ spendByMonth: { '2025-12': 54_000 } });
    const short = projectMonths(input({ historyStart: '2026-01', plannedCosts: [holidays] }), 3);
    expect(short.months.map((m) => m.byGroup.fun)).toEqual([Math.round((5_000 * 13) / 31), 5_000, 5_000, 5_000]);
    expect(short.months.flatMap((m) => m.bigItems)).toEqual([]);

    // October 2026 is still going, so October 2027 can't be "like last October".
    const year = projectMonths(input({ historyStart: '2025-01', plannedCosts: [holidays] }), 12);
    expect(year.months.at(-1)!.month).toBe('2027-10');
    expect(year.months.at(-1)!.byGroup.fun).toBe(5_000);
  });

  it('leaves a planned cost’s own bills out of its expected spending', () => {
    const car = cost({ id: 7, name: 'Car', group: 'everyday', spendByMonth: { '2026-03': 70_000 } });
    const r = projectMonths(input({ historyStart: '2025-01', plannedCosts: [car], bills: [bill('Car insurance', '2027-03-04', 61_200, 'yearly', 7)] }), 6);
    const march = r.months.find((m) => m.month === '2027-03')!;
    expect(march.byGroup.bills).toBe(61_200);
    expect(march.byGroup.everyday).toBe(8_800);
    // The bill is still paid from the cost: its balance drops by all 70,000.
    const balance = r.plannedCosts[0]!;
    expect(balance.lowestMonth).toBe('2027-03');
    expect(balance.lowestCents).toBe(31_000 + 5 * 5_000 - 70_000);
  });

  it('counts each month’s saving lines', () => {
    const r = projectMonths(input({ saving: { '2026-10': 10_000, '2026-11': 30_000, '2026-12': 30_000 } }), 3);
    expect(r.months.map((m) => m.byGroup.saving)).toEqual([10_000, 30_000, 30_000, 0]);
  });

  it('adds up left over and end-of-month cash, and finds the tightest month', () => {
    const r = projectMonths(
      input({
        income: [monthly],
        usual: { ...ZERO, everyday: 310_000 },
        bills: [bill('Car insurance', '2026-12-04', 61_200, 'yearly')],
      }),
      3,
    );
    const [oct, nov, dec, jan] = r.months;
    expect(oct!.leftOverCents).toBe(300_000 - 130_000);
    expect(oct!.endCents).toBe(200_000 + 170_000);
    expect(nov!.leftOverCents).toBe(-10_000);
    expect(dec!.leftOverCents).toBe(-71_200);
    expect(jan!.endCents).toBe(370_000 - 10_000 - 71_200 - 10_000);
    expect(r.tightest.month).toBe('2027-01');
    expect(r.endCents).toBe(jan!.endCents);
    expect(r.totals).toEqual({
      inCents: 1_200_000,
      outCents: 130_000 + 310_000 * 3 + 61_200,
      leftOverCents: 1_200_000 - (130_000 + 310_000 * 3 + 61_200),
      byGroup: { bills: 61_200, everyday: 130_000 + 310_000 * 3, habits: 0, fun: 0, saving: 0 },
    });
  });

  it('runs a planned cost’s balance forward and suggests a fix rounded up to $5', () => {
    const holidays = cost({ balanceNowCents: 31_000, spendByMonth: { '2025-12': 54_000 } });
    const r = projectMonths(input({ historyStart: '2025-01', plannedCosts: [holidays] }), 6);
    // Oct: 31,000 (nothing last October). Nov: +5,000. Dec: +5,000 − 54,000 = −13,000.
    expect(r.plannedCosts).toEqual([
      {
        name: 'Holidays & gifts',
        balanceNowCents: 31_000,
        lowestCents: -13_000,
        lowestMonth: '2026-12',
        endCents: -13_000 + 4 * 5_000,
        // 13,000 over Nov and Dec = 6,500 a month.
        fixMonthlyCents: 6_500,
      },
    ]);
    const rounded = projectMonths(input({ historyStart: '2025-01', plannedCosts: [cost({ balanceNowCents: 31_010, spendByMonth: { '2025-12': 54_030 } })] }), 6);
    expect(rounded.plannedCosts[0]!.fixMonthlyCents).toBe(7_000); // 13,020 / 2 = $65.10, rounded up to $70
  });

  it('projects when a goal is reached at the recent pace, or null with nothing saved lately', () => {
    const r = projectMonths(
      input({
        goals: [
          { name: 'Emergency fund', remainingCents: 100_000, recentAverageCents: 10_000 },
          { name: 'Trip', remainingCents: 50_000, recentAverageCents: 0 },
          { name: 'Done', remainingCents: 0, recentAverageCents: 0 },
        ],
      }),
      3,
    );
    expect(r.goals).toEqual([
      { name: 'Emergency fund', projectedMonth: '2027-08', done: false },
      { name: 'Trip', projectedMonth: null, done: false },
      { name: 'Done', projectedMonth: '2026-10', done: true },
    ]);
  });

  it('counts habits over a full year whatever the horizon', () => {
    const r = projectMonths(input({ usual: { ...ZERO, habits: 19_000 } }), 3);
    expect(r.habitsTotalCents).toBe(228_000);
  });

  it('applies a what-if', () => {
    const base = input({ income: [biweekly], usual: { ...ZERO, everyday: 100_000, habits: 20_000, fun: 10_000 } });
    const plain = projectMonths(base, 3);
    const r = projectMonths(base, 3, {
      habitsFactor: 0.5,
      everydayFactor: 0.9,
      monthlyCents: 5_000,
      oneOffCents: 40_000,
      oneOffMonth: '2026-12',
      payChangeCents: -1_000,
    });
    const nov = r.months[1]!;
    expect(nov.byGroup.habits).toBe(10_000);
    expect(nov.byGroup.everyday).toBe(90_000);
    expect(nov.byGroup.fun).toBe(10_000);
    expect(nov.addedCents).toBe(5_000);
    expect(nov.inCents).toBe(2 * 99_000);
    expect(r.months[0]!.addedCents).toBe(0); // monthly costs start next month
    expect(r.months[2]!.addedCents).toBe(45_000);
    // Per whole month: +10,000 habits, +10,000 everyday, −5,000 added, −2,000 pay (Oct: part of that, less 1,000 pay).
    const octSaved = plain.months[0]!.outCents - r.months[0]!.outCents - 1_000;
    expect(r.endCents - plain.endCents).toBe(octSaved + 3 * (10_000 + 10_000 - 5_000 - 2_000) - 40_000);
  });

  it('slices to 3, 6 or 12 months', () => {
    const base = input({ income: [monthly], usual: { ...ZERO, everyday: 100_000 } });
    for (const horizon of [3, 6, 12] as const) {
      const r = projectMonths(base, horizon);
      expect(r.months).toHaveLength(horizon + 1);
      expect(r.endCents).toBe(r.months.at(-1)!.endCents);
    }
    // A longer horizon starts the same.
    expect(projectMonths(base, 12).months.slice(0, 4)).toEqual(projectMonths(base, 3).months);
  });
});

describe('monthsToWatch', () => {
  it('lists months that go short or under the cushion; none when all is well', () => {
    const r = projectMonths(
      input({ income: [monthly], usual: { ...ZERO, everyday: 280_000 }, bills: [bill('Car insurance', '2026-12-04', 61_200, 'yearly')] }),
      3,
    );
    expect(monthsToWatch(r, 50_000).map((m) => m.month)).toEqual(['2026-12']);
    expect(monthsToWatch(projectMonths(input({ income: [monthly] }), 3), 50_000)).toEqual([]);
    // Under the cushion counts even with money left over.
    expect(monthsToWatch(projectMonths(input({ startBalanceCents: 0 }), 3), 50_000).map((m) => m.month)).toEqual([
      '2026-10',
      '2026-11',
      '2026-12',
      '2027-01',
    ]);
  });
});
