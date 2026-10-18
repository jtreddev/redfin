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

export function ruleMatches(rule: Rule, subject: RuleSubject): boolean {
  if (rule.accountId != null && rule.accountId !== subject.accountId) return false;
  if (subject.amountCents != null) {
    const cents = Math.abs(subject.amountCents);
    if (rule.amountMin != null && cents < rule.amountMin) return false;
    if (rule.amountMax != null && cents > rule.amountMax) return false;
  }
  const needle = normalizeText(rule.matchText);
  if (!needle) return false;
  const name = normalizeText(subject.name);
  const merchant = normalizeText(subject.merchantName);
  switch (rule.matchField) {
    case 'name':
      return name.includes(needle);
    case 'merchant':
      return merchant.includes(needle);
    default:
      return name.includes(needle) || merchant.includes(needle);
  }
}

/** First matching rule by position. */
export function findRule(rules: readonly Rule[], subject: RuleSubject): Rule | null {
  const ordered = [...rules].sort((a, b) => a.position - b.position || a.id - b.id);
  return ordered.find((rule) => ruleMatches(rule, subject)) ?? null;
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
