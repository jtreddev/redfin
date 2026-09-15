export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

const DEV_USER_KEY = 'fin.devUser';
const RELOAD_KEY = 'fin.authReloadAt';

/** Local development only: which household member to act as. */
export function getDevUser(): string | null {
  try {
    return localStorage.getItem(DEV_USER_KEY);
  } catch {
    return null;
  }
}

export function setDevUser(email: string | null) {
  try {
    if (email) localStorage.setItem(DEV_USER_KEY, email);
    else localStorage.removeItem(DEV_USER_KEY);
  } catch {
    // storage unavailable
  }
}

/** When the Cloudflare Access session expires, reload once so Access can sign you back in. */
function reauthenticate() {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < 30_000) return;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // storage unavailable; reload anyway
  }
  window.location.reload();
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const devUser = import.meta.env.DEV ? getDevUser() : null;
  if (devUser) headers['x-dev-user'] = devUser;

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: 'same-origin',
      redirect: 'manual',
    });
  } catch {
    throw new ApiError(0, 'You appear to be offline.');
  }

  if (response.type === 'opaqueredirect' || (response.status === 401 && !import.meta.env.DEV)) {
    reauthenticate();
    throw new ApiError(401, 'Signing you in again…');
  }

  const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
  const data: unknown = isJson ? await response.json().catch(() => null) : null;
  if (!response.ok) {
    const body = (data ?? {}) as { error?: string; code?: string };
    throw new ApiError(response.status, body.error ?? `Request failed (${response.status})`, body.code);
  }
  return data as T;
}

export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
