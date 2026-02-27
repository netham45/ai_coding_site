import type { NextFunction, Request, Response } from "express";
import { db, ensureLocalUser } from "../db/index.js";
import type { UserRow } from "../types.js";

declare global {
  namespace Express {
    interface Request {
      user: UserRow;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const headerUserId = req.header("x-user-id");
  const userId = headerUserId || ensureLocalUser();

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
  if (!user) {
    res.status(401).json({ error: "Unknown user" });
    return;
  }

  req.user = user;
  next();
}
