/**
 * Impact Analysis Agent — Zod schemas for input and output validation.
 *
 * P4 change analysis schemas are re-used from the P4 module (no duplication).
 * Bob output is treated as untrusted and validated before use.
 */

import { z } from "zod";
import {
  breakingChangeSchema,
  deprecatedApiSchema,
  behaviorChangeSchema,
  migrationRequirementSchema,
  migrationPatternSchema,
} from "../change-analysis/change-analysis-types.js";

// ---------------------------------------------------------------------------
// Re-use P4 schemas for the embedded ChangeAnalysisResult
// ---------------------------------------------------------------------------

export const changeAnalysisResultSchema = z.object({
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

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

export const impactAnalysisInputSchema = z.object({
  workspacePath: z.string().min(1, "workspacePath is required"),
  packageName: z
    .string()
    .min(1, "packageName is required")
    .max(128)
    .regex(/^[a-zA-Z0-9@/_.-]+$/, "packageName contains invalid characters"),
  sourceVersion: z.string().min(1, "sourceVersion is required").max(64),
  targetVersion: z.string().min(1, "targetVersion is required").max(64),
  changeAnalysis: changeAnalysisResultSchema,
});

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

const affectedFileCategorySchema = z.enum([
  "API",
  "ROUTE",
  "MIDDLEWARE",
  "CONTROLLER",
  "TEST",
  "DEPENDENCY",
  "CONFIG",
  "OTHER",
]);

export const affectedFileSchema = z.object({
  path: z.string().min(1),
  category: affectedFileCategorySchema,
  reason: z.string().min(1),
  relevance: z.enum(["direct", "indirect"]),
  evidence: z.array(z.string()),
});

export const affectedApiSchema = z.object({
  file: z.string().min(1),
  symbol: z.string().optional(),
  api: z.string().min(1),
  reason: z.string().min(1),
  migrationRequirementId: z.string().optional(),
});

export const affectedDependencySchema = z.object({
  name: z.string().min(1),
  declaredVersion: z.string(),
  dependencyType: z.enum([
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]),
  packageManager: z.enum(["npm", "pnpm", "yarn", "unknown"]),
  reason: z.string().min(1),
});

export const affectedTestSchema = z.object({
  path: z.string().min(1),
  reason: z.string().min(1),
  evidence: z.array(z.string()),
});

export const affectedConfigSchema = z.object({
  path: z.string().min(1),
  reason: z.string().min(1),
});

export const highRiskAreaSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  files: z.array(z.string()),
});

/** Full Zod schema for the ImpactAnalysisResult. */
export const impactAnalysisResultSchema = z.object({
  packageName: z.string().min(1),
  sourceVersion: z.string().min(1),
  targetVersion: z.string().min(1),
  affectedFiles: z.array(affectedFileSchema),
  affectedApis: z.array(affectedApiSchema),
  affectedDependencies: z.array(affectedDependencySchema),
  affectedTests: z.array(affectedTestSchema),
  affectedConfigs: z.array(affectedConfigSchema),
  highRiskAreas: z.array(highRiskAreaSchema),
  summary: z.string().min(1),
  analyzedAt: z.string(),
});
