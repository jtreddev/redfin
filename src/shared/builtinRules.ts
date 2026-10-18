import type { CategoryRef } from './autoCategory';
import { SPECIAL } from './categorySet';

/**
 * Built-in patterns, matched against the normalized merchant key (see normalizeMerchant) as whole
 * words, so "BP" doesn't catch "BPX". Written the way keys come out: "7-ELEVEN 1234" → "ELEVEN",
 * "PHILLIPS 66" → "PHILLIPS", "T-MOBILE" → "T MOBILE".
 */
export const GAS_STATIONS: readonly string[] = [
  'SHELL', "CASEY'S", 'CASEYS', 'MARATHON', 'KWIK TRIP', 'KWIK STAR', 'BP', 'EXXON', 'EXXONMOBIL', 'MOBIL', 'SPEEDWAY',
  'CIRCLE K', 'QUIKTRIP', 'QT', "LOVE'S", 'LOVES', 'PILOT', 'FLYING J', 'SUNOCO', 'CHEVRON', 'PHILLIPS', 'CITGO', 'VALERO',
  'ELEVEN', 'SEVEN ELEVEN', 'WAWA', 'SHEETZ', 'HOLIDAY', 'THORNTONS',
];

const KNOWN_NAMES: readonly { ref: CategoryRef; label: string; tokens: readonly string[] }[] = [
  {
    ref: ['Bills', 'Subscriptions'],
    label: 'a subscription',
    tokens: [
      'NETFLIX', 'HULU', 'SPOTIFY', 'DISNEY PLUS', 'DISNEYPLUS', 'HBO MAX', 'MAX COM', 'APPLE COM BILL', 'GOOGLE', 'YOUTUBE',
      'AMAZON PRIME', 'PRIME VIDEO', 'DASHPASS',
    ],
  },
  { ref: ['Bills', 'Housing'], label: 'a mortgage', tokens: ['ROCKET MORTGAGE', 'MORTGAGE'] },
  { ref: ['Bills', 'Loans'], label: 'a loan', tokens: ['AIDVANTAGE', 'NELNET', 'MOHELA', 'BRIDGECREST', 'AUTO LOAN', 'STUDENT LOAN'] },
  { ref: ['Bills', 'Insurance'], label: 'insurance', tokens: ['GEICO', 'PROGRESSIVE', 'STATE FARM', 'ALLSTATE'] },
  { ref: ['Bills', 'Phone'], label: 'a phone bill', tokens: ['T MOBILE', 'TMOBILE', 'VERIZON', 'AT&T WIRELESS'] },
  { ref: ['Bills', 'Internet'], label: 'internet', tokens: ['XFINITY', 'COMCAST', 'SPECTRUM'] },
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whole-word, case-insensitive: the token starts the key or follows a space, and ends it or precedes one. */
const pattern = (tokens: readonly string[]) => new RegExp(`(?:^| )(?:${tokens.map(escape).join('|')})(?: |$)`, 'i');

const GAS_PATTERN = pattern(GAS_STATIONS);
const KNOWN_PATTERNS = KNOWN_NAMES.map((k) => ({ ...k, pattern: pattern(k.tokens) }));

const dollars = (cents: number) => (cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

/** A gas station by its merchant key, or by the bank's detailed category. */
export function isGasStation(subject: { merchant: string; bankDetailed: string | null }): boolean {
  return GAS_PATTERN.test(subject.merchant) || subject.bankDetailed === 'TRANSPORTATION_GAS';
}

/** Spending only: a refund from a gas station or Netflix isn't a habit or a bill. */
export function builtinCategory(
  subject: { merchant: string; amountCents: number; bankDetailed: string | null },
  cutoffCents: number,
): { ref: CategoryRef; reason: string } | null {
  if (subject.amountCents >= 0) return null;
  if (isGasStation(subject)) {
    return Math.abs(subject.amountCents) < cutoffCents
      ? { ref: SPECIAL.habits, reason: `Under ${dollars(cutoffCents)} at a gas station` }
      : { ref: SPECIAL.gas, reason: 'Gas station' };
  }
  const known = KNOWN_PATTERNS.find((k) => k.pattern.test(subject.merchant));
  return known ? { ref: known.ref, reason: `Looks like ${known.label}` } : null;
}
