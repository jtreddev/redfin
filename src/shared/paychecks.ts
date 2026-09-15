import type { ISODate } from './dates';
import type { Cents } from './money';
import { nearestPayDate, type PaySchedule } from './paySchedule';
import { normalizeText } from './rules';

export interface IncomeSourceMatcher {
  id: number;
  matchText: string | null;
  accountId: number | null;
  schedule: PaySchedule;
}

/**
 * Recognizes a paycheck deposit by its description text and ties it to the expected
 * payday it belongs to (deposits can land a few days early).
 */
export function matchPaycheck(
  sources: readonly IncomeSourceMatcher[],
  txn: { name: string; merchantName?: string | null; amountCents: Cents; date: ISODate; accountId: number },
): { sourceId: number; payDate: ISODate } | null {
  if (txn.amountCents <= 0) return null;
  const text = normalizeText(`${txn.name} ${txn.merchantName ?? ''}`);
  for (const source of sources) {
    const needle = normalizeText(source.matchText);
    if (!needle || !text.includes(needle)) continue;
    if (source.accountId != null && source.accountId !== txn.accountId) continue;
    const payDate = nearestPayDate(source.schedule, txn.date, 3);
    if (payDate) return { sourceId: source.id, payDate };
  }
  return null;
}
