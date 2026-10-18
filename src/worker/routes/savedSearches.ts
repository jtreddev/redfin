import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { all, first, run, Updates } from '../lib/db';
import { badRequest, notFound, optStr, paramId, readBody, reqStr } from '../lib/http';

export const savedSearches = new Hono<AppEnv>();

const MAX_PER_PERSON = 50;

/** A person's saved Activity searches. Strictly their own: a partner's id answers 404. */
savedSearches.get('/saved-searches', async (c) => {
  return c.json(
    await all(
      c.env.DB,
      'SELECT id, name, query, sort, created_at AS createdAt FROM saved_searches WHERE member_id = ? ORDER BY id',
      c.get('viewer').memberId,
    ),
  );
});

savedSearches.post('/saved-searches', async (c) => {
  const db = c.env.DB;
  const memberId = c.get('viewer').memberId;
  const body = await readBody(c);
  const name = reqStr(body.name, 'name', 60);
  const query = reqStr(body.query, 'query', 1000);
  const sort = optStr(body.sort, 'sort', 40) ?? null;
  const count = (await first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM saved_searches WHERE member_id = ?', memberId))?.n ?? 0;
  if (count >= MAX_PER_PERSON) throw badRequest('That’s a lot of saved searches. Delete one first.');
  const row = await first(
    db,
    'INSERT INTO saved_searches (member_id, name, query, sort) VALUES (?, ?, ?, ?) RETURNING id, name, query, sort, created_at AS createdAt',
    memberId,
    name,
    query,
    sort,
  );
  return c.json(row, 201);
});

savedSearches.patch('/saved-searches/:id', async (c) => {
  const body = await readBody(c);
  const updates = new Updates()
    .set('name', body.name === undefined ? undefined : reqStr(body.name, 'name', 60))
    .set('query', body.query === undefined ? undefined : reqStr(body.query, 'query', 1000))
    .set('sort', optStr(body.sort, 'sort', 40));
  if (updates.empty) throw badRequest('Nothing to update');
  const result = await run(
    c.env.DB,
    `UPDATE saved_searches SET ${updates.sets.join(', ')} WHERE id = ? AND member_id = ?`,
    ...updates.params,
    paramId(c),
    c.get('viewer').memberId,
  );
  if (!result.meta.changes) throw notFound('Saved search not found');
  return c.json({ ok: true });
});

savedSearches.delete('/saved-searches/:id', async (c) => {
  const result = await run(c.env.DB, 'DELETE FROM saved_searches WHERE id = ? AND member_id = ?', paramId(c), c.get('viewer').memberId);
  if (!result.meta.changes) throw notFound('Saved search not found');
  return c.json({ ok: true });
});
