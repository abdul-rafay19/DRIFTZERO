/**
 * P15 Security Engine — Zod schemas and internal types.
 *
 * Only Zod schemas live here. Shared TypeScript interfaces live in
 * @driftzero/shared types.ts.
 */

import { z } from "zod";
import { workspaceInputSchema } from "../agents/code-migration/code-migration-types.js";
import { migrationPlanSchema } from "../agents/migration-planner/migration-planner-types.js";
import {
  codeMigrationResultSchema,
} from "../agents/code-migration/code-migration-types.js";
import { testGenerationResultSchema } from "../agents/test-generation/test-generation-types.js";

// ---------------------------------------------------------------------------
// Inline minimal schemas for P12 and P14 (same approach as P14 types file)
// ---------------------------------------------------------------------------

const recoveryChangeSchema = z.object({
  filePath: z.string().min(1),
  operation: z.enum(["MODIFY", "CREATE"]),
  explanation: z.string().min(1),
  relatedStepIds: z.array(z.string()),
  relatedValidationCheckIds: z.array(z.string()),
});

const validationCheckSchema = z.object({
  id: z.string(),
  type: z.enum(["DEPENDENCY", "TYPECHECK", "BUILD", "TEST"]),
  status: z.enum(["PASSED", "FAILED", "NOT_APPLICABLE", "SKIPPED"]),
  durationMs: z.number(),
});

const validationResultSchema = z.object({
  workspaceId: z.string(),
  status: z.enum(["PASSED", "FAILED", "NOT_VALIDATED"]),
  checks: z.array(validationCheckSchema),
  summary: z.object({
    total: z.number(), passed: z.number(), failed: z.number(),
    notApplicable: z.number(), skipped: z.number(),
  }),
  startedAt: z.string(),
  completedAt: z.string(),
});

const recoveryAttemptSchema = z.object({
  attempt: z.number().int().min(1),
  appliedChanges: z.array(recoveryChangeSchema),
  status: z.enum(["RECOVERED", "FAILED", "REJECTED", "STOPPED"]),
  diagnosis: z.object({
    diagnosis: z.string(),
    rootCause: z.string(),
    proposedChanges: z.array(recoveryChangeSchema),
    bobDurationMs: z.number(),
  }),
  proposedChanges: z.array(recoveryChangeSchema),
  validation: validationResultSchema,
  reason: z.string(),
});

const recoveryResultSchema = z.object({
  workspaceId: z.string().min(1),
  status: z.enum(["RECOVERED", "NOT_NEEDED", "FAILED", "STOPPED"]),
  attempts: z.array(recoveryAttemptSchema),
  finalValidation: validationResultSchema.optional(),
  reason: z.string().min(1),
});

// P14 UnexpectedChangesResult schema
const actualChangeSchema = z.object({
  filePath: z.string().min(1),
  changeType: z.enum(["ADDED", "MODIFIED", "DELETED", "RENAMED"]),
  oldPath: z.string().optional(),
});

const expectedChangeSchema = z.object({
  filePath: z.string().min(1),
  source: z.enum(["P9", "P10", "P12"]),
  relatedStepIds: z.array(z.string()),
});

const unexpectedChangeSchema = z.object({
  filePath: z.string().min(1),
  changeType: z.enum(["ADDED", "MODIFIED", "DELETED", "RENAMED"]),
  reason: z.enum([
    "NOT_AUTHORIZED", "NOT_IN_MIGRATION_SCOPE", "UNEXPECTED_DELETE",
    "UNEXPECTED_CREATE", "UNEXPECTED_RENAME",
  ]),
  evidence: z.array(z.string()),
});

const unexpectedChangesResultSchema = z.object({
  workspaceId: z.string().min(1),
  status: z.enum(["CLEAN", "UNEXPECTED_CHANGES", "FAILED"]),
  actualChanges: z.array(actualChangeSchema),
  expectedChanges: z.array(expectedChangeSchema),
  unexpectedChanges: z.array(unexpectedChangeSchema),
  summary: z.object({
    totalActualChanges: z.number(),
    totalExpectedChanges: z.number(),
    totalUnexpectedChanges: z.number(),
    added: z.number(),
    modified: z.number(),
    deleted: z.number(),
    renamed: z.number(),
  }),
});

// ---------------------------------------------------------------------------
// P15 Security Scan Input schema
// ---------------------------------------------------------------------------

export const securityScanInputSchema = z.object({
  workspace: workspaceInputSchema,
  migrationPlan: migrationPlanSchema,
  migrationResult: codeMigrationResultSchema,
  testGenerationResult: testGenerationResultSchema.optional(),
  recoveryResult: recoveryResultSchema.optional(),
  unexpectedChanges: unexpectedChangesResultSchema.optional(),
});

export type ParsedSecurityScanInput = z.infer<typeof securityScanInputSchema>;

// ---------------------------------------------------------------------------
// Bob security review output contract schema
// ---------------------------------------------------------------------------

export const bobSecurityFindingSchema = z.object({
  category: z.enum(["CODE", "CONFIGURATION", "AI_REVIEW"]),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(1000),
  filePath: z.string().max(500).optional(),
  line: z.number().int().min(1).optional(),
  evidence: z.array(z.string().max(500)).max(10),
  recommendation: z.string().max(500).optional(),
});

export const bobSecurityReviewOutputSchema = z.object({
  findings: z.array(bobSecurityFindingSchema).max(30),
});

export type BobSecurityFinding = z.infer<typeof bobSecurityFindingSchema>;
export type BobSecurityReviewOutput = z.infer<typeof bobSecurityReviewOutputSchema>;
