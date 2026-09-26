/**
 * POST /api/recovery
 *
 * Executes the P12 Autonomous Recovery Engine.
 * When P11 reports FAILED, this endpoint runs bounded autonomous repair.
 * IBM Bob diagnoses failures and proposes repairs; DRIFTZERO validates and applies them.
 */

import { Router } from "express";
import type { Router as ExpressRouter } from "express";
import type { ApiResponse, RecoveryResult } from "@driftzero/shared";
import { ValidationError } from "@driftzero/shared";
import { runRecovery, recoveryInputSchema } from "../recovery/index.js";

const router: ExpressRouter = Router();

/**
 * POST /api/recovery
 *
 * Request:  { workspace, migrationPlan, migrationResult, testGenerationResult?, validationResult }
 * Response 200: { success: true, data: RecoveryResult }
 * Response 400: validation error
 */
router.post("/", async (req, res, next) => {
  const parsed = recoveryInputSchema.safeParse(req.body);
  if (!parsed.success) {
    const message = parsed.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    return next(new ValidationError(message));
  }

  try {
    const result = await runRecovery(parsed.data);
    const body: ApiResponse<RecoveryResult> = { success: true, data: result };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
});

export default router;
