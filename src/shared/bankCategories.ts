import type { CategoryRef } from './autoCategory';

/**
 * Plaid's personal_finance_category (v1) → our categories. The detailed value wins; an unknown
 * detailed value falls back to its primary. Detailed values are PRIMARY_SUBTYPE.
 */
const BILLS = 'Bills';
const EVERYDAY = 'Everyday';
const HABITS = 'Habits';
const FUN = 'Fun & Wants';
const INCOME = 'Income';

const HOUSING: CategoryRef = [BILLS, 'Housing'];
const UTILITIES: CategoryRef = [BILLS, 'Utilities'];
const PHONE: CategoryRef = [BILLS, 'Phone'];
const INTERNET: CategoryRef = [BILLS, 'Internet'];
const INSURANCE: CategoryRef = [BILLS, 'Insurance'];
const LOANS: CategoryRef = [BILLS, 'Loans'];
const SUBSCRIPTIONS: CategoryRef = [BILLS, 'Subscriptions'];
const CHILDCARE: CategoryRef = [BILLS, 'Childcare'];
const GROCERIES: CategoryRef = [EVERYDAY, 'Groceries'];
const GAS: CategoryRef = [EVERYDAY, 'Gas'];
const CAR_UPKEEP: CategoryRef = [EVERYDAY, 'Car Upkeep'];
const HOUSEHOLD: CategoryRef = [EVERYDAY, 'Household & Personal'];
const MEDICAL: CategoryRef = [EVERYDAY, 'Medical'];
const HABIT: CategoryRef = [HABITS, 'Habits'];
const COFFEE_FAST_FOOD: CategoryRef = [HABITS, 'Coffee & Fast Food'];
const EATING_OUT: CategoryRef = [FUN, 'Eating Out'];
const SHOPPING: CategoryRef = [FUN, 'Shopping'];
const ENTERTAINMENT: CategoryRef = [FUN, 'Entertainment'];
const GIFTS: CategoryRef = [FUN, 'Gifts'];
const PAYCHECKS: CategoryRef = [INCOME, 'Paychecks'];
const OTHER_INCOME: CategoryRef = [INCOME, 'Other Income'];
const TRANSFERS: CategoryRef = ['Transfers', 'Transfers'];

const PRIMARY: Record<string, CategoryRef> = {
  INCOME: OTHER_INCOME,
  TRANSFER_IN: TRANSFERS,
  TRANSFER_OUT: TRANSFERS,
  LOAN_PAYMENTS: LOANS,
  BANK_FEES: HOUSEHOLD,
  ENTERTAINMENT: ENTERTAINMENT,
  FOOD_AND_DRINK: EATING_OUT,
  GENERAL_MERCHANDISE: SHOPPING,
  HOME_IMPROVEMENT: HOUSEHOLD,
  MEDICAL: MEDICAL,
  PERSONAL_CARE: HOUSEHOLD,
  GENERAL_SERVICES: HOUSEHOLD,
  GOVERNMENT_AND_NON_PROFIT: HOUSEHOLD,
  TRANSPORTATION: CAR_UPKEEP,
  TRAVEL: ENTERTAINMENT,
  RENT_AND_UTILITIES: UTILITIES,
};

/** Only the detailed values that differ from their primary's category. */
const DETAILED: Record<string, CategoryRef> = {
  INCOME_WAGES: PAYCHECKS,
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: TRANSFERS,
  LOAN_PAYMENTS_MORTGAGE_PAYMENT: HOUSING,
  ENTERTAINMENT_CASINOS_AND_GAMBLING: HABIT,
  FOOD_AND_DRINK_GROCERIES: GROCERIES,
  FOOD_AND_DRINK_FAST_FOOD: COFFEE_FAST_FOOD,
  FOOD_AND_DRINK_COFFEE: COFFEE_FAST_FOOD,
  FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR: HABIT,
  FOOD_AND_DRINK_VENDING_MACHINES: HABIT,
  GENERAL_MERCHANDISE_CONVENIENCE_STORES: HABIT,
  GENERAL_MERCHANDISE_TOBACCO_AND_VAPE: HABIT,
  GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES: GIFTS,
  GENERAL_MERCHANDISE_PET_SUPPLIES: HOUSEHOLD,
  MEDICAL_VETERINARY_SERVICES: HOUSEHOLD,
  PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: SUBSCRIPTIONS,
  GENERAL_SERVICES_AUTOMOTIVE: CAR_UPKEEP,
  GENERAL_SERVICES_CHILDCARE: CHILDCARE,
  GENERAL_SERVICES_INSURANCE: INSURANCE,
  GOVERNMENT_AND_NON_PROFIT_DONATIONS: GIFTS,
  TRANSPORTATION_GAS: GAS,
  RENT_AND_UTILITIES_RENT: HOUSING,
  RENT_AND_UTILITIES_TELEPHONE: PHONE,
  RENT_AND_UTILITIES_INTERNET_AND_CABLE: INTERNET,
};

/** "FOOD_AND_DRINK_FAST_FOOD" under "FOOD_AND_DRINK" → "fast food". */
function label(value: string, primary: string | null): string {
  const rest = primary && value.startsWith(`${primary}_`) ? value.slice(primary.length + 1) : value;
  return rest.toLowerCase().replace(/_/g, ' ');
}

/** The primary a detailed value belongs to, for when only the detailed value is stored. */
const primaryOf = (detailed: string) => Object.keys(PRIMARY).find((p) => detailed.startsWith(`${p}_`)) ?? null;

export function bankCategory(
  detailed: string | null | undefined,
  primary: string | null | undefined,
): { ref: CategoryRef; label: string } | null {
  const top = primary || (detailed ? primaryOf(detailed) : null);
  if (detailed) {
    const ref = DETAILED[detailed] ?? (top && detailed.startsWith(`${top}_`) ? PRIMARY[top] : undefined);
    if (ref) return { ref, label: label(detailed, top) };
  }
  if (top && PRIMARY[top]) return { ref: PRIMARY[top], label: label(top, null) };
  return null;
}
