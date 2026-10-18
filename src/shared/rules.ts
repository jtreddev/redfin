import { formatCents } from './money';

/**
 * Categorization rules, carried over from the spreadsheet's "Sync Rules" tab:
 * match text against the raw bank description ("name") or the cleaned merchant,
 * first match wins top to bottom, and anything a person set by hand is never overwritten.
 */
export type MatchField = 'name' | 'merchant' | 'any';

export interface RuleAction {
  categoryId?: number | null;
  kidId?: number | null;
  /** Files the transaction as private fun money for this member. */
  privateMemberId?: number | null;
  /** Drops the row from all totals (e.g. Fidelity core-fund sweeps). */
  ignore?: boolean;
}

export interface Rule {
  id: number;
  position: number;
  matchField: MatchField;
  matchText: string;
  /** Only match transactions on this account. */
  accountId?: number | null;
  /** Only match charges of at least / at most this many cents (absolute, inclusive; null = no bound). */
  amountMin?: number | null;
  amountMax?: number | null;
  /** Made by the app from a fix someone made by hand. */
  learned?: boolean;
  action: RuleAction;
}

export interface RuleSubject {
  name: string;
  merchantName?: string | null;
  accountId: number;
  amountCents?: number;
}

export type CategorySource = 'rule' | 'user' | 'auto' | null;

export interface RulePatch {
  categoryId?: number | null;
  kidId?: number | null;
  privateMemberId?: number | null;
  isIgnored?: boolean;
  categorySource?: CategorySource;
  ruleId?: number | null;
}

/** The text rules (and the classifier) match against: the bank description plus the memo, when there is one. */
export function ruleSubjectName(name: string, memo?: string | null): string {
  return memo ? `${name} ${memo}` : name;
}

export function normalizeText(text: string | null | undefined): string {
  return (text ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
}

const PREFIXES =
  /^(POS|DEBIT CARD PURCHASE|DEBIT PURCHASE|POS PURCHASE|PURCHASE AUTHORIZED ON|RECURRING PAYMENT AUTHORIZED ON|RECURRING PAYMENT|CHECKCARD|CHECK CARD|PURCHASE|ACH DEBIT|ACH CREDIT|ACH|ONLINE|BILLPAY|BILL PAY|WEB PMT|PREAUTHORIZED DEBIT|DEBIT CARD|DEBIT|VISA DDA PUR|DBT CRD \d+)\b\s*/;

/**
 * A short, stable merchant key: "POS DEBIT 09/04 KROGER #1234 COLUMBUS OH" → "KROGER".
 * Used to group recurring bills and suggest rule text.
 */
export function normalizeMerchant(raw: string): string {
  let s = raw.toUpperCase();
  s = s.replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ');
  s = s.replace(/\b(SQ|TST|PP|SP|PAYPAL|DD|IN|PY|BT)\s?\*\s?/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  let previous: string;
  do {
    previous = s;
    s = s.replace(PREFIXES, '').trim();
  } while (s !== previous);
  // Store numbers, phone numbers and reference codes are followed by city/state noise: keep what comes before.
  const cut = s.search(/\s(#\s?\d+|\d{3,}|[A-Z]*\d[A-Z0-9]{4,})\b/);
  if (cut > 0) s = s.slice(0, cut);
  s = s.replace(/[#*]\s?\d+/g, ' ');
  s = s.replace(/\b[A-Z]*\d[A-Z0-9]{3,}\b/g, ' ');
  s = s.replace(/\b\d+\b/g, ' ');
  s = s.replace(/[^A-Z&' ]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  const words = s.split(' ').filter(Boolean);
  // Drop a trailing two-letter state code when there's something before it.
  const last = words[words.length - 1];
  if (words.length > 1 && last && /^[A-Z]{2}$/.test(last) && US_STATES.has(last)) words.pop();
  const key = words.slice(0, 3).join(' ');
  return key || normalizeText(raw);
}

const US_STATES = new Set(
  'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(
    ' ',
  ),
);

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ALNUM = /[A-Z0-9]/i;

/**
 * Whole words, case-insensitive: a token isn't glued to a letter or digit on either side, so "BP"
 * doesn't catch "BPX" or "WEBPAY" while "KROGER" still matches "KROGER#0412". Built-in patterns and
 * learned rules both match this way.
 */
export function wholeWordPattern(tokens: readonly string[]): RegExp {
  const alternatives = tokens.map((token) => {
    const before = ALNUM.test(token.charAt(0)) ? '(?<![A-Z0-9])' : '';
    const after = ALNUM.test(token.charAt(token.length - 1)) ? '(?![A-Z0-9])' : '';
    return `${before}${escapeRegExp(token)}${after}`;
  });
  return new RegExp(`(?:${alternatives.join('|')})`, 'i');
}

/** Words that say how money moved, not who it went to: a fix on these teaches nothing. */
export const GENERIC_LEARN_WORDS: ReadonlySet<string> = new Set([
  'CHECK', 'ATM', 'ZELLE', 'VENMO', 'TRANSFER', 'DEPOSIT', 'PAYMENT', 'WITHDRAWAL', 'POS', 'DEBIT', 'CREDIT',
]);

/** Shortest key a fix may learn: "QT" or "BP" would catch too much. */
export const MIN_LEARN_KEY_LENGTH = 3;

/** Whether a fix may learn a rule from this key: long enough, and not just generic words ("CHECK", "ATM WITHDRAWAL"). */
export function isLearnableKey(key: string): boolean {
  const text = normalizeText(key);
  if (text.length < MIN_LEARN_KEY_LENGTH) return false;
  return !text.split(' ').every((word) => GENERIC_LEARN_WORDS.has(word));
}

const learnedPatterns = new Map<string, RegExp>();
function learnedPattern(needle: string): RegExp {
  let pattern = learnedPatterns.get(needle);
  if (!pattern) {
    pattern = wholeWordPattern([needle]);
    learnedPatterns.set(needle, pattern);
  }
  return pattern;
}

/** A rule ready to match many charges: its text normalized (and, for a learned rule, compiled) once. */
export interface PreparedRule {
  rule: Rule;
  needle: string;
  /** Whole-word pattern for learned rules; null means a plain substring match. */
  pattern: RegExp | null;
}

/** A charge's text normalized once, to match against many rules. */
export interface MatchText {
  name: string;
  merchant: string;
  accountId: number;
  amountCents?: number;
}

export function matchTextOf(subject: RuleSubject): MatchText {
  return {
    name: normalizeText(subject.name),
    merchant: normalizeText(subject.merchantName),
    accountId: subject.accountId,
    amountCents: subject.amountCents,
  };
}

export function prepareRule(rule: Rule): PreparedRule {
  const needle = normalizeText(rule.matchText);
  // Learned rules match whole words; rules people typed match anywhere, as before.
  return { rule, needle, pattern: rule.learned && needle ? learnedPattern(needle) : null };
}

/** Rules in matching order (position, then id), prepared once for many charges. */
export function prepareRules(rules: readonly Rule[]): PreparedRule[] {
  return [...rules].sort((a, b) => a.position - b.position || a.id - b.id).map(prepareRule);
}

export function preparedMatches({ rule, needle, pattern }: PreparedRule, text: MatchText): boolean {
  if (!needle) return false;
  if (rule.accountId != null && rule.accountId !== text.accountId) return false;
  if (text.amountCents != null) {
    const cents = Math.abs(text.amountCents);
    if (rule.amountMin != null && cents < rule.amountMin) return false;
    if (rule.amountMax != null && cents > rule.amountMax) return false;
  }
  const found = (haystack: string) => (pattern ? pattern.test(haystack) : haystack.includes(needle));
  switch (rule.matchField) {
    case 'name':
      return found(text.name);
    case 'merchant':
      return found(text.merchant);
    default:
      return found(text.name) || found(text.merchant);
  }
}

/** First prepared rule (already in order) that matches. */
export function findPreparedRule(prepared: readonly PreparedRule[], text: MatchText): Rule | null {
  for (const p of prepared) if (preparedMatches(p, text)) return p.rule;
  return null;
}

export function ruleMatches(rule: Rule, subject: RuleSubject): boolean {
  return preparedMatches(prepareRule(rule), matchTextOf(subject));
}

/**
 * Learned rules stay within the right person's accounts: a shared one applies only to charges on
 * accounts that are nobody's personal card, a private one only to its person's personal card.
 * `accountOwner` is the member whose default private account the charge is on, or null.
 * Rules people typed in apply everywhere, as before.
 */
export function ruleAppliesToAccount(rule: Rule, accountOwner: number | null): boolean {
  if (!rule.learned) return true;
  return (rule.action.privateMemberId ?? null) === accountOwner;
}

/** First matching rule by position. For many charges, prepare the rules once (see prepareRules). */
export function findRule(rules: readonly Rule[], subject: RuleSubject): Rule | null {
  return findPreparedRule(prepareRules(rules), matchTextOf(subject));
}

/**
 * The changes a rule makes to a transaction. Rows a person categorized by hand keep
 * their category, kid tag and privacy.
 */
export function rulePatch(rule: Rule | null, current: { categorySource: CategorySource }): RulePatch {
  if (current.categorySource === 'user') return {};
  if (!rule) {
    return current.categorySource === 'rule'
      ? { categoryId: null, kidId: null, isIgnored: false, categorySource: null, ruleId: null }
      : {};
  }
  const patch: RulePatch = { categorySource: 'rule', ruleId: rule.id, isIgnored: !!rule.action.ignore };
  if (rule.action.categoryId !== undefined) patch.categoryId = rule.action.categoryId;
  if (rule.action.kidId !== undefined) patch.kidId = rule.action.kidId;
  if (rule.action.privateMemberId !== undefined) patch.privateMemberId = rule.action.privateMemberId;
  return patch;
}

/** Suggested rule after someone re-files a transaction by hand. */
export function suggestRule(subject: RuleSubject): { matchField: MatchField; matchText: string } {
  const merchant = subject.merchantName?.trim();
  if (merchant) return { matchField: 'merchant', matchText: merchant };
  return { matchField: 'name', matchText: normalizeMerchant(subject.name) };
}

/**
 * Seeded rules that ignore Fidelity Cash Management core-fund sweep mirror entries.
 * Kept specific on purpose: "DIVIDEND RECEIVED ... (SPAXX)" is real interest income.
 */
export const DEFAULT_IGNORE_PATTERNS = [
  'REDEMPTION FROM CORE ACCOUNT',
  'PURCHASE INTO CORE ACCOUNT',
  'REINVESTMENT',
];

/**
 * A rule's amount range as people read it: "under $25", "$25 and up", "$5–$25". Bounds are
 * inclusive cents, so the upper bound shows as max + 1 ("under $25" is 0–2499). Null when unbounded.
 */
export function ruleRangeLabel(minCents: number | null | undefined, maxCents: number | null | undefined): string | null {
  const dollars = (cents: number) => formatCents(cents, { whole: cents % 100 === 0 });
  const min = minCents != null && minCents > 0 ? minCents : null;
  const below = maxCents != null ? maxCents + 1 : null;
  if (min === null && below === null) return null;
  if (min === null) return `under ${dollars(below!)}`;
  if (below === null) return `${dollars(min)} and up`;
  return `${dollars(min)}–${dollars(below)}`;
}
