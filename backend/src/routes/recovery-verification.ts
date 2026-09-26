/**
 * POST /api/recovery-verification
 *
 * Executes the P13 Recovery Verification engine.
 * Deterministically verifies that P12 recovery evidence is valid, complete,
 * and consistent.  Zero IBM Bob calls.  Zero commands executed.
 */

import { Router } from "express";
import type { Router as ExpressRouter } from "express";
import type { ApiResponse, RecoveryVerificationResult } from "@driftzero/shared";
import { ValidationError } from "@driftzero/shared";
import {
  verifyRecovery,
  recoveryVerificationInputSchema,
} from "../recovery/index.js";

const router: ExpressRouter = Router();

/**
 * POST /api/recovery-verification
 *
 * Request:  { workspace, migrationPlan, migrationResult, testGenerationResult?,
 *             initialValidation, recoveryResult }
 * Response 200: { success: true, data: RecoveryVerificationResult }
 * Response 400: validation error
 */
router.post("/", (req, res, next) => {
  const parsed = recoveryVerificationInputSchema.safeParse(req.body);
  if (!parsed.success) {
    const message = parsed.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    return next(new ValidationError(message));
  }

  try {
    // verifyRecovery is synchronous and pure — no async needed
    const result = verifyRecovery(parsed.data);
    const body: ApiResponse<RecoveryVerificationResult> = { success: true, data: result };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
});

export default router;
