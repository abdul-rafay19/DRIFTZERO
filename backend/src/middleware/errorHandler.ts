import type { Request, Response, NextFunction } from "express";
import { DriftZeroError } from "@driftzero/shared";
import { logger } from "../utils/logger.js";

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof DriftZeroError) {
    logger.error(`[${err.code}] ${err.message}`, { code: err.code, statusCode: err.statusCode });
    res.status(err.statusCode).json({
      success: false,
      error: err.message,
      code: err.code,
    });
    return;
  }

  // Unknown errors — log details server-side, never expose internals to client
  logger.error("Unexpected error", {
    message: err instanceof Error ? err.message : String(err),
  });

  res.status(500).json({
    success: false,
    error: "Internal server error",
    code: "INTERNAL_ERROR",
  });
}
