import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import type { UserSettingsRow } from "../types.js";
import { nowIso } from "../utils/time.js";
import { recordEvent } from "../services/events.js";

const FALLBACK_AI_COMMAND = "codex --yolo {prompt}";

const patchSchema = z.object({
  defaultAiCommand: z.string().min(1).max(500).optional(),
  defaultAiCommands: z.array(z.string().min(1).max(500)).min(1).max(50).optional()
});

export const settingsRouter = Router();

function normalizeCommands(commands: string[]): string[] {
  const unique = new Set<string>();
  for (const command of commands) {
    const trimmed = command.trim();
    if (trimmed) {
      unique.add(trimmed);
    }
  }
  const next = [...unique];
  return next.length ? next : [FALLBACK_AI_COMMAND];
}

function parseStoredCommands(row: Pick<UserSettingsRow, "default_ai_commands" | "default_ai_command">): string[] {
  try {
    const parsed = JSON.parse(row.default_ai_commands);
    if (Array.isArray(parsed)) {
      return normalizeCommands(parsed.filter((value): value is string => typeof value === "string"));
    }
  } catch {
    // Fall through to legacy command.
  }
  return normalizeCommands([row.default_ai_command || FALLBACK_AI_COMMAND]);
}

settingsRouter.get("/", (req, res) => {
  const row = db.prepare("SELECT * FROM user_settings WHERE user_id = ?").get(req.user.id) as UserSettingsRow;
  const defaultAiCommands = parseStoredCommands(row);
  res.json({
    settings: {
      userId: row.user_id,
      defaultAiCommand: defaultAiCommands[0],
      defaultAiCommands,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  });
});

settingsRouter.patch("/", (req, res) => {
  const parsed = patchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const current = db.prepare("SELECT * FROM user_settings WHERE user_id = ?").get(req.user.id) as UserSettingsRow;
  if (!current) {
    res.status(404).json({ error: "Settings not found" });
    return;
  }

  const input = parsed.data;
  const currentCommands = parseStoredCommands(current);
  const nextCommands = input.defaultAiCommands
    ? normalizeCommands(input.defaultAiCommands)
    : input.defaultAiCommand
      ? normalizeCommands([input.defaultAiCommand, ...currentCommands.filter((command) => command !== input.defaultAiCommand)])
      : currentCommands;
  const nextAi = nextCommands[0];
  db.prepare("UPDATE user_settings SET default_ai_command = ?, default_ai_commands = ?, updated_at = ? WHERE user_id = ?").run(
    nextAi,
    JSON.stringify(nextCommands),
    nowIso(),
    req.user.id
  );

  recordEvent({
    eventType: "user_settings.updated",
    payload: { userId: req.user.id, defaultAiCommand: nextAi, defaultAiCommands: nextCommands }
  });

  const updated = db.prepare("SELECT * FROM user_settings WHERE user_id = ?").get(req.user.id) as UserSettingsRow;
  const defaultAiCommands = parseStoredCommands(updated);
  res.json({
    settings: {
      userId: updated.user_id,
      defaultAiCommand: defaultAiCommands[0],
      defaultAiCommands,
      createdAt: updated.created_at,
      updatedAt: updated.updated_at
    }
  });
});
