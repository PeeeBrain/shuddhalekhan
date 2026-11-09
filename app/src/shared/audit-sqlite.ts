import { createRequire } from 'module';

const require = createRequire(import.meta.url);

type SqliteDatabase = {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    finalize?(): unknown;
  };
  close(): unknown;
};

export function openAuditDatabase(path: string): SqliteDatabase {
  const Database = (typeof process.versions.bun === 'string'
    ? require('bun:sqlite').Database : require('better-sqlite3')) as new (path: string) => SqliteDatabase;
  return new Database(path);
}
