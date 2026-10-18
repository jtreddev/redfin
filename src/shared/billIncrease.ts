import type { ISODate } from './dates';
import type { Cents } from './money';
import { sameBill } from './recurring';

/** How far back the latest charge is looked for. */
export const INCREASE_WINDOW_DAYS = 45;
/** A bill went up when its latest charge is at least this much more than usual… */
export const INCREASE_MIN_CENTS = 500;
/** …and at least 1/this more (10%). */
export const INCREASE_MIN_PART = 10;

export interface IncreaseBill {
  id: number;
  /** The bill key: a normalized merchant, or "MERCHANT $9" for a second subscription from the same place. */
  merchant: string;
  /** Signed, negative for bills. */
  expectedAmountCents: Cents;
  /** The latest charge (positive) when the last increase was dismissed or taken as the new usual. */
  increaseSeenCents: Cents | null;
  privateMemberId: number | null;
}

export interface IncreaseCharge {
  id: number;
  date: ISODate;
  merchant: string;
  /** Signed, negative for money out. */
  amountCents: Cents;
  privateMemberId: number | null;
}

export interface BillIncrease {
  billId: number;
  usualCents: Cents;
  latestCents: Cents;
  date: ISODate;
}

/** The merchant a bill key stands for: "APPLE COM BILL $1" → "APPLE COM BILL". */
export const billMerchant = (key: string) => key.replace(/ \$\d+$/, '');

/** At least $5 and at least 10% more than usual (whole cents, so $4.99 and 9.9% stay out). */
export function wentUp(usualCents: Cents, latestCents: Cents): boolean {
  const diff = latestCents - usualCents;
  return diff >= INCREASE_MIN_CENTS && diff * INCREASE_MIN_PART >= usualCents;
}

/**
 * Bills whose latest charge went up. Each charge belongs to the closest bill in amount from its merchant
 * (within `sameBill`), shared or private the same way as the charge, so a partner's fun money charge never
 * flags a shared bill. Only the latest charge counts; one already dismissed (or taken) at that size or more
 * stays quiet until a bigger one comes. Pass charges from the last 45 days.
 */
export function billIncreases(bills: readonly IncreaseBill[], charges: readonly IncreaseCharge[]): BillIncrease[] {
  const byMerchant = new Map<string, IncreaseBill[]>();
  for (const b of bills) {
    const key = `${billMerchant(b.merchant)}|${b.privateMemberId ?? ''}`;
    byMerchant.set(key, [...(byMerchant.get(key) ?? []), b]);
  }
  const latest = new Map<number, IncreaseCharge>();
  const newestFirst = [...charges].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  for (const t of newestFirst) {
    if (t.amountCents >= 0) continue;
    const candidates = (byMerchant.get(`${t.merchant}|${t.privateMemberId ?? ''}`) ?? []).filter((b) => sameBill(b.expectedAmountCents, t.amountCents));
    if (!candidates.length) continue;
    const distance = (b: IncreaseBill) => Math.abs(Math.abs(b.expectedAmountCents) - Math.abs(t.amountCents));
    const bill = candidates.reduce((best, b) => (distance(b) < distance(best) ? b : best));
    if (!latest.has(bill.id)) latest.set(bill.id, t);
  }
  const found: BillIncrease[] = [];
  for (const b of bills) {
    const t = latest.get(b.id);
    if (!t) continue;
    const usualCents = Math.abs(b.expectedAmountCents);
    const latestCents = Math.abs(t.amountCents);
    if (!wentUp(usualCents, latestCents)) continue;
    if (b.increaseSeenCents !== null && latestCents <= b.increaseSeenCents) continue;
    found.push({ billId: b.id, usualCents, latestCents, date: t.date });
  }
  return found;
}
