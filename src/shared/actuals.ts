import { monthOf, type ISODate, type MonthKey } from './dates';
import type { Cents } from './money';
import { monthWeeks, weekIndexOf } from './weeks';

export type CategoryKind = 'income' | 'expense' | 'savings' | 'debt' | 'transfer';

export interface LedgerSplit {
  categoryId: number | null;
  categoryKind: CategoryKind | null;
  kidId: number | null;
  amountCents: Cents;
}

export interface LedgerTxn {
  id: number;
  date: ISODate;
  amountCents: Cents;
  categoryId: number | null;
  categoryKind: CategoryKind | null;
  kidId: number | null;
  privateMemberId: number | null;
  transferPairId: number | null;
  isIgnored: boolean;
  splits?: readonly LedgerSplit[];
}

/** One countable piece of a transaction (a split transaction yields several). */
export interface LedgerEntry {
  txnId: number;
  date: ISODate;
  categoryId: number | null;
  kind: CategoryKind | null;
  kidId: number | null;
  privateMemberId: number | null;
  amountCents: Cents;
}

/**
 * What counts toward budgets: not ignored, not filed as a transfer, and not an
 * uncategorized half of a matched transfer between your own accounts. A transfer
 * someone filed under a savings or debt category (Chime → Fidelity as Emergency Fund)
 * still counts toward that category.
 */
export function ledgerEntries(txns: readonly LedgerTxn[]): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const t of txns) {
    if (t.isIgnored) continue;
    const parts = t.splits?.length
      ? t.splits.map((s) => ({ categoryId: s.categoryId, kind: s.categoryKind, kidId: s.kidId ?? t.kidId, amountCents: s.amountCents }))
      : [{ categoryId: t.categoryId, kind: t.categoryKind, kidId: t.kidId, amountCents: t.amountCents }];
    for (const part of parts) {
      if (part.kind === 'transfer') continue;
      if (part.categoryId === null && t.transferPairId !== null) continue;
      entries.push({
        txnId: t.id,
        date: t.date,
        categoryId: part.categoryId,
        kind: part.kind,
        kidId: part.kidId,
        privateMemberId: t.privateMemberId,
        amountCents: part.amountCents,
      });
    }
  }
  return entries;
}

/** Positive flow in a category's natural direction: deposits for income, money out for everything else. */
export function flowCents(entry: Pick<LedgerEntry, 'kind' | 'amountCents'>): Cents {
  return entry.kind === 'income' ? entry.amountCents : -entry.amountCents;
}

export interface CategoryActual {
  totalCents: Cents;
  byWeek: Cents[];
}

export interface MonthActuals {
  byCategory: Map<number, CategoryActual>;
  /** Uncategorized deposits (positive). */
  uncategorizedIn: CategoryActual;
  /** Uncategorized money out (positive). */
  uncategorizedOut: CategoryActual;
  uncategorizedCount: number;
}

export function monthActuals(entries: readonly LedgerEntry[], month: MonthKey): MonthActuals {
  const weeks = monthWeeks(month);
  const blank = (): CategoryActual => ({ totalCents: 0, byWeek: weeks.map(() => 0) });
  const result: MonthActuals = {
    byCategory: new Map(),
    uncategorizedIn: blank(),
    uncategorizedOut: blank(),
    uncategorizedCount: 0,
  };
  const uncategorizedTxns = new Set<number>();

  for (const entry of entries) {
    if (monthOf(entry.date) !== month) continue;
    const position = weekIndexOf(entry.date) - 1;
    let bucket: CategoryActual;
    let value: Cents;
    if (entry.categoryId === null) {
      uncategorizedTxns.add(entry.txnId);
      bucket = entry.amountCents >= 0 ? result.uncategorizedIn : result.uncategorizedOut;
      value = Math.abs(entry.amountCents);
    } else {
      bucket = result.byCategory.get(entry.categoryId) ?? blank();
      result.byCategory.set(entry.categoryId, bucket);
      value = flowCents(entry);
    }
    bucket.totalCents += value;
    bucket.byWeek[position] = (bucket.byWeek[position] ?? 0) + value;
  }
  result.uncategorizedCount = uncategorizedTxns.size;
  return result;
}
