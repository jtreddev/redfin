import { addDays, addMonths, clampDay, diffDays, monthOf, parseDate, type ISODate } from './dates';
import type { Cents } from './money';
import { matchPaycheck } from './paychecks';
import { nearestPayDate, payDatesBetween, type PayFrequency, type PaySchedule } from './paySchedule';
import { normalizeMerchant, normalizeText } from './rules';

export interface DepositInput {
  id: number;
  date: ISODate;
  amountCents: Cents;
  name: string;
  merchantName?: string | null;
  /** Normalized merchant key (see normalizeMerchant). */
  merchant: string;
  accountId: number;
  /** Plaid personal_finance_category.primary, e.g. INCOME. */
  plaidCategory?: string | null;
}

export interface PaycheckSuggestion {
  merchant: string;
  /** Text that recognizes these deposits (checked against every one of them). */
  matchText: string;
  frequency: PayFrequency;
  anchorDate: ISODate;
  semimonthlyDays: [number, number] | null;
  /** Typical take-home, from the most recent paychecks. */
  netPayCents: Cents;
  /** Null when a paycheck is split across accounts, or lands in different ones. */
  accountId: number | null;
  deposits: number;
  firstDate: ISODate;
  lastDate: ISODate;
  nextDate: ISODate | null;
  /** 0–1. */
  confidence: number;
}

/** Smaller regular deposits (interest, cash back) aren't paychecks. */
const MIN_PAYCHECK_CENTS = 5_000;
/** Enough history to tell "every two weeks" from "twice a month". Weekly pay is plain sooner. */
const MIN_SPAN_DAYS = 56;
const MIN_WEEKLY_PAYDAYS = 4;
const MIN_FIT = 0.8;
const CYCLE_DAYS: Record<PayFrequency, number> = { weekly: 7, biweekly: 14, semimonthly: 16, monthly: 31 };

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

const dayNumber = (date: ISODate) => {
  const { y, m, d } = parseDate(date);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

interface Payday {
  date: ISODate;
  n: number;
  amountCents: Cents;
  accountIds: Set<number>;
  rows: DepositInput[];
}

/** One paycheck can land in two accounts on the same day; count it once, for the total. */
function paydaysOf(deposits: readonly DepositInput[]): Payday[] {
  const byDate = new Map<ISODate, Payday>();
  for (const d of deposits) {
    const day = byDate.get(d.date) ?? { date: d.date, n: dayNumber(d.date), amountCents: 0, accountIds: new Set<number>(), rows: [] };
    day.amountCents += d.amountCents;
    day.accountIds.add(d.accountId);
    day.rows.push(d);
    byDate.set(d.date, day);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * How well a schedule explains the deposits: the share of deposits that land near a payday,
 * and the share of paydays that got a deposit. Both have to be high, so "weekly" can't
 * claim a biweekly paycheck and "twice a month" can't claim one that drifts every two weeks.
 */
function fit(schedule: PaySchedule, days: readonly Payday[]): { score: number; drift: number } {
  const first = days[0]!;
  const last = days[days.length - 1]!;
  // Paydays as day numbers, once per schedule: this runs for hundreds of schedules per payer.
  const paydays = payDatesBetween(schedule, addDays(first.date, -3), addDays(last.date, 3)).map(dayNumber);
  const expected = paydays.filter((n) => n >= first.n + 3 && n <= last.n - 3);
  const hit = new Set<number>();
  let matched = 0;
  // How far deposits sit from their paydays. Early is normal (Chime); late counts double.
  let drift = 0;
  let i = 0;
  for (const day of days) {
    // Same rule as nearestPayDate: the closest payday within 3 days, the earlier one on a tie.
    while (i < paydays.length && paydays[i]! < day.n - 3) i++;
    let best: number | null = null;
    for (let j = i; j < paydays.length && paydays[j]! <= day.n + 3; j++) {
      if (best === null || Math.abs(paydays[j]! - day.n) < Math.abs(best - day.n)) best = paydays[j]!;
    }
    if (best !== null && !hit.has(best)) {
      hit.add(best);
      matched++;
      drift += best >= day.n ? best - day.n : 2 * (day.n - best);
    }
  }
  const paydaysHit = expected.filter((n) => hit.has(n)).length;
  return { score: Math.min(matched / days.length, expected.length ? paydaysHit / expected.length : 1), drift };
}

function candidates(days: readonly Payday[]): PaySchedule[] {
  const schedules: PaySchedule[] = [];
  // The usual gap between deposits rules out most schedules before fitting any (this has to stay fast).
  const gap = median(days.slice(1).map((day, i) => day.n - days[i]!.n));
  // Any real payday anchors a weekly or biweekly schedule; the last few are enough.
  for (const day of days.slice(-8)) {
    if (gap <= 10) schedules.push({ frequency: 'weekly', anchorDate: day.date });
    if (gap >= 5 && gap <= 20) schedules.push({ frequency: 'biweekly', anchorDate: day.date });
  }
  if (gap <= 10) return schedules;
  // Monthly and twice-a-month paydays are on, or up to 3 days after, the days money landed.
  const monthDays = new Set<number>();
  for (const day of days) {
    const d = parseDate(day.date).d;
    for (let k = 0; k <= 3; k++) monthDays.add(Math.min(31, d + k));
    if (d >= 27) monthDays.add(31);
  }
  const sorted = [...monthDays].sort((a, b) => a - b);
  const last = days[days.length - 1]!.date;
  // Monthly keeps its day of month in the anchor, so anchor on a 31-day month.
  if (gap >= 21) {
    for (const d of sorted) schedules.push({ frequency: 'monthly', anchorDate: `2026-01-${String(d).padStart(2, '0')}` });
    return schedules;
  }
  for (const d1 of sorted) {
    if (d1 > 20) break;
    for (const d2 of sorted) {
      if (d2 >= d1 + 10) schedules.push({ frequency: 'semimonthly', anchorDate: last, semimonthlyDays: [d1, d2] });
    }
  }
  return schedules;
}

/** The latest date on or before `date` that falls on this day of the month (so the 31st stays the 31st). */
function latestDayOfMonth(date: ISODate, day: number): ISODate {
  for (let month = monthOf(date), guard = 0; guard < 12; month = addMonths(month, -1), guard++) {
    const candidate = clampDay(month, day);
    if (parseDate(candidate).d === day && candidate <= addDays(date, 3)) return candidate;
  }
  return clampDay(monthOf(date), day);
}

/**
 * Two paychecks with the same description (one payroll company, two jobs) come apart by amount.
 * A jump of more than 40% starts a new series; overtime and raises stay in the same one.
 */
function byAmount(days: readonly Payday[]): Payday[][] {
  const sorted = [...days].sort((a, b) => a.amountCents - b.amountCents);
  const groups: Payday[][] = [];
  let previous = 0;
  for (const day of sorted) {
    if (!groups.length || day.amountCents > previous * 1.4) groups.push([]);
    groups[groups.length - 1]!.push(day);
    previous = day.amountCents;
  }
  return groups;
}

/** Fewer paydays first: with an equal fit, the simpler schedule is the right one. */
const SIMPLER: Record<PayFrequency, number> = { monthly: 0, semimonthly: 1, biweekly: 2, weekly: 3 };

/** The words in these deposits' descriptions that every one of them shares, for matchPaycheck. */
function matchTextFor(merchant: string, rows: readonly DepositInput[]): string | null {
  const texts = rows.map((r) => normalizeText(`${r.name} ${r.merchantName ?? ''}`));
  const words = merchant.split(' ').filter(Boolean);
  for (let n = words.length; n > 0; n--) {
    const candidate = words.slice(0, n).join(' ');
    if (candidate.length >= 4 && texts.every((t) => t.includes(candidate))) return candidate;
  }
  return null;
}

/**
 * Finds paychecks in deposit history: the same payer, a steady amount, on a schedule the
 * app can forecast (weekly, every two weeks, twice a month, or monthly). Each suggestion
 * is checked with the same code that later recognizes paychecks, so adding it just works.
 */
export function findPaychecks(deposits: readonly DepositInput[], { today }: { today: ISODate }): PaycheckSuggestion[] {
  // Group by the description, not Plaid's merchant: two employers paying through Gusto both show as "Gusto".
  const groups = new Map<string, DepositInput[]>();
  for (const d of deposits) {
    const key = normalizeMerchant(d.name) || d.merchant;
    if (!key || d.amountCents < MIN_PAYCHECK_CENTS) continue;
    const list = groups.get(key) ?? [];
    list.push(d);
    groups.set(key, list);
  }

  const series: { merchant: string; days: Payday[] }[] = [];
  for (const [merchant, rows] of groups) {
    for (const days of byAmount(paydaysOf(rows))) series.push({ merchant, days: days.sort((a, b) => a.n - b.n) });
  }

  const suggestions: PaycheckSuggestion[] = [];
  for (const { merchant, days } of series) {
    const rows = days.flatMap((d) => d.rows);
    if (days.length < 3) continue;
    const firstDate = days[0]!.date;
    const lastDate = days[days.length - 1]!.date;
    const span = diffDays(lastDate, firstDate);
    if (span < 7 * (MIN_WEEKLY_PAYDAYS - 1)) continue;

    // Best fit wins; then the paydays closest to when the money actually lands; then the simpler schedule.
    let best: { schedule: PaySchedule; score: number; drift: number } | null = null;
    for (const schedule of candidates(days)) {
      const { score, drift } = fit(schedule, days);
      const better =
        !best ||
        score > best.score + 1e-9 ||
        (Math.abs(score - best.score) < 1e-9 &&
          (drift < best.drift || (drift === best.drift && SIMPLER[schedule.frequency] < SIMPLER[best.schedule.frequency])));
      if (better) best = { schedule, score, drift };
      // Every deposit on its payday: nothing later in the list can beat it.
      if (best?.score === 1 && best.drift === 0) break;
    }
    if (!best || best.score < MIN_FIT) continue;
    const { schedule } = best;
    if (schedule.frequency === 'weekly' ? days.length < MIN_WEEKLY_PAYDAYS : span < MIN_SPAN_DAYS) continue;
    if (diffDays(today, lastDate) > CYCLE_DAYS[schedule.frequency] * 2 + 5) continue;

    const recent = days.slice(-6).map((d) => d.amountCents);
    const netPayCents = median(recent);
    const steady = days.filter((d) => Math.abs(d.amountCents - netPayCents) <= netPayCents * 0.3).length / days.length;
    if (steady < 0.6) continue;

    const matchText = matchTextFor(merchant, rows);
    if (!matchText) continue;

    // Anchor on the latest real payday, so the form shows a date people recognize.
    const anchorDate =
      schedule.frequency === 'monthly'
        ? latestDayOfMonth(lastDate, parseDate(schedule.anchorDate).d)
        : schedule.frequency === 'semimonthly'
          ? lastDate
          : (nearestPayDate(schedule, lastDate, 3) ?? lastDate);
    const final: PaySchedule = { ...schedule, anchorDate };

    const accounts = new Set(rows.map((r) => r.accountId));
    const split = days.some((d) => d.accountIds.size > 1);
    const accountId = !split && accounts.size === 1 ? [...accounts][0]! : null;

    // The saved source must recognize these deposits the same way it will recognize new ones.
    const source = { id: 0, matchText, accountId, schedule: final };
    const recognized = days.filter((d) => d.rows.some((r) => matchPaycheck([source], r) !== null)).length / days.length;
    if (recognized < MIN_FIT) continue;

    const income = rows.filter((r) => (r.plaidCategory ?? '').startsWith('INCOME')).length / rows.length;
    const confidence = Math.min(1, best.score * Math.min(1, days.length / 6) * steady + (income > 0.5 ? 0.1 : 0));
    suggestions.push({
      merchant,
      matchText,
      frequency: final.frequency,
      anchorDate,
      semimonthlyDays: final.semimonthlyDays ?? null,
      netPayCents,
      accountId,
      deposits: days.length,
      firstDate,
      lastDate,
      nextDate: payDatesBetween(final, addDays(today, 1), addDays(today, 45))[0] ?? null,
      confidence: Math.round(confidence * 100) / 100,
    });
  }
  return suggestions.sort((a, b) => b.confidence - a.confidence || b.netPayCents - a.netPayCents);
}
