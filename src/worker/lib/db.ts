export type Param = string | number | boolean | null | undefined;

const clean = (params: readonly Param[]) =>
  params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));

export function stmt(db: D1Database, sql: string, ...params: Param[]): D1PreparedStatement {
  return db.prepare(sql).bind(...clean(params));
}

export async function all<T>(db: D1Database, sql: string, ...params: Param[]): Promise<T[]> {
  const result = await stmt(db, sql, ...params).all<T>();
  return result.results ?? [];
}

export async function first<T>(db: D1Database, sql: string, ...params: Param[]): Promise<T | null> {
  return (await stmt(db, sql, ...params).first<T>()) ?? null;
}

export async function run(db: D1Database, sql: string, ...params: Param[]): Promise<D1Result> {
  return stmt(db, sql, ...params).run();
}

export const nowIso = () => new Date().toISOString();

/** D1 allows at most 100 bound parameters per statement; keep IN lists and batches small. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/** Collects "column = ?" pairs for an UPDATE, skipping fields that weren't sent. */
export class Updates {
  readonly sets: string[] = [];
  readonly params: Param[] = [];

  set(column: string, value: Param): this {
    if (value !== undefined) {
      this.sets.push(`${column} = ?`);
      this.params.push(value);
    }
    return this;
  }

  get empty(): boolean {
    return this.sets.length === 0;
  }
}

/** SELECTs with WHERE x IN (...) over any number of values. */
export async function allByIds<T>(
  db: D1Database,
  sqlWithIn: (inList: string) => string,
  ids: readonly (number | string)[],
  ...extra: Param[]
): Promise<T[]> {
  const out: T[] = [];
  for (const group of chunk([...new Set(ids)], 90)) {
    out.push(...(await all<T>(db, sqlWithIn(placeholders(group.length)), ...group, ...extra)));
  }
  return out;
}

/** Runs statements through db.batch in groups (each batch is atomic). */
export async function batchAll(db: D1Database, statements: readonly D1PreparedStatement[], size = 50): Promise<D1Result[]> {
  const results: D1Result[] = [];
  for (const group of chunk(statements, size)) {
    if (group.length) results.push(...(await db.batch(group)));
  }
  return results;
}
