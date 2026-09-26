/**
 * POST /api/impact-preview
 *
 * Generates a deterministic "What Will Break?" preview from P4/P5/P6 evidence.
 * No IBM Bob calls. No filesystem access. No command execution.
 */

import { Router } from "express";
import type { Router as ExpressRouter } from "express";
import type { ApiResponse, ImpactPreviewResult } from "@driftzero/shared";
import { ValidationError } from "@driftzero/shared";
import {
  generateImpactPreview,
  impactPreviewInputSchema,
} from "../intelligence/impact-preview/index.js";

const router: ExpressRouter = Router();

/**
 * POST /api/impact-preview
 *
 * Request: { changeAnalysis: ChangeAnalysisResult, impactAnalysis: ImpactAnalysisResult, riskScore: RiskScoreResult }
 * Response 200: { success: true, data: ImpactPreviewResult }
 * Response 400: validation error
 */
router.post("/", (req, res, next) => {
  const parsed = impactPreviewInputSchema.safeParse(req.body);
  if (!parsed.success) {
    const message = parsed.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    return next(new ValidationError(message));
  }

  try {
    const result = generateImpactPreview(parsed.data);
    const body: ApiResponse<ImpactPreviewResult> = { success: true, data: result };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
});

export default router;
