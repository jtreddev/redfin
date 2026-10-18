// A small D1 stand-in on node:sqlite, so worker code can run against the real schema in tests.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

type Row = Record<string, unknown>;

interface Result {
  results: Row[];
  success: true;
  meta: { changes: number; last_row_id: number };
}

class Statement {
  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly sql: string,
    private readonly params: SQLInputValue[] = [],
  ) {}

  bind(...params: unknown[]): Statement {
    return new Statement(this.sqlite, this.sql, params as SQLInputValue[]);
  }

  /** Runs the statement; rows come back for SELECT and for RETURNING. */
  execute(): Result {
    const prepared = this.sqlite.prepare(this.sql);
    if (prepared.columns().length > 0) {
      const results = prepared.all(...this.params) as Row[];
      return { results, success: true, meta: { changes: this.changes(), last_row_id: 0 } };
    }
    const info = prepared.run(...this.params);
    return { results: [], success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }

  private changes(): number {
    return Number((this.sqlite.prepare('SELECT changes() AS n').get() as { n: number }).n);
  }

  async all<T>() {
    return this.execute() as unknown as { results: T[] };
  }

  async first<T>(): Promise<T | null> {
    return (this.execute().results[0] as T | undefined) ?? null;
  }

  async run() {
    return this.execute();
  }
}

const MIGRATIONS = join(import.meta.dirname, '../../migrations');

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
}

export class TestD1 {
  readonly sqlite = new DatabaseSync(':memory:');

  /** Applies every migration, or only those up to and including `upTo` (a prefix like '0002'). */
  constructor(options: { upTo?: string } = {}) {
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    for (const file of migrationFiles()) {
      if (options.upTo && file.slice(0, options.upTo.length) > options.upTo) break;
      this.migrate(file);
    }
  }

  /** Applies one migration, named by its file name or number prefix ('0003'). */
  migrate(prefix: string): void {
    const file = migrationFiles().find((f) => f.startsWith(prefix));
    if (!file) throw new Error(`No migration ${prefix}`);
    this.sqlite.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }

  prepare(sql: string): Statement {
    return new Statement(this.sqlite, sql);
  }

  /** Like D1: all statements succeed together or none do. */
  async batch(statements: Statement[]): Promise<Result[]> {
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map((s) => s.execute());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  rows<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.sqlite.prepare(sql).all(...params) as T[];
  }

  exec(sql: string, ...params: SQLInputValue[]): void {
    this.sqlite.prepare(sql).run(...params);
  }

  /** The D1Database type, for passing to worker code. */
  get d1(): D1Database {
    return this as unknown as D1Database;
  }
}
