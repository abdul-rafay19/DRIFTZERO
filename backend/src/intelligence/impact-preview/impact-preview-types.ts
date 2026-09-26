/**
 * Impact Preview Engine — Zod schemas for input and output validation.
 *
 * Reuses P4/P5/P6 schemas — nothing is duplicated.
 * P7 is deterministic. No IBM Bob calls. No filesystem access.
 */

import { z } from "zod";
import { changeAnalysisResultSchema } from "../../agents/impact-analysis/impact-analysis-types.js";
import { impactAnalysisResultSchema } from "../../agents/impact-analysis/impact-analysis-types.js";
import { riskScoreResultSchema } from "../risk-score/risk-score-types.js";

// ---------------------------------------------------------------------------
// Input schema — all three upstream results
// ---------------------------------------------------------------------------

export const impactPreviewInputSchema = z.object({
  changeAnalysis: changeAnalysisResultSchema,
  impactAnalysis: impactAnalysisResultSchema,
  riskScore: riskScoreResultSchema,
});

// ---------------------------------------------------------------------------
// PreviewItem — single evidence-backed finding
// ---------------------------------------------------------------------------

/**
 * A single item surfaced in the preview.
 *
 * Every item must originate from P4/P5/P6 evidence.
 * The `source` field makes the origin traceable.
 */
export const previewItemSchema = z.object({
  /** Short human-readable title for the finding. */
  title: z.string().min(1),
  /** Predictive description — uses "may", "requires", "potentially" language. */
  description: z.string().min(1),
  /** Severity inherited from the upstream P4/P5 finding. */
  severity: z
    .enum(["low", "medium", "high", "critical"])
    .optional(),
  /** Which phase produced this finding. */
  source: z.enum(["CHANGE_ANALYSIS", "IMPACT_ANALYSIS", "RISK_SCORE"]),
  /** Raw evidence strings (IDs, file paths, API names) that back this item. */
  evidence: z.array(z.string()),
  /** Source file associated with this finding, if applicable. */
  file: z.string().optional(),
});

// ---------------------------------------------------------------------------
// ImpactPreviewResult schema
// ---------------------------------------------------------------------------

export const impactPreviewResultSchema = z.object({
  packageName: z.string().min(1),
  sourceVersion: z.string().min(1),
  targetVersion: z.string().min(1),

  risk: z.object({
    score: z.number().int().min(0).max(100),
    level: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  }),

  /**
   * A deterministic human-readable summary of the migration risk.
   * Generated in code — never AI-generated.
   */
  summary: z.string().min(1),

  // Ordered categories (spec §8)
  breakingChanges: z.array(previewItemSchema),
  deprecatedApis: z.array(previewItemSchema),
  highRiskAreas: z.array(previewItemSchema),
  affectedApis: z.array(previewItemSchema),
  affectedFiles: z.array(previewItemSchema),
  affectedDependencies: z.array(previewItemSchema),
  affectedTests: z.array(previewItemSchema),
  affectedConfigs: z.array(previewItemSchema),
  behaviorChanges: z.array(previewItemSchema),

  generatedAt: z.string().min(1),
});
