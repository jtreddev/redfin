import { parseSearch } from '../shared/search';
import { formatCents } from '../shared/money';

/**
 * What a search will look for, in words, shown under the search box ("Amounts $45.00 to $45.99, or
 * the words “45”"). The server parses the same way (src/shared/search.ts).
 */
export function describeSearch(input: string): string | null {
  const s = parseSearch(input.slice(0, 100));
  const parts: string[] = [];
  if (s.amount) {
    const amount =
      s.amount.minCents === s.amount.maxCents
        ? `Amounts of ${formatCents(s.amount.minCents)}`
        : `Amounts ${formatCents(s.amount.minCents)} to ${formatCents(s.amount.maxCents)}`;
    parts.push(`${amount}, in or out, or text with “${s.text}”`);
  } else if (s.text) {
    parts.push(`Text with “${s.text}”`);
  }
  if (s.minCents !== null && s.maxCents !== null) parts.push(`sized ${formatCents(s.minCents)} to ${formatCents(s.maxCents)}`);
  else if (s.minCents !== null) parts.push(`${formatCents(s.minCents)} or more`);
  else if (s.maxCents !== null) parts.push(`${formatCents(s.maxCents)} or less`);
  if (!parts.length) return null;
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "23 charges · $412.60 out · $0 in" */
export function resultSummary(totals: { count: number; outCents: number; inCents: number }): string {
  const noun = totals.count === 1 ? 'charge' : 'charges';
  return `${totals.count} ${noun} · ${formatCents(totals.outCents)} out · ${formatCents(totals.inCents, { whole: totals.inCents === 0 })} in`;
}
