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
const MAX_QUEUE_LINES = Number(process.env.AI_CODING_LOG_QUEUE_MAX_LINES ?? 50_000);

type CategoryWriter = {
  category: BackendLogCategory;
  filePath: string;
  stream: fs.WriteStream;
  queue: string[];
  waitingForDrain: boolean;
  droppedLines: number;
};

const writersByCategory = new Map<BackendLogCategory, CategoryWriter>();
let shutdownHooksInstalled = false;

function ensureLogFile(category: BackendLogCategory): string {
  if (!dirReady) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    dirReady = true;
  }

  const filename = CATEGORY_FILE_MAP[category];
  const filePath = path.join(LOG_DIR, filename);
  return filePath;
}

function flushWriter(writer: CategoryWriter): void {
  if (writer.waitingForDrain) {
    return;
  }
  while (writer.queue.length > 0) {
    const line = writer.queue.shift();
    if (typeof line !== "string") {
      return;
    }
    const canContinue = writer.stream.write(line);
    if (!canContinue) {
      writer.waitingForDrain = true;
      return;
    }
  }
}

function installShutdownHooks(): void {
  if (shutdownHooksInstalled) {
    return;
  }
  shutdownHooksInstalled = true;

  process.once("beforeExit", () => {
    for (const writer of writersByCategory.values()) {
      if (!writer.stream.destroyed) {
        writer.stream.end();
      }
    }
  });

  process.once("exit", () => {
    for (const writer of writersByCategory.values()) {
      if (!writer.stream.destroyed) {
        writer.stream.destroy();
      }
    }
  });
}

function getCategoryWriter(category: BackendLogCategory): CategoryWriter {
  const existing = writersByCategory.get(category);
  if (existing) {
    return existing;
  }

  const filePath = ensureLogFile(category);
  const stream = fs.createWriteStream(filePath, { flags: "a" });
  const writer: CategoryWriter = {
    category,
    filePath,
    stream,
    queue: [],
    waitingForDrain: false,
    droppedLines: 0
  };

  stream.on("drain", () => {
    writer.waitingForDrain = false;
    flushWriter(writer);
  });

  stream.on("error", (error) => {
    console.error(`Failed to write ${category} log: ${String(error.message || error)}`);
  });

  writersByCategory.set(category, writer);
  installShutdownHooks();
  return writer;
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
    const writer = getCategoryWriter(category);
    if (writer.queue.length >= MAX_QUEUE_LINES) {
      writer.droppedLines += 1;
      if (writer.droppedLines % 1000 === 1) {
        console.error(
          `Dropping ${category} log lines due to writer queue saturation: dropped=${writer.droppedLines} file=${writer.filePath}`
        );
      }
      return;
    }
    if (writer.droppedLines > 0) {
      const droppedNotice = {
        ts: new Date().toISOString(),
        category,
        event: "logger.lines_dropped",
        droppedLines: writer.droppedLines
      };
      writer.queue.push(`${JSON.stringify(droppedNotice)}\n`);
      writer.droppedLines = 0;
    }
    writer.queue.push(line);
    flushWriter(writer);
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
