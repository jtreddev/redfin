import type { Context } from 'hono';
import { isISODate, type ISODate, type MonthKey } from '../../shared/dates';

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502 | 503,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const notFound = (message = 'Not found') => new HttpError(404, message);

export async function readBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await c.req.json();
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw badRequest('Expected a JSON object');
}

type Absent = undefined;

export function optInt(
  value: unknown,
  name: string,
  { min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {},
): number | null | Absent {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    throw badRequest(`${name} must be a whole number${min > -Number.MAX_SAFE_INTEGER ? ` ≥ ${min}` : ''}`);
  }
  return n;
}

export function reqInt(value: unknown, name: string, opts?: { min?: number; max?: number }): number {
  const n = optInt(value, name, opts);
  if (n === undefined || n === null) throw badRequest(`${name} is required`);
  return n;
}

export function optNumber(value: unknown, name: string, { min = -Infinity, max = Infinity } = {}): number | null | Absent {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw badRequest(`${name} must be a number`);
  return n;
}

export function optStr(value: unknown, name: string, maxLength = 500): string | null | Absent {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw badRequest(`${name} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw badRequest(`${name} is too long`);
  return trimmed === '' ? null : trimmed;
}

export function reqStr(value: unknown, name: string, maxLength = 500): string {
  const s = optStr(value, name, maxLength);
  if (!s) throw badRequest(`${name} is required`);
  return s;
}

export function optBool(value: unknown, name: string): boolean | Absent {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw badRequest(`${name} must be true or false`);
  return value;
}

export function optDate(value: unknown, name: string): ISODate | null | Absent {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (!isISODate(value)) throw badRequest(`${name} must be a YYYY-MM-DD date`);
  return value;
}

export function reqDate(value: unknown, name: string): ISODate {
  const d = optDate(value, name);
  if (!d) throw badRequest(`${name} is required`);
  return d;
}

export function reqMonth(value: unknown, name = 'month'): MonthKey {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw badRequest(`${name} must be YYYY-MM`);
  }
  return value;
}

export function oneOf<T extends string>(value: unknown, name: string, allowed: readonly T[]): T | Absent {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw badRequest(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

export function paramId(c: Context, name = 'id'): number {
  const id = Number(c.req.param(name));
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Invalid id');
  return id;
}
