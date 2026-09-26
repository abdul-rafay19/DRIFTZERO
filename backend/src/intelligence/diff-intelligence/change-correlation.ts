/**
 * P17 Diff Intelligence — Cross-phase change correlation.
 *
 * Builds DiffCorrelation records by matching changed files against
 * actual evidence from P8/P9/P10/P12/P14/P15.
 *
 * Rules:
 *  - Only exact path matches are used — no fuzzy matching
 *  - Evidence IDs use a deterministic "phase:step:path" scheme
 *  - Missing evidence → UNCORRELATED, not fabricated
 *  - P14 unexpected-change evidence is consumed without re-implementing P14 logic
 *  - P15 security findings are correlated by filePath, not re-scanned
 *
 * 0 Bob calls. 0 commands. Pure function over structured evidence.
 */

import type {
  DiffCorrelation,
  DiffChangeOrigin,
} from "@driftzero/shared";
import type {
  ParsedMigrationPlan,
  ParsedMigrationResult,
  ParsedTestGenerationResult,
  ParsedRecoveryResult,
  ParsedUnexpectedChangesResult,
  ParsedSecurityScanResult,
} from "./diff-intelligence-types.js";

// ---------------------------------------------------------------------------
// Main correlation builder
// ---------------------------------------------------------------------------

export interface CorrelationContext {
  plan?: ParsedMigrationPlan;
  migrationResult?: ParsedMigrationResult;
  testGenerationResult?: ParsedTestGenerationResult;
  recoveryResult?: ParsedRecoveryResult;
  unexpectedChanges?: ParsedUnexpectedChangesResult;
  security?: ParsedSecurityScanResult;
}

/**
 * Build a DiffCorrelation for a single changed file.
 *
 * @param filePath       Normalized relative path of the changed file
 * @param ctx            Evidence context from upstream phases
 */
export function correlateFile(
  filePath: string,
  ctx: CorrelationContext
): DiffCorrelation {
  // ---- P8: plan step correlation ----
  const planStepIds: string[] = [];
  const planStepCategories: string[] = [];

  if (ctx.plan) {
    for (const step of ctx.plan.steps) {
      if (step.affectedFiles.includes(filePath)) {
        planStepIds.push(step.id);
        planStepCategories.push(step.category);
      }
    }
  }

  // ---- P9: migration change evidence ----
  const migrationEvidenceIds: string[] = [];

  if (ctx.migrationResult) {
    for (const change of ctx.migrationResult.changes) {
      if (change.filePath === filePath) {
        migrationEvidenceIds.push(`${change.stepId}:${change.filePath}`);
      }
    }
  }

  // ---- P10: test generation evidence ----
  const testEvidenceIds: string[] = [];

  if (ctx.testGenerationResult) {
    for (const change of ctx.testGenerationResult.changes) {
      if (change.filePath === filePath) {
        testEvidenceIds.push(`P10:${change.stepId}:${change.filePath}`);
      }
    }
  }

  // ---- P12: recovery evidence ----
  const recoveryEvidenceIds: string[] = [];

  if (ctx.recoveryResult) {
    for (const attempt of ctx.recoveryResult.attempts) {
      for (const applied of attempt.appliedChanges) {
        if (applied.filePath === filePath) {
          recoveryEvidenceIds.push(`P12:attempt${attempt.attempt}:${applied.filePath}`);
        }
      }
    }
  }

  // ---- P15: security finding correlation ----
  const securityFindingIds: string[] = [];

  if (ctx.security) {
    for (const finding of ctx.security.findings) {
      if (finding.filePath === filePath) {
        securityFindingIds.push(finding.id);
      }
    }
  }

  // ---- P14: unexpected change ----
  const unexpectedChange =
    ctx.unexpectedChanges?.unexpectedChanges.some(
      (uc) => uc.filePath === filePath
    ) ?? false;

  // ---- Determine origin ----
  const origin = determineOrigin(
    filePath,
    migrationEvidenceIds,
    testEvidenceIds,
    recoveryEvidenceIds
  );

  // ---- Correlation type ----
  const correlationType =
    planStepIds.length > 0 ||
    migrationEvidenceIds.length > 0 ||
    testEvidenceIds.length > 0 ||
    recoveryEvidenceIds.length > 0
      ? ("CORRELATED" as const)
      : ("UNCORRELATED" as const);

  return {
    filePath,
    correlationType,
    planStepIds,
    migrationEvidenceIds,
    testEvidenceIds,
    recoveryEvidenceIds,
    securityFindingIds,
    unexpectedChange,
    origin,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function determineOrigin(
  _filePath: string,
  migrationEvidenceIds: string[],
  testEvidenceIds: string[],
  recoveryEvidenceIds: string[]
): DiffChangeOrigin {
  // Recovery takes precedence if explicitly recorded
  if (recoveryEvidenceIds.length > 0) return "RECOVERY";
  // Test generation
  if (testEvidenceIds.length > 0) return "TEST_GENERATION";
  // Migration
  if (migrationEvidenceIds.length > 0) return "MIGRATION";
  // Unknown
  return "UNKNOWN";
}

/**
 * Build plan step category map: filePath → step categories
 * Used by the classifier to derive semantic categories.
 */
export function buildPlanStepCategoryMap(
  plan: ParsedMigrationPlan | undefined
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!plan) return map;

  for (const step of plan.steps) {
    for (const file of step.affectedFiles) {
      const existing = map.get(file) ?? [];
      if (!existing.includes(step.category)) {
        existing.push(step.category);
      }
      map.set(file, existing);
    }
  }

  return map;
}
