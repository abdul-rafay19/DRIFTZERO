/**
 * POST /api/safety-gate
 *
 * Executes the P16 Migration Safety Gate.
 * Deterministic — zero Bob calls, zero command execution.
 * Produces SAFE_TO_PROCEED or STOP_SAFELY based on P11/P13/P14/P15 evidence.
 */

import { Router } from "express";
import type { Router as ExpressRouter } from "express";
import type { ApiResponse, SafetyGateResult } from "@driftzero/shared";
import { ValidationError } from "@driftzero/shared";
import { runSafetyGate, safetyGateInputSchema } from "../safety/index.js";

const router: ExpressRouter = Router();

/**
 * POST /api/safety-gate
 *
 * Request:  SafetyGateInput
 * Response 200: { success: true, data: SafetyGateResult }
 * Response 400: validation error
 */
router.post("/", (req, res, next) => {
  const parsed = safetyGateInputSchema.safeParse(req.body);
  if (!parsed.success) {
    const message = parsed.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    return next(new ValidationError(message));
  }

  try {
    // runSafetyGate is synchronous — no async needed
    // Cast: Zod infers z.string() for StepCategory; SafetyGateInput uses the
    // strict StepCategory union. The engine never reads migrationPlan.steps.category,
    // so this cast is safe.
    const result = runSafetyGate(parsed.data as unknown as Parameters<typeof runSafetyGate>[0]);
    const body: ApiResponse<SafetyGateResult> = { success: true, data: result };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
});

export default router;
