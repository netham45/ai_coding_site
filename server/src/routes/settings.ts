import { Router } from "express";
import { z } from "zod";
import { appDb } from "../db/index.js";
import type { UserSettingsRow } from "../types.js";
import { nowIso } from "../utils/time.js";
import { recordEvent } from "../services/events.js";

const patchSchema = z.object({
  defaultAiCommand: z.string().min(1).max(500).optional()
});

export const settingsRouter = Router();

settingsRouter.get("/", (req, res) => {
  const row = appDb.prepare("SELECT * FROM user_settings WHERE user_id = ?").get(req.user.id) as UserSettingsRow;
  res.json({
    settings: {
      userId: row.user_id,
      defaultAiCommand: row.default_ai_command,
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

  const current = appDb.prepare("SELECT * FROM user_settings WHERE user_id = ?").get(req.user.id) as UserSettingsRow;
  if (!current) {
    res.status(404).json({ error: "Settings not found" });
    return;
  }

  const input = parsed.data;
  const nextAi = input.defaultAiCommand ?? current.default_ai_command;
  appDb.prepare("UPDATE user_settings SET default_ai_command = ?, updated_at = ? WHERE user_id = ?").run(nextAi, nowIso(), req.user.id);

  recordEvent({
    eventType: "user_settings.updated",
    payload: { userId: req.user.id, defaultAiCommand: nextAi }
  });

  const updated = appDb.prepare("SELECT * FROM user_settings WHERE user_id = ?").get(req.user.id) as UserSettingsRow;
  res.json({
    settings: {
      userId: updated.user_id,
      defaultAiCommand: updated.default_ai_command,
      createdAt: updated.created_at,
      updatedAt: updated.updated_at
    }
  });
});
