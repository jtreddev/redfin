// Calls the worker's API in-process, signed in through the local DEV_AUTH_BYPASS.
import worker from '../../src/worker/index';
import type { Env } from '../../src/worker/env';

export async function call(env: Env, request: Request): Promise<Response> {
  return worker.fetch!(request as never, env, {} as ExecutionContext);
}

/** Acts as `email` (default: the first person, you@example.com). */
export async function api(env: Env, method: string, path: string, body?: unknown, email?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (email) headers['x-dev-user'] = email;
  return call(
    { ...env, DEV_AUTH_BYPASS: 'you@example.com' },
    new Request(`http://localhost/api${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  );
}
