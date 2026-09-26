/**
 * POST /api/diff-intelligence
 *
 * Executes the P17 Diff Intelligence analysis.
 * Reads git diff from workspace, correlates with P8–P16 evidence,
 * and returns structured diff analysis.
 *
 * 0 Bob calls. Read-only.
 */

import { Router } from "express";
import type { Router as ExpressRouter } from "express";
import type { ApiResponse, DiffIntelligenceResult } from "@driftzero/shared";
import { ValidationError } from "@driftzero/shared";
import {
  runDiffIntelligence,
  diffIntelligenceInputSchema,
} from "../intelligence/diff-intelligence/index.js";

const router: ExpressRouter = Router();

/**
 * POST /api/diff-intelligence
 *
 * Request:  DiffIntelligenceInput
 * Response 201: { success: true, data: DiffIntelligenceResult }
 * Response 400: validation error
 */
router.post("/", async (req, res, next) => {
  const parsed = diffIntelligenceInputSchema.safeParse(req.body);
  if (!parsed.success) {
    const message = parsed.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    return next(new ValidationError(message));
  }

  try {
    // Cast: Zod infers z.string() for StepCategory; DiffIntelligenceInput uses strict StepCategory union.
    // The engine uses step.category only for classification — this cast is safe.
    const result = await runDiffIntelligence(
      parsed.data as unknown as Parameters<typeof runDiffIntelligence>[0]
    );
    const body: ApiResponse<DiffIntelligenceResult> = { success: true, data: result };
    res.status(201).json(body);
  } catch (err) {
    next(err);
  }
});

export default router;
