import { ledgerEntries, type LedgerEntry } from '../../shared/actuals';
import { addMonths, monthEnd, monthOf, monthStart, type ISODate, type MonthKey } from '../../shared/dates';
import type { TrendsInput } from '../../shared/trends';
import { loadCategories } from './context';
import { loadLedger } from './ledger';

/** The months ending with this one, oldest first. */
export function monthsBack(today: ISODate, n: number): MonthKey[] {
  const current = monthOf(today);
  return Array.from({ length: n }, (_, i) => addMonths(current, i - n + 1));
}

/**
 * What buildTrends needs, from the start of `months` to today's month. Private charges come in as they are:
 * buildTrends counts them only as their owner's fun money total.
 */
export async function loadTrendsInput(db: D1Database, months: readonly MonthKey[], today: ISODate): Promise<TrendsInput> {
  const [ledger, categoryRows] = await Promise.all([loadLedger(db, monthStart(months[0]!), monthEnd(monthOf(today))), loadCategories(db)]);
  const entries: LedgerEntry[] = ledgerEntries(ledger);
  const categories = categoryRows.map((r) => ({ id: r.id, name: r.name, section: r.sectionName, funMemberId: r.funMemberId, parentId: r.parentId }));
  return { entries, categories, months, today };
}
