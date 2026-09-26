/**
 * POST /api/validation
 *
 * Executes the P11 Validation Engine against a P3 workspace.
 * Runs the repository's configured validation commands (deps, typecheck, build, test).
 * Returns structured evidence for every check.  Zero IBM Bob calls.
 */

import { Router } from "express";
import type { Router as ExpressRouter } from "express";
import type { ApiResponse, ValidationResult } from "@driftzero/shared";
import { ValidationError } from "@driftzero/shared";
import { runValidation, validationInputSchema } from "../validation/index.js";

const router: ExpressRouter = Router();

/**
 * POST /api/validation
 *
 * Request:  { workspace, migrationPlan, migrationResult?, testGenerationResult? }
 * Response 200: { success: true, data: ValidationResult }
 * Response 400: validation error
 */
router.post("/", async (req, res, next) => {
  const parsed = validationInputSchema.safeParse(req.body);
  if (!parsed.success) {
    const message = parsed.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    return next(new ValidationError(message));
  }

  try {
    const result = await runValidation(parsed.data);
    const body: ApiResponse<ValidationResult> = { success: true, data: result };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
});

export default router;
