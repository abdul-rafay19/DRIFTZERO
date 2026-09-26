/**
 * Risk Score Engine — type definitions, Zod schemas, weights, and thresholds.
 *
 * All scoring constants are centralized here so they can be reviewed,
 * reasoned about, and changed in one place without touching business logic.
 *
 * P6 is deterministic. IBM Bob is never called.
 */

import { z } from "zod";
import {
  breakingChangeSchema,
  deprecatedApiSchema,
  behaviorChangeSchema,
  migrationRequirementSchema,
  migrationPatternSchema,
} from "../../agents/change-analysis/change-analysis-types.js";
import {
  affectedFileSchema,
  affectedApiSchema,
  affectedDependencySchema,
  affectedTestSchema,
  affectedConfigSchema,
  highRiskAreaSchema,
} from "../../agents/impact-analysis/impact-analysis-types.js";

// ---------------------------------------------------------------------------
// Scoring weights (max contribution per factor, total = 100)
// ---------------------------------------------------------------------------

export const RISK_WEIGHTS = {
  breakingChanges: 30,
  deprecatedApis: 15,
  affectedFiles: 15,
  affectedApis: 10,
  affectedDependencies: 10,
  affectedTests: 10,
  highRiskAreas: 10,
} as const;

/** The total max score is always the sum of all weights (100). */
export const MAX_SCORE: number = Object.values(RISK_WEIGHTS).reduce(
  (a: number, b: number) => a + b,
  0
);

// ---------------------------------------------------------------------------
// Risk level thresholds
// ---------------------------------------------------------------------------

export const RISK_THRESHOLDS = {
  LOW: { min: 0, max: 24 },
  MEDIUM: { min: 25, max: 49 },
  HIGH: { min: 50, max: 74 },
  CRITICAL: { min: 75, max: 100 },
} as const;

// ---------------------------------------------------------------------------
// Normalization helpers — convert raw counts to [0, maxContribution] scores
// ---------------------------------------------------------------------------

/**
 * Score for breaking changes.
 * 0  → 0 pts   1  → 15 pts   2–3 → 22 pts   4+ → 30 pts (full)
 */
export function scoreBreakingChanges(count: number): number {
  if (count === 0) return 0;
  if (count === 1) return Math.floor(RISK_WEIGHTS.breakingChanges * 0.5);
  if (count <= 3) return Math.floor(RISK_WEIGHTS.breakingChanges * 0.75);
  return RISK_WEIGHTS.breakingChanges;
}

/**
 * Score for deprecated APIs detected in the repository.
 * 0 → 0 pts   1 → 8 pts   2–3 → 12 pts   4+ → 15 pts
 */
export function scoreDeprecatedApis(count: number): number {
  if (count === 0) return 0;
  if (count === 1) return Math.floor(RISK_WEIGHTS.deprecatedApis * 0.5);
  if (count <= 3) return Math.floor(RISK_WEIGHTS.deprecatedApis * 0.8);
  return RISK_WEIGHTS.deprecatedApis;
}

/**
 * Score for total affected source files.
 * Capped at max 15.  ≥10 files = full contribution.
 */
export function scoreAffectedFiles(count: number): number {
  if (count === 0) return 0;
  return Math.min(RISK_WEIGHTS.affectedFiles, Math.ceil((count / 10) * RISK_WEIGHTS.affectedFiles));
}

/**
 * Score for affected API call sites.
 * 0 → 0   1 → 5   2–3 → 7   4+ → 10
 */
export function scoreAffectedApis(count: number): number {
  if (count === 0) return 0;
  if (count === 1) return Math.floor(RISK_WEIGHTS.affectedApis * 0.5);
  if (count <= 3) return Math.floor(RISK_WEIGHTS.affectedApis * 0.7);
  return RISK_WEIGHTS.affectedApis;
}

/**
 * Score for affected dependencies.
 * Any dependency declared = full contribution (migrating == upgrade required).
 */
export function scoreAffectedDependencies(count: number): number {
  return count > 0 ? RISK_WEIGHTS.affectedDependencies : 0;
}

/**
 * Score for affected tests.
 * Affected tests signal risk; capped at max 10.
 */
export function scoreAffectedTests(count: number): number {
  if (count === 0) return 0;
  return Math.min(RISK_WEIGHTS.affectedTests, Math.ceil((count / 5) * RISK_WEIGHTS.affectedTests));
}

/**
 * Score for high-risk areas surfaced by P5.
 * Each area adds to the score; capped at max 10.
 */
export function scoreHighRiskAreas(count: number): number {
  if (count === 0) return 0;
  if (count >= 3) return RISK_WEIGHTS.highRiskAreas;
  return Math.floor((count / 3) * RISK_WEIGHTS.highRiskAreas);
}

// ---------------------------------------------------------------------------
// Zod schemas for Zod-validated input
// ---------------------------------------------------------------------------

const changeAnalysisInputForRiskSchema = z.object({
  packageName: z.string().min(1),
  sourceVersion: z.string().min(1),
  targetVersion: z.string().min(1),
  summary: z.string().min(1),
  breakingChanges: z.array(breakingChangeSchema),
  deprecatedApis: z.array(deprecatedApiSchema),
  behaviorChanges: z.array(behaviorChangeSchema),
  migrationRequirements: z.array(migrationRequirementSchema),
  migrationPatterns: z.array(migrationPatternSchema),
  compatibilityNotes: z.array(z.string()),
  analyzedAt: z.string(),
  meta: z.object({ bobDurationMs: z.number(), promptLength: z.number() }),
});

const impactAnalysisInputForRiskSchema = z.object({
  packageName: z.string().min(1),
  sourceVersion: z.string().min(1),
  targetVersion: z.string().min(1),
  affectedFiles: z.array(affectedFileSchema),
  affectedApis: z.array(affectedApiSchema),
  affectedDependencies: z.array(affectedDependencySchema),
  affectedTests: z.array(affectedTestSchema),
  affectedConfigs: z.array(affectedConfigSchema),
  highRiskAreas: z.array(highRiskAreaSchema),
  summary: z.string(),
  analyzedAt: z.string(),
});

export const riskScoreInputSchema = z.object({
  changeAnalysis: changeAnalysisInputForRiskSchema,
  impactAnalysis: impactAnalysisInputForRiskSchema,
});

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

const riskReasonSchema = z.object({
  factor: z.string().min(1),
  description: z.string().min(1),
  contribution: z.number().int().min(0).max(100),
  evidence: z.array(z.string()),
});

const riskFactorsSchema = z.object({
  breakingChanges: z.number().int().min(0),
  deprecatedApis: z.number().int().min(0),
  affectedFiles: z.number().int().min(0),
  affectedApis: z.number().int().min(0),
  affectedDependencies: z.number().int().min(0),
  affectedTests: z.number().int().min(0),
  highRiskAreas: z.number().int().min(0),
});

export const riskScoreResultSchema = z.object({
  score: z.number().int().min(0).max(100),
  level: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  reasons: z.array(riskReasonSchema),
  factors: riskFactorsSchema,
  assessedAt: z.string(),
});
