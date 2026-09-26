/**
 * POST /api/change-analysis
 *
 * Runs the Change Analysis Agent for a given package version transition.
 * Returns a structured, Bob-powered migration analysis.
 *
 * This endpoint is separate from the migration workflow.
 * It does NOT start a migration job or access any repository.
 */

import { Router } from "express";
import type { Router as ExpressRouter } from "express";
import { z } from "zod";
import type { ApiResponse, ChangeAnalysisResult } from "@driftzero/shared";
import { ValidationError } from "@driftzero/shared";
import { runChangeAnalysis } from "../agents/change-analysis/index.js";

const router: ExpressRouter = Router();

const requestSchema = z.object({
  packageName: z.string().min(1, "packageName is required"),
  sourceVersion: z.string().min(1, "sourceVersion is required"),
  targetVersion: z.string().min(1, "targetVersion is required"),
});

/**
 * POST /api/change-analysis
 *
 * Request:
 *   { "packageName": "express", "sourceVersion": "4", "targetVersion": "5" }
 *
 * Response 200:
 *   { "success": true, "data": ChangeAnalysisResult }
 *
 * Response 400: validation error
 * Response 502: Bob failure or malformed response
 * Response 504: timeout
 */
router.post("/", async (req, res, next) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    const message = parsed.error.errors.map((e) => e.message).join("; ");
    return next(new ValidationError(message));
  }

  try {
    const result = await runChangeAnalysis(parsed.data);
    const body: ApiResponse<ChangeAnalysisResult> = {
      success: true,
      data: result,
    };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
});

export default router;
