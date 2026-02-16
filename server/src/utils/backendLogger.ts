import fs from "node:fs";
import path from "node:path";
import { dataRoot } from "./paths.js";

type BackendLogCategory = "endpoint" | "git" | "db";

type BackendLogFields = Record<string, unknown>;

const LOG_DIR = path.join(dataRoot, "logs");

const CATEGORY_FILE_MAP: Record<BackendLogCategory, string> = {
  endpoint: "backend-endpoints.log",
  git: "backend-git.log",
  db: "backend-db.log"
};

let dirReady = false;
const fileReady = new Set<string>();

function ensureLogFile(category: BackendLogCategory): string {
  if (!dirReady) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    dirReady = true;
  }

  const filename = CATEGORY_FILE_MAP[category];
  const filePath = path.join(LOG_DIR, filename);
  if (!fileReady.has(filePath)) {
    fs.closeSync(fs.openSync(filePath, "a"));
    fileReady.add(filePath);
  }
  return filePath;
}

function truncateText(value: string, maxLength = 8000): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...<truncated:${value.length - maxLength}>`;
}

function safeSerialize(input: unknown): unknown {
  const seen = new WeakSet<object>();

  function visit(value: unknown): unknown {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack
      };
    }
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (typeof value === "string") {
      return truncateText(value);
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => visit(item));
    }
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, fieldValue] of Object.entries(value)) {
      out[key] = visit(fieldValue);
    }
    return out;
  }

  return visit(input);
}

function writeCategoryLog(category: BackendLogCategory, event: string, fields?: BackendLogFields): void {
  const serializedFields = fields ? (safeSerialize(fields) as Record<string, unknown>) : undefined;
  const entry = {
    ts: new Date().toISOString(),
    category,
    event,
    ...(serializedFields ?? {})
  };

  const line = `${JSON.stringify(entry)}\n`;

  try {
    const filePath = ensureLogFile(category);
    fs.appendFile(filePath, line, (error) => {
      if (error) {
        console.error(`Failed to write ${category} log: ${String(error.message || error)}`);
      }
    });
  } catch (error) {
    console.error(`Failed to write ${category} log: ${String((error as Error)?.message || error)}`);
  }
}

export function logEndpoint(event: string, fields?: BackendLogFields): void {
  writeCategoryLog("endpoint", event, fields);
}

export function logGit(event: string, fields?: BackendLogFields): void {
  writeCategoryLog("git", event, fields);
}

export function logDb(event: string, fields?: BackendLogFields): void {
  writeCategoryLog("db", event, fields);
}

export function truncateForLog(value: string, maxLength = 8000): string {
  return truncateText(value, maxLength);
}
