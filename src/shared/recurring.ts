import { addDays, addMonthsToDate, diffDays, type ISODate } from './dates';
import type { Cents } from './money';

export type Cadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';

export interface RecurringInput {
  id: number;
  date: ISODate;
  amountCents: Cents;
  /** Normalized merchant key (see normalizeMerchant). */
  merchant: string;
}

export interface RecurringSuggestion {
  merchant: string;
  cadence: Cadence;
  /** Median amount, signed (negative for bills). */
  expectedAmountCents: Cents;
  occurrences: number;
  lastDate: ISODate;
  nextDate: ISODate;
  transactionIds: number[];
  /** 0–1. */
  confidence: number;
}

const CADENCE_RANGES: { cadence: Cadence; min: number; max: number }[] = [
  { cadence: 'weekly', min: 6, max: 8 },
  { cadence: 'biweekly', min: 13, max: 15 },
  { cadence: 'monthly', min: 26, max: 35 },
  { cadence: 'quarterly', min: 85, max: 97 },
  { cadence: 'yearly', min: 350, max: 380 },
];

const CADENCE_DAYS: Record<Cadence, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  quarterly: 91,
  yearly: 365,
};

const VARIABLE_TOLERANCE = 0.4;
const SLOW_CADENCES = new Set<Cadence>(['monthly', 'quarterly', 'yearly']);

/** Within `ratio` times of each other: allows for bills that change (utilities) but keeps $0.99 and $9.99 apart. */
export const sameBill = (a: number, b: number, ratio = 2) => Math.max(Math.abs(a), Math.abs(b)) <= Math.min(Math.abs(a), Math.abs(b)) * ratio;

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

export function nextOccurrence(lastDate: ISODate, cadence: Cadence): ISODate {
  switch (cadence) {
    case 'weekly':
      return addDays(lastDate, 7);
    case 'biweekly':
      return addDays(lastDate, 14);
    case 'monthly':
      return addMonthsToDate(lastDate, 1);
    case 'quarterly':
      return addMonthsToDate(lastDate, 3);
    case 'yearly':
      return addMonthsToDate(lastDate, 12);
  }
}

/**
 * Splits one merchant's charges into series by amount, so two subscriptions from the same
 * place ($0.99 and $9.99 at Apple) are found separately. A step of more than 25% starts a
 * new series; a price increase stays in the same one.
 */
function byAmount(charges: readonly RecurringInput[]): RecurringInput[][] {
  const sorted = [...charges].sort((a, b) => Math.abs(a.amountCents) - Math.abs(b.amountCents));
  const series: RecurringInput[][] = [];
  let previous = 0;
  for (const t of sorted) {
    const amount = Math.abs(t.amountCents);
    if (!series.length || amount > previous * 1.25) series.push([]);
    series[series.length - 1]!.push(t);
    previous = amount;
  }
  return series;
}

/**
 * Finds bills and subscriptions: the same merchant, a steady amount (within ±10%),
 * on a regular rhythm, seen at least 3 times (2 for yearly). Stale series whose
 * last charge is more than two cycles old are skipped.
 */
export function detectRecurring(
  transactions: readonly RecurringInput[],
  {
    today,
    amountTolerance = 0.1,
    saved = new Map(),
  }: {
    today?: ISODate;
    amountTolerance?: number;
    /** Bills already saved, as "merchant|cadence" → expected amount, so their series keep their name. */
    saved?: ReadonlyMap<string, Cents>;
  } = {},
): RecurringSuggestion[] {
  const groups = new Map<string, RecurringInput[]>();
  for (const t of transactions) {
    if (!t.merchant || t.amountCents === 0) continue;
    const key = `${t.merchant}|${t.amountCents < 0 ? '-' : '+'}`;
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }

  const suggestions: RecurringSuggestion[] = [];
  for (const charges of groups.values()) {
    const found: RecurringSuggestion[] = [];
    for (const group of byAmount(charges)) {
      const suggestion = seriesSuggestion(group, today, amountTolerance);
      if (suggestion) found.push(suggestion);
    }
    // Utilities and phone bills change month to month: when nothing steady turned up, accept a looser
    // amount as long as it comes on a monthly (or slower) rhythm. Weekly store trips stay out.
    if (!found.length) {
      const variable = seriesSuggestion(charges, today, VARIABLE_TOLERANCE);
      if (variable && SLOW_CADENCES.has(variable.cadence)) found.push(variable);
    }
    // Bills are saved by merchant and cadence, so when one merchant has two series with the same cadence,
    // the plain name goes to the one already saved under it (closest amount); otherwise the most frequent.
    const distance = (s: RecurringSuggestion) => {
      const amount = saved.get(`${s.merchant}|${s.cadence}`);
      return amount === undefined ? Infinity : Math.abs(Math.abs(amount) - Math.abs(s.expectedAmountCents));
    };
    found.sort(
      (a, b) =>
        distance(a) - distance(b) ||
        b.occurrences - a.occurrences ||
        Math.abs(b.expectedAmountCents) - Math.abs(a.expectedAmountCents),
    );
    const taken = new Set<string>();
    for (const s of found) {
      if (taken.has(s.cadence)) s.merchant = `${s.merchant} $${Math.round(Math.abs(s.expectedAmountCents) / 100)}`;
      taken.add(s.cadence);
      suggestions.push(s);
    }
  }
  return suggestions.sort((a, b) => b.confidence - a.confidence || a.merchant.localeCompare(b.merchant));
}

const LOOSE_CADENCES = new Set<Cadence>(['monthly', 'quarterly']);
const RECENT_GAPS = 4;

/**
 * For bills paid by hand: a week late one month and early the next, or a month skipped (paid from
 * another account). Over the latest year, each gap is about one cycle (half to 1.6 of one) or a whole
 * number of cycles, and on average they come once a cycle. Returns the share of gaps that fit, or 0.
 */
function looseRhythm(daily: readonly RecurringInput[], range: (typeof CADENCE_RANGES)[number]): number {
  const last = daily[daily.length - 1]!.date;
  const recent = daily.filter((t) => diffDays(last, t.date) <= 365);
  if (recent.length < 3) return 0;
  const period = CADENCE_DAYS[range.cadence];
  let cycles = 0;
  let fits = 0;
  const gaps = recent.slice(1).map((t, i) => diffDays(t.date, recent[i]!.date));
  for (const gap of gaps) {
    const k = Math.max(1, Math.round(gap / period));
    cycles += k;
    if (k === 1 ? gap >= period * 0.5 && gap <= period * 1.6 : k <= 6 && gap >= range.min * k && gap <= range.max * k) fits++;
  }
  const average = diffDays(last, recent[0]!.date) / cycles;
  return average >= range.min && average <= range.max ? fits / gaps.length : 0;
}

function seriesSuggestion(group: readonly RecurringInput[], today: ISODate | undefined, amountTolerance: number): RecurringSuggestion | null {
  if (group.length < 2) return null;
  const sorted = [...group].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  // One charge per day counts once.
  const daily = sorted.filter((t, i) => i === 0 || t.date !== sorted[i - 1]?.date);
  if (daily.length < 2) return null;

  const intervals = daily.slice(1).map((t, i) => diffDays(t.date, daily[i]?.date ?? t.date));
  const typical = median(intervals);
  const range = CADENCE_RANGES.find((r) => typical >= r.min && typical <= r.max);
  if (!range) return null;
  const needed = range.cadence === 'yearly' ? 2 : 3;
  if (daily.length < needed) return null;

  let intervalShare = intervals.filter((d) => d >= range.min && d <= range.max).length / intervals.length;
  if (intervalShare < 0.7 && LOOSE_CADENCES.has(range.cadence)) intervalShare = looseRhythm(daily, range) * 0.9;
  // Messy history (a gap in the bank's data, a switch of accounts) but steady lately.
  const lately = intervals.slice(-RECENT_GAPS);
  if (intervalShare < 0.7 && lately.length === RECENT_GAPS && lately.every((d) => d >= range.min - 2 && d <= range.max + 2)) {
    intervalShare = 0.7;
  }
  const amounts = daily.map((t) => Math.abs(t.amountCents));
  const typicalAmount = median(amounts);
  const amountShare =
    amounts.filter((a) => Math.abs(a - typicalAmount) <= typicalAmount * amountTolerance).length / amounts.length;
  if (intervalShare < 0.7 || amountShare < 0.7) return null;

  const last = daily[daily.length - 1];
  if (!last) return null;
  if (today && diffDays(today, last.date) > CADENCE_DAYS[range.cadence] * 2 + 5) return null;

  const sign = (last.amountCents < 0 ? -1 : 1) as 1 | -1;
  return {
    merchant: last.merchant,
    cadence: range.cadence,
    expectedAmountCents: sign * typicalAmount,
    occurrences: daily.length,
    lastDate: last.date,
    nextDate: nextOccurrence(last.date, range.cadence),
    transactionIds: sorted.map((t) => t.id),
    confidence: Math.round(((intervalShare + amountShare) / 2) * Math.min(1, daily.length / 6) * 100) / 100,
  };
}

/** How often charges on these dates repeat, for a bill marked by hand; monthly when there's too little to tell. */
export function guessCadence(dates: readonly ISODate[]): Cadence {
  const days = [...new Set(dates)].sort();
  if (days.length < 2) return 'monthly';
  const typical = median(days.slice(1).map((d, i) => diffDays(d, days[i] ?? d)));
  return CADENCE_RANGES.find((r) => typical >= r.min && typical <= r.max)?.cadence ?? 'monthly';
}
