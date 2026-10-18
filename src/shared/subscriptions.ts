import { CORE_BILLS } from './categorySet';
import type { Cents } from './money';

export interface SubscriptionCandidate {
  status: string;
  cadence: string;
  /** Signed, negative for bills. */
  expectedAmountCents: Cents;
  categoryName: string | null;
  /** The category's parent, for a sub-category. */
  parentCategoryName: string | null;
}

/** The most a subscription can cost a month (a yearly charge counts as a twelfth). */
export const SUBSCRIPTION_MAX_CENTS = 5000;
const CORE = new Set<string>(CORE_BILLS);

/**
 * Subscriptions: confirmed bills charged monthly or yearly, $50 or less a month (a yearly charge counts as a twelfth), outside the core household
 * bills (housing, utilities, phone, internet, insurance, loans, childcare). A bill with no category counts.
 */
export function isSubscription(bill: SubscriptionCandidate): boolean {
  if (bill.status !== 'confirmed') return false;
  if (bill.cadence !== 'monthly' && bill.cadence !== 'yearly') return false;
  if (subscriptionCost(bill).monthCents > SUBSCRIPTION_MAX_CENTS) return false;
  return !CORE.has(bill.categoryName ?? '') && !CORE.has(bill.parentCategoryName ?? '');
}

/** What a subscription costs a month and a year (positive cents); a yearly one's month is a twelfth, rounded. */
export function subscriptionCost(bill: { cadence: string; expectedAmountCents: Cents }) {
  const charge = Math.abs(bill.expectedAmountCents);
  return bill.cadence === 'yearly' ? { monthCents: Math.round(charge / 12), yearCents: charge } : { monthCents: charge, yearCents: charge * 12 };
}
