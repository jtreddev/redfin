import { toCsv } from '../shared/import/csv';
import type { Category, Kid, Transaction } from './types';

/** The charges on screen as a spreadsheet (formula-safe through toCsv), with a byte-order mark for Excel. */
export function transactionsCsv(rows: readonly Transaction[], categories: readonly Category[], kids: readonly Kid[]): string {
  const name = (id: number | null) => (id === null ? '' : (categories.find((c) => c.id === id)?.name ?? ''));
  const parentOf = (id: number | null) => {
    const c = categories.find((k) => k.id === id);
    return c?.parentId ? name(c.parentId) : '';
  };
  const kid = (id: number | null) => (id === null ? '' : (kids.find((k) => k.id === id)?.name ?? ''));
  const csv = toCsv([
    ['Date', 'Account', 'Description', 'Merchant', 'Amount', 'Category', 'Parent category', 'Kid', 'Notes', 'Private', 'Left out', 'Pending', 'Splits'],
    ...rows.map((t) => [
      t.date,
      t.accountName,
      t.name,
      t.merchantName,
      (t.amountCents / 100).toFixed(2),
      t.isSplit ? 'Split' : name(t.categoryId),
      t.isSplit ? '' : parentOf(t.categoryId),
      kid(t.kidId),
      t.notes,
      t.isPrivate ? 'yes' : '',
      t.isIgnored ? 'yes' : '',
      t.pending ? 'yes' : '',
      t.splits.map((s) => `${name(s.categoryId) || 'Uncategorized'} ${(s.amountCents / 100).toFixed(2)}`).join('; '),
    ]),
  ]);
  return `﻿${csv}`;
}
