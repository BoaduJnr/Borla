import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../utils/jwt.js";
import { queryOne } from "../db/pool.js";
import type { AuthedUser, Role } from "../types.js";

/** Requires a valid access token; loads the current user row onto req.user. */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing bearer token" });
  }
  try {
    const payload = verifyAccessToken(header.slice("Bearer ".length));
    if (payload.type !== "access") throw new Error("wrong token type");
    const user = await queryOne<AuthedUser>(
      `SELECT id, role, phone, verified, suspended, display_name FROM users WHERE id = $1`,
      [payload.sub]
    );
    if (!user) return res.status(401).json({ error: "User not found" });
    if (user.suspended) return res.status(403).json({ error: "Account suspended" });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/** Restricts a route to one or more roles. Use after requireAuth. */
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden for this role" });
    }
    next();
  };
}
