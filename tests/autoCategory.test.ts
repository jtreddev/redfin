import { describe, expect, it } from 'vitest';
import { categorize, type AutoContext, type AutoSubject, type CategoryRef } from '../src/shared/autoCategory';
import { bankCategory } from '../src/shared/bankCategories';
import { builtinCategory } from '../src/shared/builtinRules';
import { normalizeMerchant, ruleMatches, type Rule } from '../src/shared/rules';

const REFS: CategoryRef[] = [
  ['Bills', 'Housing'],
  ['Bills', 'Utilities'],
  ['Bills', 'Phone'],
  ['Bills', 'Internet'],
  ['Bills', 'Insurance'],
  ['Bills', 'Loans'],
  ['Bills', 'Subscriptions'],
  ['Bills', 'Childcare'],
  ['Everyday', 'Groceries'],
  ['Everyday', 'Gas'],
  ['Everyday', 'Car Upkeep'],
  ['Everyday', 'Household & Personal'],
  ['Everyday', 'Medical'],
  ['Everyday', 'Kids'],
  ['Habits', 'Habits'],
  ['Habits', 'Coffee & Fast Food'],
  ['Fun & Wants', 'Eating Out'],
  ['Fun & Wants', 'Shopping'],
  ['Fun & Wants', 'Entertainment'],
  ['Fun & Wants', 'Gifts'],
  ['Saving', 'Savings & Planned Costs'],
  ['Income', 'Paychecks'],
  ['Income', 'Other Income'],
  ['Income', 'Refunds'],
  ['Transfers', 'Transfers'],
];
const ID = new Map(REFS.map((ref, i) => [`${ref[0]}|${ref[1]}`, i + 1]));
const id = (section: string, name: string) => ID.get(`${section}|${name}`) ?? null;

function ctx(extra: Partial<AutoContext> = {}): AutoContext {
  return { rules: [], bills: [], cutoffCents: 2500, categoryIdOf: (ref) => id(ref[0], ref[1]), ...extra };
}

function txn(name: string, amountCents: number, extra: Partial<AutoSubject> = {}): AutoSubject {
  return {
    name,
    merchantName: null,
    merchant: normalizeMerchant(name),
    accountId: 1,
    amountCents,
    bankDetailed: null,
    bankPrimary: null,
    ...extra,
  };
}

function rule(matchText: string, categoryId: number | null, extra: Partial<Rule> = {}): Rule {
  return { id: 7, position: 1, matchField: 'any', matchText, action: { categoryId }, ...extra };
}

describe('categorize', () => {
  it('gas station under the cutoff is Habits', () => {
    expect(categorize(txn('SHELL OIL 57444', -2499), ctx())).toMatchObject({
      categoryId: id('Habits', 'Habits'),
      source: 'auto',
      ruleId: null,
      reason: 'Under $25 at a gas station',
    });
    expect(categorize(txn('SHELL OIL 57444', -2500), ctx())).toMatchObject({
      categoryId: id('Everyday', 'Gas'),
      source: 'auto',
      reason: 'Gas station',
    });
  });

  it('bank gas category counts as a gas station', () => {
    const result = categorize(txn('ACME FUEL STOP 99812', -1200, { bankDetailed: 'TRANSPORTATION_GAS', bankPrimary: 'TRANSPORTATION' }), ctx());
    expect(result).toMatchObject({ categoryId: id('Habits', 'Habits'), reason: 'Under $25 at a gas station' });
  });

  it('known names', () => {
    const cases: [string, string, string][] = [
      ['NETFLIX.COM', 'Bills', 'Subscriptions'],
      ['ROCKET MORTGAGE', 'Bills', 'Housing'],
      ['AIDVANTAGE', 'Bills', 'Loans'],
      ['GEICO', 'Bills', 'Insurance'],
      ['T MOBILE', 'Bills', 'Phone'],
      ['XFINITY', 'Bills', 'Internet'],
    ];
    for (const [name, section, category] of cases) {
      const result = categorize(txn(name, -5000), ctx());
      expect(result.categoryId, name).toBe(id(section, category));
      expect(result.source, name).toBe('auto');
    }
  });

  // Older charges only have the bank's primary category (FOOD_AND_DRINK, GENERAL_MERCHANDISE, OTHER),
  // and CSV imports have none, so well-known chains are named here.
  it('known chains beat a vague bank category', () => {
    const cases: [string, string | null, string, string][] = [
      ["MCDONALD'S F12345 SPRINGFIELD IL", 'FOOD_AND_DRINK', 'Habits', 'Coffee & Fast Food'],
      ['MCDONALDS 4521', 'FOOD_AND_DRINK', 'Habits', 'Coffee & Fast Food'],
      ['TACO BELL #031234', 'FOOD_AND_DRINK', 'Habits', 'Coffee & Fast Food'],
      ["CULVER'S OF ANYTOWN", 'FOOD_AND_DRINK', 'Habits', 'Coffee & Fast Food'],
      ['LITTLE CAESARS 1234-0001', 'FOOD_AND_DRINK', 'Habits', 'Coffee & Fast Food'],
      ['PIZZA HUT 012345', 'FOOD_AND_DRINK', 'Habits', 'Coffee & Fast Food'],
      ['WENDYS #4410', 'FOOD_AND_DRINK', 'Habits', 'Coffee & Fast Food'],
      ['STARBUCKS STORE 01234', 'FOOD_AND_DRINK', 'Habits', 'Coffee & Fast Food'],
      ['DUNKIN #348812', 'FOOD_AND_DRINK', 'Habits', 'Coffee & Fast Food'],
      ['TST* MAPLE STREET COFFEE', 'FOOD_AND_DRINK', 'Habits', 'Coffee & Fast Food'],
      ['ALDI 72034 ANYTOWN IL', 'FOOD_AND_DRINK', 'Everyday', 'Groceries'],
      ['KROGER #0412', 'FOOD_AND_DRINK', 'Everyday', 'Groceries'],
      ['HY-VEE ANYTOWN 1234', 'FOOD_AND_DRINK', 'Everyday', 'Groceries'],
      ['MAIN ST LIQUOR', 'FOOD_AND_DRINK', 'Habits', 'Habits'],
      ['PETSMART # 1234', 'GENERAL_MERCHANDISE', 'Everyday', 'Household & Personal'],
      ['CHEWY.COM', 'GENERAL_MERCHANDISE', 'Everyday', 'Household & Personal'],
      ['PRAIRIE ANIMAL HOSPITAL', 'MEDICAL', 'Everyday', 'Household & Personal'],
      ['CLAUDE.AI ANTHROPIC', 'OTHER', 'Bills', 'Subscriptions'],
      ['OPENAI *CHATGPT SUBSCR', null, 'Bills', 'Subscriptions'],
      ['AMAZON KIDS+', 'OTHER', 'Bills', 'Subscriptions'],
    ];
    for (const [name, bankPrimary, section, category] of cases) {
      const result = categorize(txn(name, -1899, { bankPrimary }), ctx());
      expect(result.categoryId, `${name} → ${normalizeMerchant(name)}`).toBe(id(section, category));
      expect(result.reason, name).toMatch(/^Looks like/);
    }
    // Whole words only.
    expect(categorize(txn('ALDISTRA DESIGN', -1899), ctx()).categoryId).toBeNull();
    // Refunds aren't habits.
    expect(categorize(txn('STARBUCKS STORE 01234', 500, { bankPrimary: 'FOOD_AND_DRINK' }), ctx()).categoryId).toBe(id('Fun & Wants', 'Eating Out'));
  });

  it('bank detailed then primary', () => {
    expect(categorize(txn('BURGER PALACE', -900, { bankDetailed: 'FOOD_AND_DRINK_FAST_FOOD', bankPrimary: 'FOOD_AND_DRINK' }), ctx())).toMatchObject({
      categoryId: id('Habits', 'Coffee & Fast Food'),
      source: 'auto',
      reason: 'Bank says: fast food',
    });
    expect(categorize(txn('BISTRO NINE', -4200, { bankDetailed: 'FOOD_AND_DRINK_SOMETHING_NEW', bankPrimary: 'FOOD_AND_DRINK' }), ctx()).categoryId).toBe(
      id('Fun & Wants', 'Eating Out'),
    );
    expect(categorize(txn('CHASE CARD PAYMENT', -30000, { bankDetailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', bankPrimary: 'LOAN_PAYMENTS' }), ctx()).categoryId).toBe(
      id('Transfers', 'Transfers'),
    );
    expect(categorize(txn('ACME CORP PAYROLL', 250000, { bankDetailed: 'INCOME_WAGES', bankPrimary: 'INCOME' }), ctx()).categoryId).toBe(id('Income', 'Paychecks'));
  });

  it('rules beat bills beat built-in beat bank', () => {
    const subject = txn('NETFLIX.COM', -1549, { bankDetailed: 'ENTERTAINMENT_TV_AND_MOVIES', bankPrimary: 'ENTERTAINMENT' });
    const myRule = rule('NETFLIX', id('Fun & Wants', 'Gifts'));
    const bill = { merchant: 'NETFLIX COM', cents: -1549, categoryId: id('Everyday', 'Kids'), name: 'Netflix' };

    expect(categorize(subject, ctx({ rules: [myRule], bills: [bill] }))).toMatchObject({
      categoryId: id('Fun & Wants', 'Gifts'),
      ruleId: 7,
      source: 'rule',
      reason: 'Your rule: NETFLIX',
    });
    expect(categorize(subject, ctx({ bills: [bill] }))).toMatchObject({
      categoryId: id('Everyday', 'Kids'),
      ruleId: null,
      source: 'auto',
      reason: 'Matches your bill Netflix',
    });
    expect(categorize(subject, ctx()).categoryId).toBe(id('Bills', 'Subscriptions'));
    const unknown = { ...subject, name: 'STREAMCO', merchant: 'STREAMCO' };
    expect(categorize(unknown, ctx())).toMatchObject({ categoryId: id('Fun & Wants', 'Entertainment'), reason: 'Bank says: tv and movies' });
  });

  it('bills match the "$N" variant key but not a far-off amount', () => {
    const bill = { merchant: 'NETFLIX COM $23', cents: -2299, categoryId: id('Everyday', 'Kids'), name: 'Netflix 4K' };
    expect(categorize(txn('NETFLIX.COM', -2299), ctx({ bills: [bill] })).reason).toBe('Matches your bill Netflix 4K');
    expect(categorize(txn('NETFLIX.COM', -999), ctx({ bills: [bill] })).categoryId).toBe(id('Bills', 'Subscriptions'));
  });

  it('with two bills from one merchant, the closest amount wins', () => {
    const basic = { merchant: 'NETFLIX COM', cents: -1549, categoryId: id('Bills', 'Subscriptions'), name: 'Netflix' };
    const premium = { merchant: 'NETFLIX COM $23', cents: -2299, categoryId: id('Everyday', 'Kids'), name: 'Netflix 4K' };
    expect(categorize(txn('NETFLIX.COM', -2299), ctx({ bills: [basic, premium] })).reason).toBe('Matches your bill Netflix 4K');
    expect(categorize(txn('NETFLIX.COM', -1549), ctx({ bills: [premium, basic] })).reason).toBe('Matches your bill Netflix');
  });

  it('learned rule amount range', () => {
    const learned = rule('SHELL', id('Habits', 'Habits'), { amountMin: 2500, amountMax: 6000, learned: true });
    expect(categorize(txn('SHELL OIL 57444', -4000), ctx({ rules: [learned] }))).toMatchObject({
      categoryId: id('Habits', 'Habits'),
      source: 'rule',
      ruleId: 7,
      reason: 'Learned from your fix',
    });
    expect(categorize(txn('SHELL OIL 57444', -1000), ctx({ rules: [learned] })).source).toBe('auto');
    expect(categorize(txn('SHELL OIL 57444', -7000), ctx({ rules: [learned] }))).toMatchObject({ source: 'auto', categoryId: id('Everyday', 'Gas') });
  });

  it("refunds don't hit spending rules", () => {
    const shell = txn('SHELL OIL 57444', 1500, { bankDetailed: 'GENERAL_MERCHANDISE_SUPERSTORES', bankPrimary: 'GENERAL_MERCHANDISE' });
    expect(categorize(shell, ctx())).toMatchObject({ categoryId: id('Fun & Wants', 'Shopping'), reason: 'Bank says: superstores' });
    const netflix = txn('NETFLIX.COM', 1549, { bankDetailed: 'ENTERTAINMENT_TV_AND_MOVIES', bankPrimary: 'ENTERTAINMENT' });
    const bill = { merchant: 'NETFLIX COM', cents: -1549, categoryId: id('Everyday', 'Kids'), name: 'Netflix' };
    expect(categorize(netflix, ctx({ bills: [bill] }))).toMatchObject({ categoryId: id('Fun & Wants', 'Entertainment'), reason: 'Bank says: tv and movies' });
  });

  it('nothing matches', () => {
    expect(categorize(txn('MYSTERY VENDOR', -1234), ctx())).toEqual({ categoryId: null, ruleId: null, source: null, reason: null });
  });

  it('a layer whose category is missing falls through', () => {
    const noSubscriptions: AutoContext['categoryIdOf'] = (ref) => (ref[1] === 'Subscriptions' ? null : id(ref[0], ref[1]));
    const subject = txn('NETFLIX.COM', -1549, { bankPrimary: 'ENTERTAINMENT' });
    expect(categorize(subject, ctx({ categoryIdOf: noSubscriptions })).categoryId).toBe(id('Fun & Wants', 'Entertainment'));
  });
});

describe('ruleMatches amount range', () => {
  const base = rule('SHELL', 1);
  const subject = { name: 'SHELL OIL', accountId: 1 };
  it('ignores amounts when the rule has no bounds', () => {
    expect(ruleMatches(base, { ...subject, amountCents: -100 })).toBe(true);
  });
  it('is inclusive, uses absolute cents, and treats null as unbounded', () => {
    const ranged = { ...base, amountMin: 2500, amountMax: null };
    expect(ruleMatches(ranged, { ...subject, amountCents: -2500 })).toBe(true);
    expect(ruleMatches(ranged, { ...subject, amountCents: -2499 })).toBe(false);
    expect(ruleMatches(ranged, { ...subject, amountCents: -999999 })).toBe(true);
    expect(ruleMatches({ ...base, amountMax: 6000 }, { ...subject, amountCents: 6000 })).toBe(true);
    expect(ruleMatches({ ...base, amountMax: 6000 }, { ...subject, amountCents: -6001 })).toBe(false);
  });
  it('matches on text alone when the subject has no amount', () => {
    expect(ruleMatches({ ...base, amountMin: 2500, amountMax: 6000 }, subject)).toBe(true);
  });
});

describe('builtin and bank tables', () => {
  it('gas station list uses whole words', () => {
    expect(builtinCategory({ merchant: 'BP', amountCents: -4000, bankDetailed: null }, 2500)?.ref).toEqual(['Everyday', 'Gas']);
    expect(builtinCategory({ merchant: 'BPX HOLDINGS', amountCents: -4000, bankDetailed: null }, 2500)).toBeNull();
    expect(builtinCategory({ merchant: 'ELEVEN', amountCents: -800, bankDetailed: null }, 2500)?.ref).toEqual(['Habits', 'Habits']);
  });
  it('bank map covers every primary', () => {
    const primaries = [
      'INCOME', 'TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS', 'BANK_FEES', 'ENTERTAINMENT', 'FOOD_AND_DRINK', 'GENERAL_MERCHANDISE',
      'HOME_IMPROVEMENT', 'MEDICAL', 'PERSONAL_CARE', 'GENERAL_SERVICES', 'GOVERNMENT_AND_NON_PROFIT', 'TRANSPORTATION', 'TRAVEL', 'RENT_AND_UTILITIES',
    ];
    for (const p of primaries) {
      const hit = bankCategory(null, p);
      expect(hit, p).not.toBeNull();
      expect(ID.has(`${hit?.ref[0]}|${hit?.ref[1]}`), p).toBe(true);
    }
    expect(bankCategory('RENT_AND_UTILITIES_TELEPHONE', 'RENT_AND_UTILITIES')).toEqual({ ref: ['Bills', 'Phone'], label: 'telephone' });
    expect(bankCategory('MEDICAL_PHARMACIES_AND_SUPPLEMENTS', null)?.ref).toEqual(['Everyday', 'Medical']);
    expect(bankCategory(null, null)).toBeNull();
    expect(bankCategory('SOMETHING_ELSE', 'NOPE')).toBeNull();
  });
});
