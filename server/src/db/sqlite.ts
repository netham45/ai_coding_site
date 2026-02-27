import path from "node:path";
import Database from "better-sqlite3";
import { logDb } from "../utils/backendLogger.js";
import { runningTests, workspaceRoot } from "../utils/paths.js";

const SQLITE_BUSY_TIMEOUT_MS = 5000;
const INSTRUMENTED_DB = Symbol("instrumented_db");
const INSTRUMENTED_STATEMENT = Symbol("instrumented_statement");
const STATIC_PROTECTED_TEST_ROOTS = [path.resolve(path.sep, "repo"), path.resolve(path.sep, "repos"), path.resolve(path.sep, "data")];
const WORKSPACE_PROTECTED_TEST_ROOTS = [path.join(workspaceRoot, "repos"), path.join(workspaceRoot, "data")];

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function durationMs(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

function normalizePathForComparison(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  const normalizedSeparators = resolved.replaceAll("\\", "/");
  return process.platform === "win32" ? normalizedSeparators.toLowerCase() : normalizedSeparators;
}

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const candidate = normalizePathForComparison(candidatePath);
  const root = normalizePathForComparison(rootPath);
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function assertTestSafeSqlitePath(dbPath: string): void {
  if (!runningTests) {
    return;
  }
  const protectedRoots = [...STATIC_PROTECTED_TEST_ROOTS, ...WORKSPACE_PROTECTED_TEST_ROOTS];
  if (protectedRoots.some((root) => isPathInsideRoot(dbPath, root))) {
    throw new Error(
      `[test-safety] Refusing to open sqlite path in protected root during tests: ${path.resolve(dbPath)}`
    );
  }
}

function sanitizeStatementResult(method: "run" | "get" | "all" | "iterate", result: unknown): Record<string, unknown> {
  if (method === "run" && result && typeof result === "object") {
    const runResult = result as { changes?: number; lastInsertRowid?: number | bigint };
    return {
      changes: runResult.changes ?? 0,
      lastInsertRowid: runResult.lastInsertRowid ?? null
    };
  }
  if (method === "all" && Array.isArray(result)) {
    return {
      rowCount: result.length
    };
  }
  if (method === "get") {
    return {
      rowFound: result !== undefined
    };
  }
  if (method === "iterate") {
    return {
      iteratorCreated: true
    };
  }
  return {};
}

function instrumentStatement(statement: any, dbPath: string, sql: string): any {
  if (!statement || statement[INSTRUMENTED_STATEMENT]) {
    return statement;
  }
  statement[INSTRUMENTED_STATEMENT] = true;

  const normalizedSql = normalizeSql(sql);
  const methods: Array<"run" | "get" | "all" | "iterate"> = ["run", "get", "all", "iterate"];

  for (const method of methods) {
    if (typeof statement[method] !== "function") {
      continue;
    }
    const original = statement[method].bind(statement);
    statement[method] = (...args: unknown[]) => {
      const started = process.hrtime.bigint();
      logDb(`db.statement.${method}.start`, {
        dbPath,
        sql: normalizedSql,
        args
      });
      try {
        const result = original(...args);
        logDb(`db.statement.${method}.success`, {
          dbPath,
          sql: normalizedSql,
          args,
          durationMs: durationMs(started),
          ...sanitizeStatementResult(method, result)
        });
        return result;
      } catch (error) {
        logDb(`db.statement.${method}.failure`, {
          dbPath,
          sql: normalizedSql,
          args,
          durationMs: durationMs(started),
          error
        });
        throw error;
      }
    };
  }

  const chainMethods: Array<"bind" | "pluck" | "expand" | "raw" | "safeIntegers"> = [
    "bind",
    "pluck",
    "expand",
    "raw",
    "safeIntegers"
  ];

  for (const method of chainMethods) {
    if (typeof statement[method] !== "function") {
      continue;
    }
    const original = statement[method].bind(statement);
    statement[method] = (...args: unknown[]) => {
      logDb(`db.statement.${method}`, {
        dbPath,
        sql: normalizedSql,
        args
      });
      const nextStatement = original(...args);
      return instrumentStatement(nextStatement, dbPath, sql);
    };
  }

  return statement;
}

function instrumentDatabase(db: Database.Database, dbPath: string): Database.Database {
  const maybeInstrumented = db as Database.Database & { [INSTRUMENTED_DB]?: boolean };
  if (maybeInstrumented[INSTRUMENTED_DB]) {
    return db;
  }
  maybeInstrumented[INSTRUMENTED_DB] = true;

  const originalPrepare = db.prepare.bind(db);
  const originalExec = db.exec.bind(db);
  const originalPragma = db.pragma.bind(db);

  db.prepare = ((sql: string) => {
    logDb("db.prepare", {
      dbPath,
      sql: normalizeSql(sql)
    });
    const statement = originalPrepare(sql);
    return instrumentStatement(statement, dbPath, sql);
  }) as typeof db.prepare;

  db.exec = ((sql: string) => {
    const started = process.hrtime.bigint();
    const normalizedSql = normalizeSql(sql);
    logDb("db.exec.start", {
      dbPath,
      sql: normalizedSql
    });
    try {
      const result = originalExec(sql);
      logDb("db.exec.success", {
        dbPath,
        sql: normalizedSql,
        durationMs: durationMs(started)
      });
      return result;
    } catch (error) {
      logDb("db.exec.failure", {
        dbPath,
        sql: normalizedSql,
        durationMs: durationMs(started),
        error
      });
      throw error;
    }
  }) as typeof db.exec;

  db.pragma = ((source: string, options?: Database.PragmaOptions) => {
    const started = process.hrtime.bigint();
    const normalizedSql = normalizeSql(source);
    logDb("db.pragma.start", {
      dbPath,
      pragma: normalizedSql,
      options
    });
    try {
      const result = originalPragma(source, options as any);
      logDb("db.pragma.success", {
        dbPath,
        pragma: normalizedSql,
        options,
        durationMs: durationMs(started)
      });
      return result;
    } catch (error) {
      logDb("db.pragma.failure", {
        dbPath,
        pragma: normalizedSql,
        options,
        durationMs: durationMs(started),
        error
      });
      throw error;
    }
  }) as typeof db.pragma;

  return db;
}

export function applyStandardSqlitePragmas(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
}

export function openSqliteDatabase(dbPath: string): Database.Database {
  assertTestSafeSqlitePath(dbPath);
  logDb("db.open.start", { dbPath });
  const started = process.hrtime.bigint();
  const db = instrumentDatabase(new Database(dbPath), dbPath);
  logDb("db.open.success", { dbPath, durationMs: durationMs(started) });
  applyStandardSqlitePragmas(db);
  return db;
}
