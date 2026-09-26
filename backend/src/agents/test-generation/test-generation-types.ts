/**
 * Test Generation Agent — Zod schemas and type contracts.
 *
 * ProposedTestChange is the strict contract between P10 and IBM Bob.
 * Bob output is ALWAYS treated as untrusted and validated before use.
 *
 * Reuses P8/P9 schemas — nothing is duplicated.
 */

import { z } from "zod";
import { migrationPlanSchema } from "../../agents/migration-planner/migration-planner-types.js";
import { codeMigrationResultSchema, workspaceInputSchema } from "../../agents/code-migration/code-migration-types.js";

// ---------------------------------------------------------------------------
// Test file path recognition — repository conventions
// ---------------------------------------------------------------------------

/**
 * Recognized test file patterns.
 *
 * Following project conventions (Vitest) and common TypeScript patterns.
 * P10 uses these to authorize NEW test file creation and to validate
 * existing test file paths proposed by Bob.
 */
export const TEST_FILE_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /(?:^|[\\/])__tests__[\\/]/,
  /(?:^|[\\/])tests?[\\/]/,
  /(?:^|[\\/])test[\\/]/,
] as const;

/**
 * Returns true when the given relative path matches a recognized test file convention.
 */
export function isTestFilePath(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(filePath));
}

// ---------------------------------------------------------------------------
// ProposedTestChange — the Bob output contract for P10
// ---------------------------------------------------------------------------

/**
 * A single test file change proposed by Bob for one migration step.
 * The backend validates and authorizes this before any file access.
 */
export const proposedTestChangeSchema = z.object({
  /** Relative test file path inside the workspace. */
  filePath: z
    .string()
    .min(1, "filePath must not be empty")
    .refine((p) => !p.startsWith("/"), "filePath must be relative, not absolute")
    .refine((p) => !p.includes("../"), "filePath must not contain path traversal")
    .refine((p) => !p.startsWith(".git/") && p !== ".git", "filePath must not target .git")
    .refine((p) => isTestFilePath(p), "filePath must match a recognized test file convention"),

  /** MODIFY an existing test, or CREATE a new one. */
  operation: z.enum(["MODIFY", "CREATE"]),

  /**
   * For MODIFY: the exact current file content Bob expects to find.
   * Empty string is only valid for CREATE.
   */
  expectedContent: z.string(),

  /** The complete new test file content. Never a partial diff. */
  newContent: z.string().min(1, "newContent must not be empty"),

  /** Human-readable explanation of the test change and its migration rationale. */
  explanation: z.string().min(1, "explanation must not be empty"),

  /** ID of the P8 migration step this test change corresponds to. */
  relatedStepId: z.string().min(1, "relatedStepId must not be empty"),

  /** P4 BreakingChange or BehaviorChange IDs that drove this test change. */
  relatedChangeIds: z.array(z.string()),
});

/**
 * Bob must return a JSON object wrapping the array of proposed test changes.
 */
export const bobTestGenerationResponseSchema = z.object({
  testChanges: z.array(proposedTestChangeSchema),
  /** Brief description of what test changes this step requires. */
  stepSummary: z.string().min(1),
});

// ---------------------------------------------------------------------------
// TestGenerationInput schema — validated at the API boundary
// ---------------------------------------------------------------------------

export const testGenerationInputSchema = z.object({
  workspace: workspaceInputSchema,
  plan: migrationPlanSchema,
  migrationResult: codeMigrationResultSchema,
});

// ---------------------------------------------------------------------------
// TestChange schema — a successfully applied test change
// ---------------------------------------------------------------------------

export const testChangeSchema = z.object({
  stepId: z.string().min(1),
  filePath: z.string().min(1),
  operation: z.enum(["MODIFY", "CREATE"]),
  explanation: z.string().min(1),
  relatedChangeIds: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// TestChangeEvidence schema — structured record per applied/rejected/failed change
// ---------------------------------------------------------------------------

export const testChangeEvidenceSchema = z.object({
  stepId: z.string().min(1),
  filePath: z.string().min(1),
  operation: z.enum(["MODIFY", "CREATE"]),
  status: z.enum(["APPLIED", "REJECTED", "FAILED"]),
  reason: z.string().min(1),
  relatedChangeIds: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// TestGenerationResult schema — full execution outcome
// ---------------------------------------------------------------------------

export const testGenerationResultSchema = z.object({
  workspaceId: z.string().min(1),
  plannedTestChanges: z.number().int().min(0),
  appliedTestChanges: z.number().int().min(0),
  failedTestChanges: z.number().int().min(0),
  status: z.enum(["COMPLETED", "FAILED"]),
  changes: z.array(testChangeSchema),
  evidence: z.array(testChangeEvidenceSchema),
});
