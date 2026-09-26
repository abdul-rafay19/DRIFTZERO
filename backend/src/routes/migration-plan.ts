/**
 * POST /api/migration-plan
 *
 * Generates a deterministic, evidence-based migration plan from P4/P5/P6/P7 data.
 * No IBM Bob calls. No filesystem access. No command execution. No code generation.
 */

import { Router } from "express";
import type { Router as ExpressRouter } from "express";
import type { ApiResponse, MigrationPlan } from "@driftzero/shared";
import { ValidationError } from "@driftzero/shared";
import {
  generateMigrationPlan,
  migrationPlannerInputSchema,
} from "../agents/migration-planner/index.js";

const router: ExpressRouter = Router();

/**
 * POST /api/migration-plan
 *
 * Request:  { changeAnalysis, impactAnalysis, riskScore, impactPreview }
 * Response 200: { success: true, data: MigrationPlan }
 * Response 400: validation error
 */
router.post("/", (req, res, next) => {
  const parsed = migrationPlannerInputSchema.safeParse(req.body);
  if (!parsed.success) {
    const message = parsed.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    return next(new ValidationError(message));
  }

  try {
    const result = generateMigrationPlan(parsed.data);
    const body: ApiResponse<MigrationPlan> = { success: true, data: result };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
});

export default router;
