import { isISODate, makeDate, type ISODate } from '../dates';
import { parseMoney, type Cents } from '../money';

export interface ColumnMapping {
  /** Row index (0-based) holding the column headers. */
  headerRow: number;
  date: number;
  description: number;
  /** Signed amount column. Use this or debit/credit. */
  amount?: number;
  /** Money out, as a positive number. */
  debit?: number;
  /** Money in, as a positive number. */
  credit?: number;
  /** A Debit/Credit type column that decides the sign of an unsigned amount. */
  type?: number;
  memo?: number;
  /** Flip the sign (for banks that export purchases as positive numbers). */
  invertSign?: boolean;
}

export interface ParsedImportRow {
  date: ISODate;
  name: string;
  amountCents: Cents;
  memo?: string;
}

export interface ImportPreset {
  id: string;
  label: string;
  note?: string;
  /** Returns column positions when the headers look like this bank's export. */
  match(headers: readonly string[]): Omit<ColumnMapping, 'headerRow'> | null;
}

const norm = (header: string) => header.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function column(headers: readonly string[], ...names: string[]): number | undefined {
  const normalized = headers.map(norm);
  for (const name of names) {
    const exact = normalized.indexOf(name);
    if (exact !== -1) return exact;
  }
  for (const name of names) {
    const partial = normalized.findIndex((h) => h.includes(name));
    if (partial !== -1) return partial;
  }
  return undefined;
}

export const PRESETS: ImportPreset[] = [
  {
    id: 'capital-one-card',
    label: 'Capital One credit card',
    match(headers) {
      const date = column(headers, 'transaction date');
      const posted = column(headers, 'posted date');
      const description = column(headers, 'description');
      const debit = column(headers, 'debit');
      const credit = column(headers, 'credit');
      if (date === undefined || posted === undefined || description === undefined) return null;
      if (debit === undefined || credit === undefined) return null;
      return { date, description, debit, credit };
    },
  },
  {
    id: 'capital-one-bank',
    label: 'Capital One 360 checking/savings',
    match(headers) {
      const date = column(headers, 'transaction date');
      const description = column(headers, 'transaction description');
      const amount = column(headers, 'transaction amount');
      const type = column(headers, 'transaction type');
      if (date === undefined || description === undefined || amount === undefined || type === undefined) return null;
      return { date, description, amount, type };
    },
  },
  {
    id: 'fidelity',
    label: 'Fidelity account history',
    note: 'Core-fund sweep rows are ignored by the default rules.',
    match(headers) {
      const date = column(headers, 'run date');
      const action = column(headers, 'action');
      const amount = column(headers, 'amount');
      if (date === undefined || action === undefined || amount === undefined) return null;
      return { date, description: action, amount, memo: column(headers, 'description') };
    },
  },
  {
    id: 'generic',
    label: 'Other bank (Date / Description / Amount)',
    note: 'Chime currently offers PDF statements only; use bank sync or manual entry for Chime.',
    match(headers) {
      const date = column(headers, 'posting date', 'transaction date', 'date', 'posted');
      const description = column(headers, 'description', 'payee', 'name', 'merchant', 'details', 'memo');
      if (date === undefined || description === undefined) return null;
      const amount = column(headers, 'amount');
      const debit = column(headers, 'debit', 'withdrawal', 'money out');
      const credit = column(headers, 'credit', 'deposit', 'money in');
      if (amount !== undefined) return { date, description, amount, type: column(headers, 'type') };
      if (debit !== undefined && credit !== undefined) return { date, description, debit, credit };
      return null;
    },
  },
];

/** Bank exports often have a few preamble lines; the header is the first row that names a date column. */
export function findHeaderRow(rows: readonly (readonly string[])[]): number {
  const limit = Math.min(rows.length, 20);
  for (let i = 0; i < limit; i++) {
    const cells = rows[i] ?? [];
    const filled = cells.filter((c) => c.trim() !== '').length;
    if (filled >= 3 && cells.some((c) => /date/i.test(c))) return i;
  }
  return 0;
}

export function detectPreset(
  rows: readonly (readonly string[])[],
): { preset: ImportPreset; mapping: ColumnMapping } | null {
  const headerRow = findHeaderRow(rows);
  const headers = rows[headerRow] ?? [];
  for (const preset of PRESETS) {
    const mapping = preset.match(headers);
    if (mapping) return { preset, mapping: { ...mapping, headerRow } };
  }
  return null;
}

/** Accepts 2026-09-04, 09/04/2026, 9/4/26 and 2026/09/04. */
export function parseDateFlexible(text: string): ISODate | null {
  const s = text.trim().split(/[ T]/)[0] ?? '';
  let match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (match) {
    const date = makeDate(Number(match[1]), Number(match[2]), Number(match[3]));
    return isISODate(date) && date === `${match[1]}-${match[2]?.padStart(2, '0')}-${match[3]?.padStart(2, '0')}` ? date : null;
  }
  match = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2}|\d{4})$/.exec(s);
  if (match) {
    const year = match[3]?.length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
    const month = Number(match[1]);
    const day = Number(match[2]);
    const date = makeDate(year, month, day);
    return date === `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` ? date : null;
  }
  return null;
}

export function applyMapping(
  rows: readonly (readonly string[])[],
  mapping: ColumnMapping,
): { rows: ParsedImportRow[]; skipped: { line: number; reason: string }[] } {
  const parsed: ParsedImportRow[] = [];
  const skipped: { line: number; reason: string }[] = [];

  for (let i = mapping.headerRow + 1; i < rows.length; i++) {
    const cells = rows[i] ?? [];
    const line = i + 1;
    const date = parseDateFlexible(cells[mapping.date] ?? '');
    if (!date) {
      // Trailing disclaimers and totals rows have no date; skip them quietly.
      if ((cells[mapping.date] ?? '').trim() !== '') skipped.push({ line, reason: 'Unrecognized date' });
      continue;
    }

    let amount: Cents | null;
    if (mapping.amount !== undefined) {
      amount = parseMoney(cells[mapping.amount]);
      if (amount !== null && mapping.type !== undefined) {
        const type = (cells[mapping.type] ?? '').toLowerCase();
        if (/debit|withdraw|purchase|payment sent/.test(type)) amount = -Math.abs(amount);
        else if (/credit|deposit/.test(type)) amount = Math.abs(amount);
      }
    } else {
      const debit = parseMoney(cells[mapping.debit ?? -1]);
      const credit = parseMoney(cells[mapping.credit ?? -1]);
      amount = debit === null && credit === null ? null : Math.abs(credit ?? 0) - Math.abs(debit ?? 0);
    }
    if (amount === null) {
      skipped.push({ line, reason: 'Missing amount' });
      continue;
    }
    if (mapping.invertSign) amount = -amount;
    if (amount === 0) amount = 0;

    const name = (cells[mapping.description] ?? '').replace(/\s+/g, ' ').trim();
    const memo = mapping.memo !== undefined ? (cells[mapping.memo] ?? '').replace(/\s+/g, ' ').trim() : '';
    parsed.push({ date, name: name || memo || '(no description)', amountCents: amount, ...(memo ? { memo } : {}) });
  }
  return { rows: parsed, skipped };
}
