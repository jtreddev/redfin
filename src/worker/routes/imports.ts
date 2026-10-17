import { Hono } from 'hono';
import { addDays, type ISODate } from '../../shared/dates';
import { csvImportKey, findImportedTwin } from '../../shared/dedupe';
import type { AppEnv } from '../env';
import { all, batchAll, chunk, first, placeholders, run, stmt } from '../lib/db';
import { badRequest, notFound, oneOf, optInt, optStr, paramId, readBody, reqDate, reqInt, reqStr } from '../lib/http';
import { loadIngestContext } from '../services/context';
import { insertTransactions, type IncomingTxn } from '../services/ingest';
import { matchTransfers } from '../services/transfers';

/**
 * File import. The browser parses CSV/OFX and sends normalized rows in chunks
 * (keeps each request well inside the Worker CPU limit):
 *   POST /import/batches → POST /import/batches/:id/rows (repeat) → POST /import/batches/:id/finish
 */
export const imports = new Hono<AppEnv>();

const MAX_ROWS_PER_CHUNK = 250;

imports.get('/import/batches', async (c) => {
  return c.json(
    await all(
      c.env.DB,
      `SELECT b.id, b.account_id AS accountId, a.name AS accountName, b.filename, b.format, b.row_count AS rowCount,
              b.inserted_count AS insertedCount, b.duplicate_count AS duplicateCount, b.created_at AS createdAt,
              m.name AS createdBy
         FROM import_batches b
         JOIN accounts a ON a.id = b.account_id
         LEFT JOIN members m ON m.id = b.created_by_member_id
        ORDER BY b.id DESC LIMIT 25`,
    ),
  );
});

imports.post('/import/batches', async (c) => {
  const body = await readBody(c);
  const accountId = reqInt(body.accountId, 'accountId', { min: 1 });
  if (!(await first(c.env.DB, 'SELECT 1 FROM accounts WHERE id = ?', accountId))) throw badRequest('Unknown account');
  const row = await first<{ id: number }>(
    c.env.DB,
    'INSERT INTO import_batches (account_id, filename, format, created_by_member_id) VALUES (?, ?, ?, ?) RETURNING id',
    accountId,
    optStr(body.filename, 'filename', 200) ?? null,
    oneOf(body.format, 'format', ['csv', 'ofx'] as const) ?? 'csv',
    c.get('viewer').memberId,
  );
  return c.json(row, 201);
});

imports.post('/import/batches/:id/rows', async (c) => {
  const db = c.env.DB;
  const batchId = paramId(c);
  const batch = await first<{ accountId: number; format: 'csv' | 'ofx' }>(
    db,
    'SELECT account_id AS accountId, format FROM import_batches WHERE id = ?',
    batchId,
  );
  if (!batch) throw notFound('Import not found');
  const body = await readBody(c);
  if (!Array.isArray(body.rows) || body.rows.length > MAX_ROWS_PER_CHUNK) {
    throw badRequest(`rows must be a list of at most ${MAX_ROWS_PER_CHUNK}`);
  }

  const viewer = c.get('viewer');
  const rows: IncomingTxn[] = body.rows.map((raw, i) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const date = reqDate(r.date, `rows[${i}].date`);
    const amountCents = reqInt(r.amountCents, `rows[${i}].amountCents`);
    const name = reqStr(r.name, `rows[${i}].name`, 300);
    const base: IncomingTxn = {
      accountId: batch.accountId,
      date,
      amountCents,
      name,
      memo: optStr(r.memo, `rows[${i}].memo`, 300) ?? null,
      source: 'import',
      importBatchId: batchId,
      createdByMemberId: viewer.memberId,
    };
    if (batch.format === 'ofx') return { ...base, importFitid: reqStr(r.fitId, `rows[${i}].fitId`, 255) };
    const occurrence = optInt(r.occurrence, `rows[${i}].occurrence`, { min: 0 }) ?? 0;
    return { ...base, importHash: csvImportKey(batch.accountId, { date, amountCents, name, occurrence }) };
  });

  const fresh = await skipSyncedTwins(db, batch.accountId, rows);
  const result = await insertTransactions(db, await loadIngestContext(db), fresh);
  const duplicates = result.duplicates + rows.length - fresh.length;
  await run(
    db,
    `UPDATE import_batches SET row_count = row_count + ?, inserted_count = inserted_count + ?,
       duplicate_count = duplicate_count + ? WHERE id = ?`,
    rows.length,
    result.inserted,
    duplicates,
    batchId,
  );
  return c.json({ inserted: result.inserted, duplicates });
});

/**
 * Leaves out file rows the bank sync already brought in (same account and amount, within
 * 2 days). The synced row takes the file row's FITID or CSV key, so re-importing the
 * same file skips it as an exact duplicate.
 */
async function skipSyncedTwins(db: D1Database, accountId: number, rows: readonly IncomingTxn[]): Promise<IncomingTxn[]> {
  if (!rows.length) return [];
  const keyOf = (r: IncomingTxn) => r.importFitid ?? r.importHash ?? '';
  // Rows already in (from this file before) are left to the insert, which skips them.
  const known = new Set<string>();
  for (const group of chunk([...new Set(rows.map(keyOf))], 45)) {
    const found = await all<{ key: string }>(
      db,
      `SELECT COALESCE(import_fitid, import_hash) AS key FROM transactions
        WHERE account_id = ? AND (import_fitid IN (${placeholders(group.length)}) OR import_hash IN (${placeholders(group.length)}))`,
      accountId,
      ...group,
      ...group,
    );
    for (const r of found) known.add(r.key);
  }
  const candidates = rows.filter((r) => {
    if (known.has(keyOf(r))) return false;
    known.add(keyOf(r)); // a key repeated within the file is matched at most once
    return true;
  });
  if (!candidates.length) return [...rows];

  const dates = candidates.map((r) => r.date).sort();
  // plaid_txn_id is left out on purpose: findImportedTwin skips rows that have one.
  const synced = await all<{ id: number; accountId: number; date: ISODate; amountCents: number }>(
    db,
    `SELECT id, account_id AS accountId, date, amount_cents AS amountCents FROM transactions
      WHERE account_id = ? AND source = 'plaid' AND deleted_at IS NULL
        AND import_fitid IS NULL AND import_hash IS NULL AND date BETWEEN ? AND ?`,
    accountId,
    addDays(dates[0] as ISODate, -2),
    addDays(dates[dates.length - 1] as ISODate, 2),
  );

  const claimed = new Set<number>();
  const stamps: D1PreparedStatement[] = [];
  const skipped = new Set<IncomingTxn>();
  for (const row of candidates) {
    const twin = findImportedTwin(row, synced, 2, claimed);
    if (twin === null) continue;
    claimed.add(twin);
    skipped.add(row);
    stamps.push(stmt(db, 'UPDATE transactions SET import_fitid = ?, import_hash = ? WHERE id = ?', row.importFitid, row.importHash, twin));
  }
  await batchAll(db, stamps);
  return rows.filter((r) => !skipped.has(r));
}

imports.post('/import/batches/:id/finish', async (c) => {
  const db = c.env.DB;
  const batchId = paramId(c);
  const range = await first<{ minDate: string | null; maxDate: string | null }>(
    db,
    'SELECT MIN(date) AS minDate, MAX(date) AS maxDate FROM transactions WHERE import_batch_id = ?',
    batchId,
  );
  const transfers = range?.minDate && range.maxDate ? await matchTransfers(db, range.minDate, range.maxDate) : 0;
  const batch = await first(
    db,
    `SELECT id, row_count AS rowCount, inserted_count AS insertedCount, duplicate_count AS duplicateCount
       FROM import_batches WHERE id = ?`,
    batchId,
  );
  if (!batch) throw notFound('Import not found');
  const uncategorized = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM transactions
      WHERE import_batch_id = ? AND category_id IS NULL AND is_ignored = 0 AND transfer_pair_id IS NULL`,
    batchId,
  );
  return c.json({ ...batch, transfers, uncategorized: uncategorized?.n ?? 0 });
});

/** Undo an import: removes only the rows that import added. */
imports.delete('/import/batches/:id', async (c) => {
  const db = c.env.DB;
  const batchId = paramId(c);
  const rows = await all<{ id: number }>(db, `SELECT id FROM transactions WHERE import_batch_id = ? AND source = 'import'`, batchId);
  await batchAll(db, [
    stmt(
      db,
      `UPDATE transactions SET transfer_pair_id = NULL
        WHERE transfer_pair_id IN (SELECT id FROM transactions WHERE import_batch_id = ? AND source = 'import')`,
      batchId,
    ),
    stmt(db, `DELETE FROM transactions WHERE import_batch_id = ? AND source = 'import'`, batchId),
    stmt(db, 'DELETE FROM import_batches WHERE id = ?', batchId),
  ]);
  return c.json({ removed: rows.length });
});

imports.get('/import/mappings', async (c) => {
  const rows = await all<{ headerSignature: string; name: string; mappingJson: string; accountId: number | null }>(
    c.env.DB,
    'SELECT header_signature AS headerSignature, name, mapping_json AS mappingJson, account_id AS accountId FROM import_mappings',
  );
  return c.json(rows.map((r) => ({ headerSignature: r.headerSignature, name: r.name, accountId: r.accountId, mapping: JSON.parse(r.mappingJson) })));
});

imports.put('/import/mappings', async (c) => {
  const body = await readBody(c);
  if (!body.mapping || typeof body.mapping !== 'object') throw badRequest('mapping is required');
  await run(
    c.env.DB,
    `INSERT INTO import_mappings (header_signature, name, mapping_json, account_id) VALUES (?, ?, ?, ?)
     ON CONFLICT (header_signature) DO UPDATE SET name = excluded.name, mapping_json = excluded.mapping_json,
       account_id = excluded.account_id`,
    reqStr(body.headerSignature, 'headerSignature', 1000),
    reqStr(body.name, 'name', 80),
    JSON.stringify(body.mapping),
    optInt(body.accountId, 'accountId', { min: 1 }) ?? null,
  );
  return c.json({ ok: true });
});
