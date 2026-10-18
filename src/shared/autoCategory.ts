import { bankCategory } from './bankCategories';
import { builtinCategory } from './builtinRules';
import { sameBill } from './recurring';
import { findRule, type Rule, type RuleAction } from './rules';

/**
 * Picks a category for a charge nobody filed by hand. Layers, first match wins: your rules (learned
 * ones included), your saved bills, built-in patterns, then the bank's own category.
 */

/** A category by (group, name), so tables don't depend on database ids. */
export type CategoryRef = readonly [section: string, name: string];

export interface AutoContext {
  rules: readonly Rule[];
  /**
   * Confirmed bills: merchant key, signed expected amount, the category they're filed under, and whose
   * private bill it is (null = shared).
   */
  bills: readonly AutoBill[];
  /** Gas station charges under this are Habits. */
  cutoffCents: number;
  categoryIdOf: (ref: CategoryRef) => number | null;
}

export interface AutoBill {
  merchant: string;
  cents: number;
  categoryId: number | null;
  name: string;
  privateMemberId?: number | null;
}

export interface AutoSubject {
  name: string;
  merchantName: string | null;
  /** Normalized merchant key (see normalizeMerchant). */
  merchant: string;
  accountId: number;
  amountCents: number;
  bankDetailed: string | null;
  bankPrimary: string | null;
  /** The member whose personal card the charge is on, or null for a shared account. */
  accountOwner?: number | null;
}

export interface AutoResult {
  categoryId: number | null;
  ruleId: number | null;
  source: 'rule' | 'auto' | null;
  reason: string | null;
  /** The matched rule's whole action (kid, privacy, ignore), for the caller to apply. */
  action?: RuleAction;
}

/** Why a charge was filed by a rule the app learned from a fix. */
export const LEARNED_REASON = 'Learned from your fix';

const NONE: AutoResult = { categoryId: null, ruleId: null, source: null, reason: null };

/** The bill's key, or its "MERCHANT $9" variant for a second bill from the same merchant. */
const billKeyMatches = (billMerchant: string, merchant: string) => billMerchant === merchant || billMerchant.startsWith(`${merchant} $`);

/**
 * Bills stay within the right person's accounts, like learned rules: a shared bill files charges on
 * accounts that are nobody's personal card, a private one only charges on its person's personal card.
 */
export const billAppliesToAccount = (bill: AutoBill, accountOwner: number | null) => (bill.privateMemberId ?? null) === accountOwner;

export function categorize(subject: AutoSubject, ctx: AutoContext): AutoResult {
  const rule = findRule(ctx.rules, subject);
  if (rule) {
    return {
      categoryId: rule.action.categoryId ?? null,
      ruleId: rule.id,
      source: 'rule',
      reason: rule.learned ? LEARNED_REASON : `Your rule: ${rule.matchText}`,
      action: rule.action,
    };
  }

  if (subject.amountCents < 0) {
    // Two bills from one merchant (Netflix plans) can both be within range: take the closest amount.
    const gap = (b: { cents: number }) => Math.abs(Math.abs(b.cents) - Math.abs(subject.amountCents));
    const bill = ctx.bills
      .filter((b) => b.categoryId != null && billAppliesToAccount(b, subject.accountOwner ?? null) && billKeyMatches(b.merchant, subject.merchant) && sameBill(b.cents, subject.amountCents))
      .sort((a, b) => gap(a) - gap(b))[0];
    if (bill) return { categoryId: bill.categoryId, ruleId: null, source: 'auto', reason: `Matches your bill ${bill.name}` };
  }

  const builtin = builtinCategory(subject, ctx.cutoffCents);
  const builtinId = builtin && ctx.categoryIdOf(builtin.ref);
  if (builtin && builtinId != null) return { categoryId: builtinId, ruleId: null, source: 'auto', reason: builtin.reason };

  const bank = bankCategory(subject.bankDetailed, subject.bankPrimary);
  const bankId = bank && ctx.categoryIdOf(bank.ref);
  if (bank && bankId != null) return { categoryId: bankId, ruleId: null, source: 'auto', reason: `Bank says: ${bank.label}` };

  return { ...NONE };
}
