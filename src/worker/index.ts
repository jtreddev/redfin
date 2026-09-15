import { Hono } from 'hono';
import type { AppEnv, Env } from './env';
import { HttpError } from './lib/http';
import { requireViewer } from './middleware/auth';
import { PlaidError } from './plaid/client';
import { runCron } from './plaid/sync';
import { budget } from './routes/budget';
import { core } from './routes/core';
import { exportRoutes } from './routes/export';
import { imports } from './routes/imports';
import { planning } from './routes/planning';
import { plaidRoutes } from './routes/plaid';
import { rules } from './routes/rules';
import { transactions } from './routes/transactions';

const app = new Hono<AppEnv>();

app.onError((error, c) => {
  if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
  if (error instanceof PlaidError) {
    const status = error.status === 503 ? 503 : error.status >= 500 ? 502 : 400;
    return c.json({ error: error.message, code: error.code }, status);
  }
  console.error(error);
  return c.json({ error: 'Something went wrong. Please try again.' }, 500);
});

app.use('/api/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});
app.use('/api/*', requireViewer);

for (const routes of [core, transactions, rules, imports, budget, plaidRoutes, planning, exportRoutes]) {
  app.route('/api', routes);
}
app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

// Everything else is the React app (static assets with SPA fallback).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
} satisfies ExportedHandler<Env>;
