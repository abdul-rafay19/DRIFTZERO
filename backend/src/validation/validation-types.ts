/**
 * Validation Engine — Zod schemas and internal type contracts (P11).
 *
 * These schemas validate P11 API input.  They do NOT duplicate the shared
 * ValidationResult/ValidationCheckResult interfaces — those are the
 * exported contract.  Internal Zod schemas here are for request validation only.
 */

import { z } from "zod";
import { workspaceInputSchema } from "../agents/code-migration/code-migration-types.js";
import { migrationPlanSchema } from "../agents/migration-planner/migration-planner-types.js";
import {
  codeMigrationResultSchema,
} from "../agents/code-migration/code-migration-types.js";
import { testGenerationResultSchema } from "../agents/test-generation/test-generation-types.js";

// ---------------------------------------------------------------------------
// Package-manager detection constants
// ---------------------------------------------------------------------------

/**
 * Supported package managers for validation commands.
 * Detection is based on lock-file presence in the workspace root.
 */
export type PackageManager = "pnpm" | "npm" | "yarn";

/**
 * Lock-file names mapped to their package manager.
 * Order matters: pnpm is checked first (higher priority when multiple lock files exist).
 */
export const LOCK_FILE_PRIORITY: ReadonlyArray<{ file: string; pm: PackageManager }> = [
  { file: "pnpm-lock.yaml", pm: "pnpm" },
  { file: "yarn.lock",      pm: "yarn" },
  { file: "package-lock.json", pm: "npm" },
] as const;

// ---------------------------------------------------------------------------
// Validation check type ordering — deterministic, always the same
// ---------------------------------------------------------------------------

export const VALIDATION_CHECK_ORDER = [
  "DEPENDENCY",
  "TYPECHECK",
  "BUILD",
  "TEST",
] as const;

// ---------------------------------------------------------------------------
// Output truncation — bounded stdout/stderr in API responses
// ---------------------------------------------------------------------------

/**
 * Maximum number of characters retained per stdout/stderr field.
 * When output exceeds this, the middle is replaced with a truncation marker.
 * Head and tail are both preserved so both beginning and end are always visible.
 */
export const MAX_OUTPUT_CHARS = 4096;

/** Marker inserted at truncation point. */
export const TRUNCATION_MARKER = "\n[...output truncated...]\n";

// ---------------------------------------------------------------------------
// Recognized validation script names
// ---------------------------------------------------------------------------

/**
 * These are the ONLY script names that P11 will look for and execute.
 * Any other package.json script is never automatically run by the engine.
 * This is a security boundary.
 */
export const RECOGNIZED_TYPECHECK_SCRIPTS = ["typecheck", "type-check", "tsc"] as const;
export const RECOGNIZED_BUILD_SCRIPTS = ["build"] as const;
export const RECOGNIZED_TEST_SCRIPTS = ["test", "test:unit", "test:ci"] as const;

// ---------------------------------------------------------------------------
// ValidationInput schema — validated at the API boundary
// ---------------------------------------------------------------------------

export const validationInputSchema = z.object({
  workspace: workspaceInputSchema,
  migrationPlan: migrationPlanSchema,
  migrationResult: codeMigrationResultSchema.optional(),
  testGenerationResult: testGenerationResultSchema.optional(),
});

// ---------------------------------------------------------------------------
// Internal: resolved script configuration
// ---------------------------------------------------------------------------

/** Resolved package.json scripts and package-manager for a workspace. */
export interface ResolvedWorkspaceConfig {
  packageManager: PackageManager;
  /** Scripts found in package.json, keyed by script name. */
  scripts: Record<string, string>;
  /** The exact script name chosen for typecheck (or null). */
  typecheckScript: string | null;
  /** The exact script name chosen for build (or null). */
  buildScript: string | null;
  /** The exact script name chosen for test (or null). */
  testScript: string | null;
}
