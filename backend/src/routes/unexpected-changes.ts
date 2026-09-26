/**
 * POST /api/unexpected-changes
 *
 * Executes the P14 Unexpected Change Detection engine.
 * Detects workspace changes not authorized by migration evidence.
 * Zero IBM Bob calls. Zero new commands — reuses P3 gitStatus().
 */

import { Router } from "express";
import type { Router as ExpressRouter } from "express";
import type { ApiResponse, UnexpectedChangeDetectionResult } from "@driftzero/shared";
import { ValidationError } from "@driftzero/shared";
import {
  detectUnexpectedChanges,
  unexpectedChangeInputSchema,
} from "../intelligence/unexpected-changes/index.js";

const router: ExpressRouter = Router();

/**
 * POST /api/unexpected-changes
 *
 * Request:  { workspace, migrationPlan, migrationResult, testGenerationResult?, recoveryResult? }
 * Response 200: { success: true, data: UnexpectedChangeDetectionResult }
 * Response 400: validation error
 */
router.post("/", async (req, res, next) => {
  const parsed = unexpectedChangeInputSchema.safeParse(req.body);
  if (!parsed.success) {
    const message = parsed.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    return next(new ValidationError(message));
  }

  try {
    const result = await detectUnexpectedChanges(parsed.data);
    const body: ApiResponse<UnexpectedChangeDetectionResult> = { success: true, data: result };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
});

export default router;
