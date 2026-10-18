import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { all, nowIso, run } from '../lib/db';
import { optInt, readBody } from '../lib/http';
import { loadIngestContext } from '../services/context';
import { reclassify, STORED_SELECT, type StoredTxn } from '../services/ingest';

export const categorize = new Hono<AppEnv>();

/** Small enough to stay well inside the free plan's 10 ms CPU per request, even on a cold isolate. */
const BATCH = 200;

/**
 * Re-derives automatic categories for one batch of history (hand-set and split rows are skipped by reclassify).
 * Runs across every household row regardless of viewer: it only recomputes automatic choices and returns counts.
 */
categorize.post('/categorize/all', async (c) => {
  const db = c.env.DB;
  const afterId = optInt((await readBody(c)).afterId, 'afterId', { min: 0 }) ?? 0;
  const rows = await all<StoredTxn>(
    db,
    `${STORED_SELECT} WHERE t.deleted_at IS NULL AND t.id > ? ORDER BY t.id LIMIT ?`,
    afterId,
    BATCH,
  );
  const ctx = await loadIngestContext(db);
  const updated = await reclassify(db, ctx, rows);
  const nextAfterId = rows.length === BATCH ? rows[rows.length - 1]!.id : null;
  if (nextAfterId === null) {
    const now = nowIso();
    await run(db, 'UPDATE household SET categorized_all_at = ?, updated_at = ? WHERE id = 1', now, now);
  }
  return c.json({ updated, nextAfterId });
});
