import type { Request, Response, NextFunction } from "express";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Central error handler — every route's async errors land here via the asyncHandler wrapper. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error("[error]", err);
  return res.status(500).json({ error: "Internal server error" });
}

type AsyncRoute = (req: Request, res: Response, next: NextFunction) => Promise<any>;

/** Wraps an async route handler so rejected promises reach errorHandler instead of hanging. */
export function asyncHandler(fn: AsyncRoute) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
