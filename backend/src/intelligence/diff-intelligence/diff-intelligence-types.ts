/**
 * P17 Diff Intelligence — Zod input/output schemas.
 */

import { z } from "zod";
import { workspaceInputSchema } from "../../agents/code-migration/code-migration-types.js";

// ---------------------------------------------------------------------------
// Minimal inline schemas for upstream results consumed by P17
// (same inline approach used by P14/P15/P16)
// ---------------------------------------------------------------------------

const migrationStepSchema = z.object({
  id: z.string(),
  order: z.number(),
  title: z.string(),
  description: z.string(),
  category: z.string(),
  affectedFiles: z.array(z.string()),
  relatedChangeIds: z.array(z.string()),
  relatedRequirementIds: z.array(z.string()),
  reason: z.string(),
  risk: z.string(),
  dependencies: z.array(z.string()),
});

const migrationPlanSchema = z.object({
  packageName: z.string(),
  sourceVersion: z.string(),
  targetVersion: z.string(),
  objective: z.string(),
  prerequisites: z.array(z.object({
    id: z.string(), title: z.string(), description: z.string(),
    evidence: z.array(z.string()), mandatory: z.boolean(),
  })),
  steps: z.array(migrationStepSchema),
  validationRequirements: z.array(z.object({
    id: z.string(), title: z.string(), description: z.string(),
    relatedStepIds: z.array(z.string()),
  })),
  affectedAreas: z.array(z.string()),
  risk: z.object({ score: z.number(), level: z.string() }),
  generatedAt: z.string(),
});

const migrationChangeSchema = z.object({
  stepId: z.string(),
  filePath: z.string(),
  operation: z.enum(["MODIFY", "CREATE"]),
  explanation: z.string(),
});

const migrationResultSchema = z.object({
  workspaceId: z.string(),
  planSteps: z.number(),
  completedSteps: z.number(),
  failedSteps: z.number(),
  status: z.enum(["COMPLETED", "FAILED"]),
  changes: z.array(migrationChangeSchema),
  evidence: z.array(z.object({
    stepId: z.string(), filePath: z.string(),
    operation: z.enum(["MODIFY", "CREATE"]),
    status: z.enum(["APPLIED", "REJECTED", "FAILED"]),
    reason: z.string(),
  })),
});

const testChangeSchema = z.object({
  stepId: z.string(),
  filePath: z.string(),
  operation: z.enum(["MODIFY", "CREATE"]),
  explanation: z.string(),
  relatedChangeIds: z.array(z.string()),
});

const testGenerationResultSchema = z.object({
  workspaceId: z.string(),
  plannedTestChanges: z.number(),
  appliedTestChanges: z.number(),
  failedTestChanges: z.number(),
  status: z.enum(["COMPLETED", "FAILED"]),
  changes: z.array(testChangeSchema),
  evidence: z.array(z.object({
    stepId: z.string(), filePath: z.string(),
    operation: z.enum(["MODIFY", "CREATE"]),
    status: z.enum(["APPLIED", "REJECTED", "FAILED"]),
    reason: z.string(), relatedChangeIds: z.array(z.string()),
  })),
});

const recoveryChangeSchema = z.object({
  filePath: z.string(),
  operation: z.enum(["MODIFY", "CREATE"]),
  explanation: z.string(),
  relatedStepIds: z.array(z.string()),
  relatedValidationCheckIds: z.array(z.string()),
});

const validationResultSchema = z.object({
  workspaceId: z.string(), status: z.enum(["PASSED", "FAILED", "NOT_VALIDATED"]),
  checks: z.array(z.object({
    id: z.string(), type: z.enum(["DEPENDENCY", "TYPECHECK", "BUILD", "TEST"]),
    status: z.enum(["PASSED", "FAILED", "NOT_APPLICABLE", "SKIPPED"]), durationMs: z.number(),
  })),
  summary: z.object({ total: z.number(), passed: z.number(), failed: z.number(), notApplicable: z.number(), skipped: z.number() }),
  startedAt: z.string(), completedAt: z.string(),
});

const recoveryResultSchema = z.object({
  workspaceId: z.string(),
  status: z.enum(["RECOVERED", "NOT_NEEDED", "FAILED", "STOPPED"]),
  attempts: z.array(z.object({
    attempt: z.number(), status: z.enum(["RECOVERED", "FAILED", "REJECTED", "STOPPED"]),
    appliedChanges: z.array(recoveryChangeSchema),
    proposedChanges: z.array(recoveryChangeSchema),
    diagnosis: z.object({ diagnosis: z.string(), rootCause: z.string(), proposedChanges: z.array(recoveryChangeSchema), bobDurationMs: z.number() }),
    validation: validationResultSchema,
    reason: z.string(),
  })),
  finalValidation: validationResultSchema.optional(),
  reason: z.string(),
});

const unexpectedChangesResultSchema = z.object({
  workspaceId: z.string(),
  status: z.enum(["CLEAN", "UNEXPECTED_CHANGES", "FAILED"]),
  actualChanges: z.array(z.object({ filePath: z.string(), changeType: z.enum(["ADDED", "MODIFIED", "DELETED", "RENAMED"]), oldPath: z.string().optional() })),
  expectedChanges: z.array(z.object({ filePath: z.string(), source: z.enum(["P9", "P10", "P12"]), relatedStepIds: z.array(z.string()) })),
  unexpectedChanges: z.array(z.object({
    filePath: z.string(), changeType: z.enum(["ADDED", "MODIFIED", "DELETED", "RENAMED"]),
    reason: z.enum(["NOT_AUTHORIZED", "NOT_IN_MIGRATION_SCOPE", "UNEXPECTED_DELETE", "UNEXPECTED_CREATE", "UNEXPECTED_RENAME"]),
    evidence: z.array(z.string()),
  })),
  summary: z.object({
    totalActualChanges: z.number(), totalExpectedChanges: z.number(), totalUnexpectedChanges: z.number(),
    added: z.number(), modified: z.number(), deleted: z.number(), renamed: z.number(),
  }),
});

const safetyGateResultSchema = z.object({
  workspaceId: z.string(),
  decision: z.enum(["SAFE_TO_PROCEED", "STOP_SAFELY"]),
  checks: z.array(z.object({
    id: z.string(), name: z.string(),
    status: z.enum(["PASS", "FAIL", "NOT_VERIFIED"]), blocking: z.boolean(),
    reason: z.string(), evidence: z.array(z.string()),
  })),
  blockingReasons: z.array(z.object({ code: z.string(), severity: z.enum(["ERROR", "WARNING"]), title: z.string(), message: z.string(), evidence: z.array(z.string()) })),
  warnings: z.array(z.object({ code: z.string(), severity: z.enum(["ERROR", "WARNING"]), title: z.string(), message: z.string(), evidence: z.array(z.string()) })),
  summary: z.object({ totalChecks: z.number(), passed: z.number(), failed: z.number(), notVerified: z.number(), blockingReasonCount: z.number(), warningCount: z.number() }),
});

const securityFindingSchema = z.object({
  id: z.string(),
  category: z.enum(["SECRET", "DEPENDENCY", "CODE", "CONFIGURATION", "AI_REVIEW"]),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  title: z.string(), description: z.string(),
  filePath: z.string().optional(), line: z.number().optional(),
  evidence: z.array(z.string()),
  source: z.enum(["DETERMINISTIC", "DEPENDENCY_AUDIT", "BOB"]),
  recommendation: z.string().optional(),
});

const securityScanResultSchema = z.object({
  workspaceId: z.string(),
  status: z.enum(["CLEAN", "FINDINGS", "PARTIAL", "FAILED"]),
  findings: z.array(securityFindingSchema),
  summary: z.object({
    totalFindings: z.number(), critical: z.number(), high: z.number(), medium: z.number(), low: z.number(),
    secretsDetected: z.number(), dependencyFindings: z.number(), codeFindings: z.number(),
    configurationFindings: z.number(), aiReviewFindings: z.number(),
  }),
  checks: z.array(z.object({ id: z.string(), name: z.string(), status: z.string(), findingCount: z.number(), durationMs: z.number() })),
  startedAt: z.string(), completedAt: z.string(),
});

// ---------------------------------------------------------------------------
// P17 input schema
// ---------------------------------------------------------------------------

export const diffIntelligenceInputSchema = z.object({
  workspace: workspaceInputSchema,
  migrationPlan: migrationPlanSchema.optional(),
  migrationResult: migrationResultSchema.optional(),
  testGenerationResult: testGenerationResultSchema.optional(),
  recoveryResult: recoveryResultSchema.optional(),
  unexpectedChanges: unexpectedChangesResultSchema.optional(),
  safetyGate: safetyGateResultSchema.optional(),
  security: securityScanResultSchema.optional(),
});

export type ParsedDiffIntelligenceInput = z.infer<typeof diffIntelligenceInputSchema>;

// Re-export parsed sub-types for use in the engine
export type ParsedMigrationPlan = z.infer<typeof migrationPlanSchema>;
export type ParsedMigrationResult = z.infer<typeof migrationResultSchema>;
export type ParsedTestGenerationResult = z.infer<typeof testGenerationResultSchema>;
export type ParsedRecoveryResult = z.infer<typeof recoveryResultSchema>;
export type ParsedUnexpectedChangesResult = z.infer<typeof unexpectedChangesResultSchema>;
export type ParsedSecurityScanResult = z.infer<typeof securityScanResultSchema>;
export type ParsedSafetyGateResult = z.infer<typeof safetyGateResultSchema>;
