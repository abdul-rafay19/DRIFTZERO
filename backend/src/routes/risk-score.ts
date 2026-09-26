/**
 * POST /api/risk-score
 *
 * Calculates a deterministic migration risk score from P4 + P5 evidence.
 * The server always recalculates the score — client-supplied scores are ignored.
 * No IBM Bob calls. No filesystem access.
 */

import { Router } from "express";
import type { Router as ExpressRouter } from "express";
import type { ApiResponse, RiskScoreResult } from "@driftzero/shared";
import { ValidationError } from "@driftzero/shared";
import { calculateRiskScore } from "../intelligence/risk-score/index.js";
import { riskScoreInputSchema } from "../intelligence/risk-score/index.js";

const router: ExpressRouter = Router();

/**
 * POST /api/risk-score
 *
 * Request: { changeAnalysis: ChangeAnalysisResult, impactAnalysis: ImpactAnalysisResult }
 * Response 200: { success: true, data: RiskScoreResult }
 * Response 400: validation error
 */
router.post("/", (req, res, next) => {
  const parsed = riskScoreInputSchema.safeParse(req.body);
  if (!parsed.success) {
    const message = parsed.error.errors.map((e) => e.message).join("; ");
    return next(new ValidationError(message));
  }

  try {
    const result = calculateRiskScore(parsed.data);
    const body: ApiResponse<RiskScoreResult> = { success: true, data: result };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
});

export default router;
