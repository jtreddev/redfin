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

function median(values: number[]): number {
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
 * Finds bills and subscriptions: the same merchant, a steady amount (within ±10%),
 * on a regular rhythm, seen at least 3 times (2 for yearly). Stale series whose
 * last charge is more than two cycles old are skipped.
 */
export function detectRecurring(
  transactions: readonly RecurringInput[],
  { today, amountTolerance = 0.1 }: { today?: ISODate; amountTolerance?: number } = {},
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
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
    // One charge per day counts once.
    const daily = sorted.filter((t, i) => i === 0 || t.date !== sorted[i - 1]?.date);
    if (daily.length < 2) continue;

    const intervals = daily.slice(1).map((t, i) => diffDays(t.date, daily[i]?.date ?? t.date));
    const typical = median(intervals);
    const range = CADENCE_RANGES.find((r) => typical >= r.min && typical <= r.max);
    if (!range) continue;
    const needed = range.cadence === 'yearly' ? 2 : 3;
    if (daily.length < needed) continue;

    const intervalShare = intervals.filter((d) => d >= range.min && d <= range.max).length / intervals.length;
    const amounts = daily.map((t) => Math.abs(t.amountCents));
    const typicalAmount = median(amounts);
    const amountShare =
      amounts.filter((a) => Math.abs(a - typicalAmount) <= typicalAmount * amountTolerance).length / amounts.length;
    if (intervalShare < 0.7 || amountShare < 0.7) continue;

    const last = daily[daily.length - 1];
    if (!last) continue;
    if (today && diffDays(today, last.date) > CADENCE_DAYS[range.cadence] * 2 + 5) continue;

    const sign = (last.amountCents < 0 ? -1 : 1) as 1 | -1;
    suggestions.push({
      merchant: last.merchant,
      cadence: range.cadence,
      expectedAmountCents: sign * typicalAmount,
      occurrences: daily.length,
      lastDate: last.date,
      nextDate: nextOccurrence(last.date, range.cadence),
      transactionIds: sorted.map((t) => t.id),
      confidence: Math.round(((intervalShare + amountShare) / 2) * Math.min(1, daily.length / 6) * 100) / 100,
    });
  }
  return suggestions.sort((a, b) => b.confidence - a.confidence || a.merchant.localeCompare(b.merchant));
}
