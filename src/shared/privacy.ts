import type { ISODate } from './dates';
import type { Cents } from './money';

/**
 * Fun money: each spouse's personal allowance. Transactions marked private to a spouse
 * are visible only to that spouse; the other sees just the remaining total.
 * The server enforces this with PRIVACY_SQL on every transaction read.
 */
export interface PrivacyTagged {
  privateMemberId: number | null;
}

export function canView(row: PrivacyTagged, viewerMemberId: number): boolean {
  return row.privateMemberId == null || row.privateMemberId === viewerMemberId;
}

export function visibleTo<T extends PrivacyTagged>(rows: readonly T[], viewerMemberId: number): T[] {
  return rows.filter((row) => canView(row, viewerMemberId));
}

/** WHERE fragment for the transactions table; bind the viewer's member id. */
export const PRIVACY_SQL = '(t.private_member_id IS NULL OR t.private_member_id = ?)';

export interface FunMoneyInput {
  allowancePerPaydayCents: Cents;
  /** Household paydays. */
  payDates: readonly ISODate[];
  /** Allowances start building from this date. */
  startDate: ISODate;
  today: ISODate;
  /** Positive total spent from this person's fun money since startDate. */
  spentCents: Cents;
  /** One-off top-ups (+) or corrections (−). */
  adjustmentsCents?: Cents;
}

export interface FunMoneyBalance {
  accruedCents: Cents;
  spentCents: Cents;
  balanceCents: Cents;
  paydaysCounted: number;
}

/** Allowances build up every payday and carry over month to month. */
export function funMoneyBalance(input: FunMoneyInput): FunMoneyBalance {
  const paydaysCounted = new Set(
    input.payDates.filter((d) => d >= input.startDate && d <= input.today),
  ).size;
  const accruedCents = paydaysCounted * input.allowancePerPaydayCents;
  return {
    accruedCents,
    spentCents: input.spentCents,
    balanceCents: accruedCents - input.spentCents + (input.adjustmentsCents ?? 0),
    paydaysCounted,
  };
}
