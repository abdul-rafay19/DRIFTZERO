/**
 * P16 Safety Gate — Zod schemas for input validation.
 *
 * Only Zod schemas live here. Shared TypeScript interfaces are in
 * @driftzero/shared types.ts.
 *
 * Strategy: inline minimal schemas for the upstream result types rather than
 * importing fragile cross-module schema trees. P16 validates only the fields
 * it actually consumes for the safety decision.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Upstream result schemas — minimal shapes consumed by P16
// ---------------------------------------------------------------------------

// P11 ValidationResult
const validationCheckStatusSchema = z.enum([
  "PASSED", "FAILED", "NOT_APPLICABLE", "SKIPPED",
]);

const validationCheckSchema = z.object({
  id: z.string(),
  type: z.enum(["DEPENDENCY", "TYPECHECK", "BUILD", "TEST"]),
  status: validationCheckStatusSchema,
  durationMs: z.number(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  exitCode: z.number().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  reason: z.string().optional(),
  truncated: z.boolean().optional(),
});

export const validationResultSchema = z.object({
  workspaceId: z.string().min(1),
  status: z.enum(["PASSED", "FAILED", "NOT_VALIDATED"]),
  checks: z.array(validationCheckSchema),
  summary: z.object({
    total: z.number(), passed: z.number(), failed: z.number(),
    notApplicable: z.number(), skipped: z.number(),
  }),
  startedAt: z.string(),
  completedAt: z.string(),
});

// P13 RecoveryVerificationResult
const recoveryVerificationCheckSchema = z.object({
  id: z.string(),
  type: z.enum([
    "INITIAL_FAILURE_CHECK", "ATTEMPT_SEQUENCE_CHECK", "ATTEMPT_LIMIT_CHECK",
    "CHANGE_SCOPE_CHECK", "CHANGE_EVIDENCE_CHECK", "EXPECTED_STATE_CHECK",
    "POST_REPAIR_VALIDATION_CHECK", "FINAL_STATUS_CHECK",
    "DUPLICATE_REPAIR_CHECK", "RECOVERY_CONSISTENCY_CHECK",
  ]),
  status: z.enum(["PASSED", "FAILED"]),
  message: z.string(),
  evidence: z.array(z.string()).optional(),
});

export const recoveryVerificationResultSchema = z.object({
  status: z.enum(["VERIFIED", "NOT_REQUIRED", "FAILED"]),
  recoveryStatus: z.enum(["RECOVERED", "NOT_NEEDED", "FAILED", "STOPPED"]),
  checks: z.array(recoveryVerificationCheckSchema),
  finalValidation: validationResultSchema.optional(),
  verifiedAttempts: z.number(),
  verifiedChanges: z.number(),
  errors: z.array(z.string()),
  summary: z.string(),
});

// P14 UnexpectedChangeDetectionResult
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

export const unexpectedChangesResultSchema = z.object({
  workspaceId: z.string().min(1),
  status: z.enum(["CLEAN", "UNEXPECTED_CHANGES", "FAILED"]),
  actualChanges: z.array(actualChangeSchema),
  expectedChanges: z.array(expectedChangeSchema),
  unexpectedChanges: z.array(unexpectedChangeSchema),
  summary: z.object({
    totalActualChanges: z.number(),
    totalExpectedChanges: z.number(),
    totalUnexpectedChanges: z.number(),
    added: z.number(), modified: z.number(), deleted: z.number(), renamed: z.number(),
  }),
});

// P15 SecurityScanResult
const securityFindingSchema = z.object({
  id: z.string(),
  category: z.enum(["SECRET", "DEPENDENCY", "CODE", "CONFIGURATION", "AI_REVIEW"]),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  title: z.string(),
  description: z.string(),
  filePath: z.string().optional(),
  line: z.number().optional(),
  evidence: z.array(z.string()),
  source: z.enum(["DETERMINISTIC", "DEPENDENCY_AUDIT", "BOB"]),
  recommendation: z.string().optional(),
});

const securityCheckResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["PASSED", "FINDINGS", "SKIPPED", "FAILED"]),
  findingCount: z.number(),
  durationMs: z.number(),
  reason: z.string().optional(),
});

export const securityScanResultSchema = z.object({
  workspaceId: z.string().min(1),
  status: z.enum(["CLEAN", "FINDINGS", "PARTIAL", "FAILED"]),
  findings: z.array(securityFindingSchema),
  summary: z.object({
    totalFindings: z.number(), critical: z.number(), high: z.number(),
    medium: z.number(), low: z.number(),
    secretsDetected: z.number(), dependencyFindings: z.number(),
    codeFindings: z.number(), configurationFindings: z.number(),
    aiReviewFindings: z.number(),
  }),
  checks: z.array(securityCheckResultSchema),
  startedAt: z.string(),
  completedAt: z.string(),
});

// P8 MigrationPlan — minimal shape for context
const migrationPlanSchema = z.object({
  packageName: z.string(),
  sourceVersion: z.string(),
  targetVersion: z.string(),
  objective: z.string(),
  steps: z.array(z.object({
    id: z.string(), order: z.number(), title: z.string(),
    description: z.string(), category: z.string(),
    affectedFiles: z.array(z.string()), relatedChangeIds: z.array(z.string()),
    relatedRequirementIds: z.array(z.string()), reason: z.string(),
    risk: z.string(), dependencies: z.array(z.string()),
  })),
  prerequisites: z.array(z.object({
    id: z.string(), title: z.string(), description: z.string(),
    evidence: z.array(z.string()), mandatory: z.boolean(),
  })),
  validationRequirements: z.array(z.object({
    id: z.string(), title: z.string(), description: z.string(),
    relatedStepIds: z.array(z.string()),
  })),
  affectedAreas: z.array(z.string()),
  risk: z.object({ score: z.number(), level: z.string() }),
  generatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// P16 Safety Gate Input schema
// ---------------------------------------------------------------------------

export const safetyGateInputSchema = z.object({
  workspaceId: z.string().min(1),
  validation: validationResultSchema,
  recoveryVerification: recoveryVerificationResultSchema,
  unexpectedChanges: unexpectedChangesResultSchema,
  security: securityScanResultSchema,
  migrationPlan: migrationPlanSchema.optional(),
});

export type ParsedSafetyGateInput = z.infer<typeof safetyGateInputSchema>;
