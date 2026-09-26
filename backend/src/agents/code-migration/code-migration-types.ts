/**
 * Code Migration Agent — Zod schemas and type contracts.
 *
 * ProposedMigrationChange is the structured contract between P9 and IBM Bob.
 * Bob output is ALWAYS treated as untrusted and validated before use.
 *
 * Reuses P8 MigrationPlan schema from the planner module.
 */

import { z } from "zod";
import { migrationPlanSchema } from "../../agents/migration-planner/migration-planner-types.js";

// ---------------------------------------------------------------------------
// ProposedMigrationChange — the Bob output contract
// ---------------------------------------------------------------------------

/**
 * A single file change proposed by Bob for one migration step.
 *
 * Bob must return exactly this structure — never free-form prose.
 * The backend validates this before applying anything.
 */
export const proposedMigrationChangeSchema = z.object({
  /**
   * Relative file path inside the workspace (no ../ no absolute paths).
   * Must match an authorized file from the current migration step.
   */
  filePath: z
    .string()
    .min(1, "filePath must not be empty")
    .refine((p) => !p.startsWith("/"), "filePath must be relative, not absolute")
    .refine((p) => !p.includes("../"), "filePath must not contain path traversal")
    .refine((p) => !p.startsWith(".git/") && p !== ".git", "filePath must not target .git"),

  /** MODIFY an existing file, or CREATE a new one. */
  operation: z.enum(["MODIFY", "CREATE"]),

  /**
   * For MODIFY: the exact current file content Bob expects to find.
   * If the actual file content differs, the change is rejected.
   * Empty string is only acceptable for CREATE.
   */
  expectedContent: z.string(),

  /** The complete new file content to write. Never a partial diff. */
  newContent: z.string().min(1, "newContent must not be empty"),

  /** Human-readable explanation of what was changed and why. */
  explanation: z.string().min(1, "explanation must not be empty"),
});

/**
 * Bob must return a JSON object containing an array of proposed changes.
 * Wrapping in an object (not a raw array) keeps the contract extensible.
 */
export const bobMigrationResponseSchema = z.object({
  changes: z
    .array(proposedMigrationChangeSchema)
    .min(0, "changes must be an array"),
  /** Brief description of what this step achieves, from Bob's perspective. */
  stepSummary: z.string().min(1),
});

// ---------------------------------------------------------------------------
// CodeMigrationInput schema — validated at the API boundary
// ---------------------------------------------------------------------------

export const workspaceInputSchema = z.object({
  /** Workspace ID, e.g. ws_abc123 */
  id: z.string().min(1),
  /** Absolute path to the workspace directory. */
  path: z.string().min(1).refine((p) => p.startsWith("/"), "workspace path must be absolute"),
  /** Repository URL (informational). */
  repoUrl: z.string().min(1),
  /** Checked-out branch, if any. */
  branch: z.string().nullable(),
  /** ISO timestamp of workspace creation. */
  createdAt: z.string(),
  /** Workspace lifecycle status. */
  status: z.enum(["CREATING", "READY", "CLEANING", "CLEANED", "FAILED"]),
});

export const codeMigrationInputSchema = z.object({
  workspace: workspaceInputSchema,
  plan: migrationPlanSchema,
});

// ---------------------------------------------------------------------------
// MigrationEvidence schema — structured record per applied/rejected change
// ---------------------------------------------------------------------------

export const migrationEvidenceSchema = z.object({
  stepId: z.string().min(1),
  filePath: z.string().min(1),
  operation: z.enum(["MODIFY", "CREATE"]),
  status: z.enum(["APPLIED", "REJECTED", "FAILED"]),
  reason: z.string().min(1),
});

// ---------------------------------------------------------------------------
// MigrationChange schema — a successfully applied change
// ---------------------------------------------------------------------------

export const migrationChangeSchema = z.object({
  stepId: z.string().min(1),
  filePath: z.string().min(1),
  operation: z.enum(["MODIFY", "CREATE"]),
  explanation: z.string().min(1),
});

// ---------------------------------------------------------------------------
// CodeMigrationResult schema — full execution outcome
// ---------------------------------------------------------------------------

export const codeMigrationResultSchema = z.object({
  workspaceId: z.string().min(1),
  planSteps: z.number().int().min(0),
  completedSteps: z.number().int().min(0),
  failedSteps: z.number().int().min(0),
  status: z.enum(["COMPLETED", "FAILED"]),
  changes: z.array(migrationChangeSchema),
  evidence: z.array(migrationEvidenceSchema),
});
