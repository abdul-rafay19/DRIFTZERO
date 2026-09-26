/**
 * Deterministic Migration Risk Scoring Engine (P6).
 *
 * Consumes P4 ChangeAnalysisResult + P5 ImpactAnalysisResult.
 * Produces an evidence-based, reproducible RiskScoreResult.
 *
 * NO IBM Bob calls. NO filesystem access. NO side effects.
 * The server always recalculates the score from validated evidence.
 */

import { DriftZeroError, ValidationError } from "@driftzero/shared";
import type {
  RiskScoreInput,
  RiskScoreResult,
  RiskReason,
  RiskFactors,
  RiskLevel,
} from "@driftzero/shared";
import { logger } from "../../utils/logger.js";
import {
  riskScoreInputSchema,
  riskScoreResultSchema,
  RISK_WEIGHTS,
  RISK_THRESHOLDS,
  scoreBreakingChanges,
  scoreDeprecatedApis,
  scoreAffectedFiles,
  scoreAffectedApis,
  scoreAffectedDependencies,
  scoreAffectedTests,
  scoreHighRiskAreas,
} from "./risk-score-types.js";

// ---------------------------------------------------------------------------
// Engine error
// ---------------------------------------------------------------------------

export class RiskScoreError extends DriftZeroError {
  constructor(message: string) {
    super(message, 500, "RISK_SCORE_ERROR");
    this.name = "RiskScoreError";
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Calculate a deterministic risk score from validated P4 + P5 evidence.
 *
 * The client supplies P4/P5 data; the server always recalculates the score.
 * No client-supplied score value is ever used.
 *
 * @throws {ValidationError}   invalid P4 or P5 input
 * @throws {RiskScoreError}    output fails schema validation (should not occur)
 */
export function calculateRiskScore(input: RiskScoreInput): RiskScoreResult {
  // 1. Validate inputs (P4 + P5 data treated as untrusted)
  const parsed = riskScoreInputSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.errors.map((e) => e.message).join("; ");
    throw new ValidationError(message);
  }

  const { changeAnalysis, impactAnalysis } = parsed.data;

  logger.info("Risk scoring started", {
    packageName: changeAnalysis.packageName,
    sourceVersion: changeAnalysis.sourceVersion,
    targetVersion: changeAnalysis.targetVersion,
  });

  // 2. Extract counts from validated evidence
  const counts: RiskFactors = {
    breakingChanges: changeAnalysis.breakingChanges.length,
    deprecatedApis: impactAnalysis.affectedApis.length,       // actual repo evidence from P5
    affectedFiles: impactAnalysis.affectedFiles.length,
    affectedApis: impactAnalysis.affectedApis.length,
    affectedDependencies: impactAnalysis.affectedDependencies.length,
    affectedTests: impactAnalysis.affectedTests.length,
    highRiskAreas: impactAnalysis.highRiskAreas.length,
  };

  // 3. Score each factor
  const contributions = {
    breakingChanges: scoreBreakingChanges(counts.breakingChanges),
    deprecatedApis: scoreDeprecatedApis(counts.deprecatedApis),
    affectedFiles: scoreAffectedFiles(counts.affectedFiles),
    affectedApis: scoreAffectedApis(counts.affectedApis),
    affectedDependencies: scoreAffectedDependencies(counts.affectedDependencies),
    affectedTests: scoreAffectedTests(counts.affectedTests),
    highRiskAreas: scoreHighRiskAreas(counts.highRiskAreas),
  };

  // 4. Sum and clamp to [0, 100]
  const rawScore = Object.values(contributions).reduce((a, b) => a + b, 0);
  const score = Math.max(0, Math.min(100, rawScore));

  // 5. Derive level from thresholds
  const level = deriveLevel(score);

  // 6. Build reasons with back-references to P4/P5 evidence
  const reasons = buildReasons(changeAnalysis, impactAnalysis, contributions);

  // 7. Assemble result
  const rawResult: RiskScoreResult = {
    score,
    level,
    reasons,
    factors: counts,
    assessedAt: new Date().toISOString(),
  };

  // 8. Schema-validate the output (defence-in-depth)
  const validated = riskScoreResultSchema.safeParse(rawResult);
  if (!validated.success) {
    const issues = validated.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
    logger.error("Risk score result failed schema validation", { issues });
    throw new RiskScoreError(`Risk score result failed validation: ${issues}`);
  }

  logger.info("Risk scoring completed", {
    packageName: changeAnalysis.packageName,
    score: validated.data.score,
    level: validated.data.level,
  });

  return validated.data;
}

// ---------------------------------------------------------------------------
// Level derivation
// ---------------------------------------------------------------------------

function deriveLevel(score: number): RiskLevel {
  if (score <= RISK_THRESHOLDS.LOW.max) return "LOW";
  if (score <= RISK_THRESHOLDS.MEDIUM.max) return "MEDIUM";
  if (score <= RISK_THRESHOLDS.HIGH.max) return "HIGH";
  return "CRITICAL";
}

// ---------------------------------------------------------------------------
// Reason builder — evidence back-references
// ---------------------------------------------------------------------------

function buildReasons(
  changeAnalysis: ReturnType<typeof riskScoreInputSchema.parse>["changeAnalysis"],
  impactAnalysis: ReturnType<typeof riskScoreInputSchema.parse>["impactAnalysis"],
  contributions: Record<string, number>
): RiskReason[] {
  const reasons: RiskReason[] = [];

  // Breaking changes → P4 IDs
  if (contributions["breakingChanges"]! > 0) {
    reasons.push({
      factor: "BREAKING_CHANGES",
      description: `${changeAnalysis.breakingChanges.length} breaking change(s) require migration work`,
      contribution: contributions["breakingChanges"]!,
      evidence: changeAnalysis.breakingChanges.map((bc) => bc.id),
    });
  }

  // Deprecated APIs → P5 affected APIs
  if (contributions["deprecatedApis"]! > 0) {
    reasons.push({
      factor: "DEPRECATED_APIS",
      description: `${impactAnalysis.affectedApis.length} deprecated API usage(s) found in the repository`,
      contribution: contributions["deprecatedApis"]!,
      evidence: impactAnalysis.affectedApis.map((a) => `${a.file}: ${a.api}`),
    });
  }

  // Affected files → P5 file paths
  if (contributions["affectedFiles"]! > 0) {
    reasons.push({
      factor: "AFFECTED_FILES",
      description: `${impactAnalysis.affectedFiles.length} source file(s) directly or indirectly affected`,
      contribution: contributions["affectedFiles"]!,
      evidence: impactAnalysis.affectedFiles.map((f) => f.path),
    });
  }

  // Affected APIs → unique file list
  if (contributions["affectedApis"]! > 0) {
    const uniqueFiles = [...new Set(impactAnalysis.affectedApis.map((a) => a.file))];
    reasons.push({
      factor: "AFFECTED_APIS",
      description: `${impactAnalysis.affectedApis.length} API call site(s) across ${uniqueFiles.length} file(s) need updating`,
      contribution: contributions["affectedApis"]!,
      evidence: uniqueFiles,
    });
  }

  // Dependencies → P5 dependency names
  if (contributions["affectedDependencies"]! > 0) {
    reasons.push({
      factor: "AFFECTED_DEPENDENCIES",
      description: `Package version must be updated in ${impactAnalysis.affectedDependencies.length} manifest(s)`,
      contribution: contributions["affectedDependencies"]!,
      evidence: impactAnalysis.affectedDependencies.map((d) => `${d.name}@${d.declaredVersion}`),
    });
  }

  // Affected tests → P5 test paths
  if (contributions["affectedTests"]! > 0) {
    reasons.push({
      factor: "AFFECTED_TESTS",
      description: `${impactAnalysis.affectedTests.length} test file(s) may need updating for new behavior`,
      contribution: contributions["affectedTests"]!,
      evidence: impactAnalysis.affectedTests.map((t) => t.path),
    });
  }

  // High-risk areas → P5 titles
  if (contributions["highRiskAreas"]! > 0) {
    reasons.push({
      factor: "HIGH_RISK_AREAS",
      description: `${impactAnalysis.highRiskAreas.length} high-risk area(s) identified`,
      contribution: contributions["highRiskAreas"]!,
      evidence: impactAnalysis.highRiskAreas.map((h) => h.title),
    });
  }

  return reasons;
}
