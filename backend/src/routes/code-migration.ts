/**
 * POST /api/code-migration
 *
 * Executes the P9 Code Migration Agent against a P3 workspace using a P8 plan.
 * IBM Bob is called once per migration step.
 * No filesystem access, no command execution outside the controlled workspace layer.
 */

import { Router } from "express";
import type { Router as ExpressRouter } from "express";
import type { ApiResponse, CodeMigrationResult } from "@driftzero/shared";
import { ValidationError } from "@driftzero/shared";
import {
  runCodeMigration,
  codeMigrationInputSchema,
} from "../agents/code-migration/index.js";

const router: ExpressRouter = Router();

/**
 * POST /api/code-migration
 *
 * Request:  { workspace: Workspace, plan: MigrationPlan }
 * Response 200: { success: true, data: CodeMigrationResult }
 * Response 400: validation error
 * Response 403/409/422/500: migration-level errors via error handler
 */
router.post("/", async (req, res, next) => {
  const parsed = codeMigrationInputSchema.safeParse(req.body);
  if (!parsed.success) {
    const message = parsed.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    return next(new ValidationError(message));
  }

  try {
    const result = await runCodeMigration(parsed.data);
    const body: ApiResponse<CodeMigrationResult> = { success: true, data: result };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
});

export default router;
