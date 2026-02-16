type StructuredLevel = "info" | "warn" | "error";

type StructuredLogFields = Record<string, unknown>;

function writeStructured(level: StructuredLevel, event: string, fields?: StructuredLogFields): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(fields ?? {})
  };
  const serialized = JSON.stringify(entry);
  if (level === "error") {
    console.error(serialized);
    return;
  }
  if (level === "warn") {
    console.warn(serialized);
    return;
  }
  console.info(serialized);
}

export function logInfo(event: string, fields?: StructuredLogFields): void {
  writeStructured("info", event, fields);
}

export function logWarn(event: string, fields?: StructuredLogFields): void {
  writeStructured("warn", event, fields);
}

export function logError(event: string, fields?: StructuredLogFields): void {
  writeStructured("error", event, fields);
}
