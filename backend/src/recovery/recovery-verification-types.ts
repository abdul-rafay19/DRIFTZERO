/**
 * Recovery Verification — Zod schemas and internal constants (P13).
 *
 * P13 is purely deterministic — zero Bob calls, zero commands.
 * These schemas validate input at the API boundary.
 */

import { z } from "zod";
import { workspaceInputSchema } from "../agents/code-migration/code-migration-types.js";
import { migrationPlanSchema } from "../agents/migration-planner/migration-planner-types.js";
import {
  codeMigrationResultSchema,
} from "../agents/code-migration/code-migration-types.js";
import { testGenerationResultSchema } from "../agents/test-generation/test-generation-types.js";
import { validationResultSchema } from "./recovery-types.js";

// ---------------------------------------------------------------------------
// RecoveryResult Zod schema — mirrors the shared interface
// ---------------------------------------------------------------------------

const recoveryChangeSchema = z.object({
  filePath: z.string().min(1),
  operation: z.enum(["MODIFY", "CREATE"]),
  explanation: z.string().min(1),
  relatedStepIds: z.array(z.string()),
  relatedValidationCheckIds: z.array(z.string()),
});

const recoveryDiagnosisSchema = z.object({
  diagnosis: z.string().min(1),
  rootCause: z.string().min(1),
  proposedChanges: z.array(recoveryChangeSchema),
  bobDurationMs: z.number().min(0),
});

const recoveryAttemptSchema = z.object({
  attempt: z.number().int().min(1),
  diagnosis: recoveryDiagnosisSchema,
  proposedChanges: z.array(recoveryChangeSchema),
  appliedChanges: z.array(recoveryChangeSchema),
  validation: validationResultSchema,
  status: z.enum(["RECOVERED", "FAILED", "REJECTED", "STOPPED"]),
  reason: z.string().min(1),
});

const recoveryResultSchema = z.object({
  workspaceId: z.string().min(1),
  status: z.enum(["RECOVERED", "NOT_NEEDED", "FAILED", "STOPPED"]),
  attempts: z.array(recoveryAttemptSchema),
  finalValidation: validationResultSchema.optional(),
  reason: z.string().min(1),
});

// ---------------------------------------------------------------------------
// RecoveryVerificationInput schema — validated at the API boundary
// ---------------------------------------------------------------------------

export const recoveryVerificationInputSchema = z.object({
  workspace: workspaceInputSchema,
  migrationPlan: migrationPlanSchema,
  migrationResult: codeMigrationResultSchema,
  testGenerationResult: testGenerationResultSchema.optional(),
  initialValidation: validationResultSchema,
  recoveryResult: recoveryResultSchema,
});

// ---------------------------------------------------------------------------
// Re-export for convenience
// ---------------------------------------------------------------------------

export { validationResultSchema };
export type { z };
