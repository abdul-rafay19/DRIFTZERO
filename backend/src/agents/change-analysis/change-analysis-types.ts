/**
 * Change Analysis Agent — type definitions and Zod schema for output validation.
 *
 * Bob's response is treated as untrusted input and validated against this schema
 * before a ChangeAnalysisResult is returned to callers.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schemas — used for validating Bob's structured output
// ---------------------------------------------------------------------------

const severitySchema = z.enum(["low", "medium", "high", "critical"]);

export const breakingChangeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  severity: severitySchema,
  affectedArea: z.string().optional(),
  migrationRequired: z.boolean(),
});

export const deprecatedApiSchema = z.object({
  id: z.string().min(1),
  apiName: z.string().min(1),
  description: z.string().min(1),
  replacement: z.string().optional(),
  removedInVersion: z.string().optional(),
});

export const behaviorChangeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  severity: severitySchema,
  affectedArea: z.string().optional(),
});

export const migrationRequirementSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  mandatory: z.boolean(),
});

export const migrationPatternSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  before: z.string().optional(),
  after: z.string().optional(),
});

/**
 * Zod schema for the full structured analysis output that Bob must produce.
 * This is the validation gate between Bob's raw text and the typed result.
 */
export const changeAnalysisOutputSchema = z.object({
  summary: z.string().min(1),
  breakingChanges: z.array(breakingChangeSchema),
  deprecatedApis: z.array(deprecatedApiSchema),
  behaviorChanges: z.array(behaviorChangeSchema),
  migrationRequirements: z.array(migrationRequirementSchema),
  migrationPatterns: z.array(migrationPatternSchema),
  compatibilityNotes: z.array(z.string()),
});

/** The shape of JSON Bob must produce (without the envelope fields added by the agent). */
export type ChangeAnalysisRawOutput = z.infer<typeof changeAnalysisOutputSchema>;

// Input validation schema
export const changeAnalysisInputSchema = z.object({
  packageName: z
    .string()
    .min(1, "packageName must not be empty")
    .max(128, "packageName is too long")
    .regex(/^[a-zA-Z0-9@/_.-]+$/, "packageName contains invalid characters"),
  sourceVersion: z
    .string()
    .min(1, "sourceVersion must not be empty")
    .max(64, "sourceVersion is too long"),
  targetVersion: z
    .string()
    .min(1, "targetVersion must not be empty")
    .max(64, "targetVersion is too long"),
});
