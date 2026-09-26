/**
 * POST /api/impact-analysis
 *
 * Runs the Impact Analysis Agent against a given workspace.
 * Returns a structured repository impact map driven by the P4 change analysis.
 *
 * This is a development/proof endpoint.
 * It is separate from the migration workflow.
 */

import { Router } from "express";
import type { Router as ExpressRouter } from "express";
import { z } from "zod";
import type { ApiResponse, ImpactAnalysisResult } from "@driftzero/shared";
import { ValidationError } from "@driftzero/shared";
import { runImpactAnalysis } from "../agents/impact-analysis/index.js";
import { changeAnalysisResultSchema } from "../agents/impact-analysis/impact-analysis-types.js";

const router: ExpressRouter = Router();

const requestSchema = z.object({
  workspacePath: z.string().min(1, "workspacePath is required"),
  packageName: z.string().min(1, "packageName is required"),
  sourceVersion: z.string().min(1, "sourceVersion is required"),
  targetVersion: z.string().min(1, "targetVersion is required"),
  changeAnalysis: changeAnalysisResultSchema,
});

/**
 * POST /api/impact-analysis
 *
 * Request: ImpactAnalysisInput
 * Response 200: { success: true, data: ImpactAnalysisResult }
 * Response 400: validation error
 * Response 500: workspace error or scan failure
 */
router.post("/", async (req, res, next) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    const message = parsed.error.errors.map((e) => e.message).join("; ");
    return next(new ValidationError(message));
  }

  try {
    const result = await runImpactAnalysis(parsed.data);
    const body: ApiResponse<ImpactAnalysisResult> = { success: true, data: result };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
});

export default router;
