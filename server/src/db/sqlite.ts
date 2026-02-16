import Database from "better-sqlite3";

const SQLITE_BUSY_TIMEOUT_MS = 5000;

export function applyStandardSqlitePragmas(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
}

export function openSqliteDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  applyStandardSqlitePragmas(db);
  return db;
}
