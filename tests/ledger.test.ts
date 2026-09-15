import { describe, expect, it } from 'vitest';
import { csvImportKey, findImportedTwin, withOccurrences } from '../src/shared/dedupe';
import { canView, funMoneyBalance, visibleTo } from '../src/shared/privacy';
import { detectRecurring } from '../src/shared/recurring';
import { findRule, normalizeMerchant, rulePatch, suggestRule, type Rule } from '../src/shared/rules';
import { findTransferPairs, pairKey } from '../src/shared/transfers';

describe('merchant normalization', () => {
  it('strips bank noise', () => {
    expect(normalizeMerchant('POS DEBIT 09/04 KROGER #1234 COLUMBUS OH')).toBe('KROGER');
    expect(normalizeMerchant('NETFLIX.COM 866-579-7172 CA')).toBe('NETFLIX COM');
    expect(normalizeMerchant('SQ *JOES COFFEE 1234')).toBe('JOES COFFEE');
    expect(normalizeMerchant('WM SUPERCENTER #1234 COLUMBUS OH')).toBe('WM SUPERCENTER');
    expect(normalizeMerchant('AT&T*BILL PAYMENT 800-331-0500 TX')).toBe('AT&T BILL PAYMENT');
    expect(normalizeMerchant('TARGET 00012345')).toBe('TARGET');
    expect(normalizeMerchant('Spotify USA')).toBe('SPOTIFY USA');
  });
});

describe('rules', () => {
  const rules: Rule[] = [
    { id: 1, position: 20, matchField: 'any', matchText: 'kroger', action: { categoryId: 10 } },
    { id: 2, position: 10, matchField: 'name', matchText: 'RIDGELINE POWER 4471-06119', action: { categoryId: 20 } },
    { id: 3, position: 30, matchField: 'any', matchText: 'RIDGELINE POWER', action: { categoryId: 21 } },
    { id: 4, position: 5, matchField: 'merchant', matchText: 'Sephora', accountId: 9, action: { privateMemberId: 2 } },
    { id: 5, position: 1000, matchField: 'any', matchText: 'REDEMPTION FROM CORE ACCOUNT', action: { ignore: true } },
  ];

  it('first match by position wins', () => {
    expect(findRule(rules, { name: 'RIDGELINE POWER 4471-06119 BILLPAY', accountId: 1 })?.id).toBe(2);
    expect(findRule(rules, { name: 'RIDGELINE POWER 4471-08822 BILLPAY', accountId: 1 })?.id).toBe(3);
    expect(findRule(rules, { name: 'Kroger #512', accountId: 1 })?.id).toBe(1);
  });

  it('respects account scope and merchant field', () => {
    expect(findRule(rules, { name: 'x', merchantName: 'Sephora', accountId: 1 })).toBeNull();
    expect(findRule(rules, { name: 'x', merchantName: 'Sephora', accountId: 9 })?.id).toBe(4);
  });

  it('never overrides a category set by hand', () => {
    expect(rulePatch(rules[0] ?? null, { categorySource: 'user' })).toEqual({});
    expect(rulePatch(rules[0] ?? null, { categorySource: null })).toMatchObject({ categoryId: 10, categorySource: 'rule' });
    expect(rulePatch(rules[4] ?? null, { categorySource: null })).toMatchObject({ isIgnored: true });
  });

  it('suggests rule text from merchant or cleaned name', () => {
    expect(suggestRule({ name: 'POS 09/02 KROGER #512', merchantName: 'Kroger', accountId: 1 })).toEqual({
      matchField: 'merchant',
      matchText: 'Kroger',
    });
    expect(suggestRule({ name: 'POS 09/02 KROGER #512', accountId: 1 }).matchText).toBe('KROGER');
  });
});

describe('transfers', () => {
  it('pairs a card payment across accounts', () => {
    const pairs = findTransferPairs([
      { id: 1, accountId: 1, date: '2026-09-10', amountCents: -25000, name: 'CAPITAL ONE CRCARDPMT' },
      { id: 2, accountId: 2, date: '2026-09-11', amountCents: 25000, name: 'CAPITAL ONE MOBILE PYMT' },
      { id: 3, accountId: 1, date: '2026-09-10', amountCents: -2500, name: 'KROGER' },
    ]);
    expect(pairs).toEqual([{ outId: 1, inId: 2 }]);
  });

  it('does not pair unrelated same-amount rows or rows on one account', () => {
    expect(
      findTransferPairs([
        { id: 1, accountId: 1, date: '2026-09-10', amountCents: -5000, name: 'ATM WITHDRAWAL' },
        { id: 2, accountId: 2, date: '2026-09-10', amountCents: 5000, name: 'VENMO CASHOUT' },
        { id: 3, accountId: 1, date: '2026-09-10', amountCents: 5000, name: 'TRANSFER FROM SAVINGS' },
      ]),
    ).toEqual([]);
  });

  it('picks the closest match and remembers unlinked pairs', () => {
    const rows = [
      { id: 1, accountId: 1, date: '2026-09-10', amountCents: -10000, name: 'Transfer to Fidelity' },
      { id: 2, accountId: 3, date: '2026-09-13', amountCents: 10000, name: 'Deposit' },
      { id: 3, accountId: 3, date: '2026-09-11', amountCents: 10000, name: 'Deposit' },
    ];
    expect(findTransferPairs(rows)).toEqual([{ outId: 1, inId: 3 }]);
    expect(findTransferPairs(rows, { unlinked: new Set([pairKey(3, 1)]) })).toEqual([{ outId: 1, inId: 2 }]);
  });
});

describe('dedupe', () => {
  it('keeps identical same-day purchases distinct but stable across files', () => {
    const file = withOccurrences([
      { date: '2026-09-02', amountCents: -450, name: 'Coffee' },
      { date: '2026-09-02', amountCents: -450, name: 'COFFEE ' },
    ]);
    const keys = file.map((row) => csvImportKey(1, row));
    expect(new Set(keys).size).toBe(2);
    const again = withOccurrences([{ date: '2026-09-02', amountCents: -450, name: 'coffee' }]);
    expect(csvImportKey(1, again[0]!)).toBe(keys[0]);
  });

  it('finds the imported twin of a synced transaction', () => {
    const existing = [
      { id: 1, accountId: 1, date: '2026-09-01', amountCents: -1000 },
      { id: 2, accountId: 1, date: '2026-09-03', amountCents: -1000 },
      { id: 3, accountId: 1, date: '2026-09-03', amountCents: -1000, plaidTxnId: 'abc' },
    ];
    expect(findImportedTwin({ accountId: 1, date: '2026-09-04', amountCents: -1000 }, existing)).toBe(2);
    expect(findImportedTwin({ accountId: 2, date: '2026-09-04', amountCents: -1000 }, existing)).toBeNull();
    expect(findImportedTwin({ accountId: 1, date: '2026-09-04', amountCents: -1000 }, existing, 2, new Set([2]))).toBeNull();
  });
});

describe('recurring bills', () => {
  it('suggests steady monthly charges and skips irregular ones', () => {
    const txns = [
      { id: 1, date: '2026-06-15', amountCents: -1549, merchant: 'NETFLIX COM' },
      { id: 2, date: '2026-07-15', amountCents: -1549, merchant: 'NETFLIX COM' },
      { id: 3, date: '2026-08-15', amountCents: -1649, merchant: 'NETFLIX COM' },
      { id: 4, date: '2026-06-02', amountCents: -16842, merchant: 'KROGER' },
      { id: 5, date: '2026-06-05', amountCents: -4210, merchant: 'KROGER' },
      { id: 6, date: '2026-06-19', amountCents: -9055, merchant: 'KROGER' },
    ];
    const found = detectRecurring(txns, { today: '2026-09-01' });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ merchant: 'NETFLIX COM', cadence: 'monthly', expectedAmountCents: -1549, nextDate: '2026-09-15' });
  });

  it('drops series that stopped', () => {
    const txns = [1, 2, 3].map((m) => ({ id: m, date: `2026-0${m}-10`, amountCents: -999, merchant: 'GYM' }));
    expect(detectRecurring(txns, { today: '2026-09-01' })).toEqual([]);
  });
});

describe('fun money privacy', () => {
  const rows = [
    { id: 1, privateMemberId: null },
    { id: 2, privateMemberId: 1 },
    { id: 3, privateMemberId: 2 },
  ];

  it('hides the other spouse’s private rows', () => {
    expect(visibleTo(rows, 1).map((r) => r.id)).toEqual([1, 2]);
    expect(visibleTo(rows, 2).map((r) => r.id)).toEqual([1, 3]);
    expect(canView({ privateMemberId: 2 }, 1)).toBe(false);
  });

  it('builds up allowance each payday and carries over', () => {
    const balance = funMoneyBalance({
      allowancePerPaydayCents: 2500,
      payDates: ['2026-08-28', '2026-09-04', '2026-09-11', '2026-09-18'],
      startDate: '2026-09-01',
      today: '2026-09-13',
      spentCents: 3200,
    });
    expect(balance).toEqual({ accruedCents: 5000, spentCents: 3200, balanceCents: 1800, paydaysCounted: 2 });
  });
});
