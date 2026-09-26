/**
 * Unexpected Change Detection — Zod schemas and internal types (P14).
 */

import { z } from "zod";
import { workspaceInputSchema } from "../../agents/code-migration/code-migration-types.js";
import { migrationPlanSchema } from "../../agents/migration-planner/migration-planner-types.js";
import { codeMigrationResultSchema } from "../../agents/code-migration/code-migration-types.js";
import { testGenerationResultSchema } from "../../agents/test-generation/test-generation-types.js";

// ---------------------------------------------------------------------------
// RecoveryResult schema (minimal — reused from P12)
// ---------------------------------------------------------------------------

const recoveryChangeSchema = z.object({
  filePath: z.string().min(1),
  operation: z.enum(["MODIFY", "CREATE"]),
  explanation: z.string().min(1),
  relatedStepIds: z.array(z.string()),
  relatedValidationCheckIds: z.array(z.string()),
});

const recoveryAttemptSchema = z.object({
  attempt: z.number().int().min(1),
  appliedChanges: z.array(recoveryChangeSchema),
  status: z.enum(["RECOVERED", "FAILED", "REJECTED", "STOPPED"]),
  // Other fields optional for P14's purposes
  diagnosis: z.object({
    diagnosis: z.string(),
    rootCause: z.string(),
    proposedChanges: z.array(recoveryChangeSchema),
    bobDurationMs: z.number(),
  }),
  proposedChanges: z.array(recoveryChangeSchema),
  validation: z.object({
    workspaceId: z.string(),
    status: z.enum(["PASSED", "FAILED", "NOT_VALIDATED"]),
    checks: z.array(z.object({
      id: z.string(),
      type: z.enum(["DEPENDENCY", "TYPECHECK", "BUILD", "TEST"]),
      status: z.enum(["PASSED", "FAILED", "NOT_APPLICABLE", "SKIPPED"]),
      durationMs: z.number(),
    })),
    summary: z.object({
      total: z.number(), passed: z.number(), failed: z.number(),
      notApplicable: z.number(), skipped: z.number(),
    }),
    startedAt: z.string(),
    completedAt: z.string(),
  }),
  reason: z.string(),
});

const recoveryResultSchema = z.object({
  workspaceId: z.string().min(1),
  status: z.enum(["RECOVERED", "NOT_NEEDED", "FAILED", "STOPPED"]),
  attempts: z.array(recoveryAttemptSchema),
  finalValidation: z.object({
    workspaceId: z.string(),
    status: z.enum(["PASSED", "FAILED", "NOT_VALIDATED"]),
    checks: z.array(z.object({
      id: z.string(),
      type: z.enum(["DEPENDENCY", "TYPECHECK", "BUILD", "TEST"]),
      status: z.enum(["PASSED", "FAILED", "NOT_APPLICABLE", "SKIPPED"]),
      durationMs: z.number(),
    })),
    summary: z.object({
      total: z.number(), passed: z.number(), failed: z.number(),
      notApplicable: z.number(), skipped: z.number(),
    }),
    startedAt: z.string(),
    completedAt: z.string(),
  }).optional(),
  reason: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

export const unexpectedChangeInputSchema = z.object({
  workspace: workspaceInputSchema,
  migrationPlan: migrationPlanSchema,
  migrationResult: codeMigrationResultSchema,
  testGenerationResult: testGenerationResultSchema.optional(),
  recoveryResult: recoveryResultSchema.optional(),
});

export type ParsedUnexpectedChangeInput = z.infer<typeof unexpectedChangeInputSchema>;
