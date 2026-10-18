/**
 * What someone types in a search box: words, an amount ("45", "45.12", "$1,200"), and size filters
 * (">100", "<=20.50"). Amounts are sizes, so they match money in or out alike.
 */
export interface ParsedSearch {
  /** The words left after taking out size filters; matched as one phrase. */
  text: string;
  /** Set when the text is just an amount: "45" means $45.00–$45.99, "45.12" exactly $45.12. */
  amount: { minCents: number; maxCents: number } | null;
  /** Size filters, inclusive, in cents. */
  minCents: number | null;
  maxCents: number | null;
}

const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?`;
const SIZE = new RegExp(String.raw`^(>=?|<=?)\$?${NUMBER}$`);
const AMOUNT = new RegExp(String.raw`^\$?${NUMBER}$`);

function toCents(dollars: string, fraction: string | undefined): number {
  return Number(dollars.replace(/,/g, '')) * 100 + (fraction ? Number(fraction.padEnd(2, '0')) : 0);
}

export function parseSearch(input: string): ParsedSearch {
  let minCents: number | null = null;
  let maxCents: number | null = null;
  const words: string[] = [];
  for (const token of input.trim().split(/\s+/).filter(Boolean)) {
    const size = SIZE.exec(token);
    if (!size) {
      words.push(token);
      continue;
    }
    const cents = toCents(size[2]!, size[3]);
    if (size[1]!.startsWith('>')) {
      const min = size[1] === '>' ? cents + 1 : cents;
      minCents = minCents === null ? min : Math.max(minCents, min);
    } else {
      const max = size[1] === '<' ? cents - 1 : cents;
      maxCents = maxCents === null ? max : Math.min(maxCents, max);
    }
  }
  const text = words.join(' ');
  const amountMatch = AMOUNT.exec(text);
  let amount: ParsedSearch['amount'] = null;
  if (amountMatch) {
    const cents = toCents(amountMatch[1]!, amountMatch[2]);
    amount = amountMatch[2] === undefined ? { minCents: cents, maxCents: cents + 99 } : { minCents: cents, maxCents: cents };
  }
  return { text, amount, minCents, maxCents };
}

/** A LIKE pattern for `text` anywhere, with % _ and \ taken literally (use ESCAPE '\'). */
export function likeAnywhere(text: string): string {
  return `%${text.replace(/[\\%_]/g, '\\$&')}%`;
}
