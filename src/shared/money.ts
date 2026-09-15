/** Money is always integer cents. Negative = money out. */
export type Cents = number;

export function dollarsToCents(dollars: number): Cents {
  return Math.round(dollars * 100);
}

export function sumCents(values: readonly Cents[]): Cents {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/**
 * Parses bank-style money text: "$1,234.56", "-12.34", "(12.34)", "12.34-", "+5".
 * Returns null when the text isn't a number.
 */
export function parseMoney(input: string | number | null | undefined): Cents | null {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? dollarsToCents(input) : null;
  let s = input.trim();
  if (!s) return null;

  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  s = s.replace(/[$,\s]/g, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return null;

  const [whole = '', frac = ''] = s.split('.');
  let cents = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2));
  if (frac.length > 2 && Number(frac[2]) >= 5) cents += 1;
  if (cents === 0) return 0;
  return negative ? -cents : cents;
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usdWhole = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
});

export function formatCents(
  cents: Cents,
  { whole = false, signed = false }: { whole?: boolean; signed?: boolean } = {},
): string {
  const text = (whole ? usdWhole : usd).format(Math.abs(cents) / 100);
  if (cents < 0) return `-${text}`;
  if (signed && cents > 0) return `+${text}`;
  return text;
}
