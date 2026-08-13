import type { Request, Response, NextFunction } from "express";
import type { ZodSchema } from "zod";

/** Validates req.body against a zod schema; replaces req.body with the parsed/typed value. */
export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: result.error.flatten(),
      });
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: result.error.flatten(),
      });
    }
    // Overwrite in place; req.query is otherwise read-only-ish depending on Express version.
    (req as any).query = result.data;
    next();
  };
}
