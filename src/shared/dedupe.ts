import { diffDays, type ISODate } from './dates';
import type { Cents } from './money';
import { normalizeText } from './rules';

export interface ImportRowLike {
  date: ISODate;
  amountCents: Cents;
  name: string;
}

/**
 * Numbers identical rows within one file (0, 1, 2…) so two same-day $4.50 coffees
 * both import, while re-importing the same file or an overlapping one matches exactly.
 */
export function withOccurrences<T extends ImportRowLike>(rows: readonly T[]): (T & { occurrence: number })[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = `${row.date}|${row.amountCents}|${normalizeText(row.name)}`;
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    return { ...row, occurrence };
  });
}

/** Dedupe key for CSV rows (OFX rows use the file's FITID instead). */
export function csvImportKey(accountId: number, row: ImportRowLike & { occurrence: number }): string {
  return `${accountId}|${row.date}|${row.amountCents}|${normalizeText(row.name)}|${row.occurrence}`;
}

export interface ExistingRow {
  id: number;
  accountId: number;
  date: ISODate;
  amountCents: Cents;
  plaidTxnId?: string | null;
}

/**
 * A file-imported row that a newly synced Plaid transaction is really the same as:
 * same account and amount, not already linked to Plaid, dates within the window.
 * Picks the closest date.
 */
export function findImportedTwin(
  incoming: { accountId: number; date: ISODate; amountCents: Cents },
  existing: readonly ExistingRow[],
  windowDays = 2,
  alreadyClaimed: ReadonlySet<number> = new Set(),
): number | null {
  let best: { id: number; gap: number } | null = null;
  for (const row of existing) {
    if (row.plaidTxnId || alreadyClaimed.has(row.id)) continue;
    if (row.accountId !== incoming.accountId || row.amountCents !== incoming.amountCents) continue;
    const gap = Math.abs(diffDays(row.date, incoming.date));
    if (gap > windowDays) continue;
    if (!best || gap < best.gap || (gap === best.gap && row.id < best.id)) best = { id: row.id, gap };
  }
  return best?.id ?? null;
}
