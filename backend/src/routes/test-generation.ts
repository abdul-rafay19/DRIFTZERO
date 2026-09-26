/**
 * POST /api/test-generation
 *
 * Executes the P10 Test Generation Agent against a P3 workspace.
 * IBM Bob proposes test changes; DRIFTZERO validates, authorizes, and applies them.
 * Does NOT execute tests — that belongs to P11.
 */

import { Router } from "express";
import type { Router as ExpressRouter } from "express";
import type { ApiResponse, TestGenerationResult } from "@driftzero/shared";
import { ValidationError } from "@driftzero/shared";
import {
  runTestGeneration,
  testGenerationInputSchema,
} from "../agents/test-generation/index.js";

const router: ExpressRouter = Router();

/**
 * POST /api/test-generation
 *
 * Request:  { workspace: Workspace, plan: MigrationPlan, migrationResult: CodeMigrationResult }
 * Response 200: { success: true, data: TestGenerationResult }
 * Response 400: validation error
 */
router.post("/", async (req, res, next) => {
  const parsed = testGenerationInputSchema.safeParse(req.body);
  if (!parsed.success) {
    const message = parsed.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    return next(new ValidationError(message));
  }

  try {
    const result = await runTestGeneration(parsed.data);
    const body: ApiResponse<TestGenerationResult> = { success: true, data: result };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
});

export default router;
