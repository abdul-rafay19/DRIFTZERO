/**
 * Autonomous Recovery Engine — Zod schemas and internal constants (P12).
 *
 * Bob output is ALWAYS untrusted and validated here before any file is touched.
 */

import { z } from "zod";
import { workspaceInputSchema } from "../agents/code-migration/code-migration-types.js";
import { migrationPlanSchema } from "../agents/migration-planner/migration-planner-types.js";
import {
  codeMigrationResultSchema,
} from "../agents/code-migration/code-migration-types.js";
import { testGenerationResultSchema } from "../agents/test-generation/test-generation-types.js";
import { MAX_RECOVERY_ATTEMPTS } from "@driftzero/shared";

// ---------------------------------------------------------------------------
// Recovery limits
// ---------------------------------------------------------------------------

/** Re-export the shared constant as the single source of truth. */
export { MAX_RECOVERY_ATTEMPTS };

/**
 * Maximum number of file changes Bob may propose in a single recovery attempt.
 * If exceeded, the entire proposal is rejected (no partial application).
 */
export const MAX_RECOVERY_FILES_PER_ATTEMPT = 5;

// ---------------------------------------------------------------------------
// ProposedRecoveryChange — Bob output contract per file change
// ---------------------------------------------------------------------------

/**
 * A single file change proposed by Bob as part of a recovery repair.
 *
 * Validated with Zod before any I/O occurs.  Bob output is untrusted.
 */
export const proposedRecoveryChangeSchema = z.object({
  /** Relative file path inside the workspace. */
  filePath: z
    .string()
    .min(1, "filePath must not be empty")
    .refine((p) => !p.startsWith("/"), "filePath must be relative, not absolute")
    .refine((p) => !p.includes("../"), "filePath must not contain path traversal")
    .refine((p) => !p.startsWith(".git/") && p !== ".git", "filePath must not target .git"),

  /** MODIFY an existing file or CREATE a new one.  No DELETE/RENAME. */
  operation: z.enum(["MODIFY", "CREATE"]),

  /**
   * For MODIFY: the exact current content Bob expects to find on disk.
   * If the actual content differs, the change is rejected and nothing is applied.
   * For CREATE: should be an empty string.
   */
  expectedContent: z.string(),

  /** The complete new file content. Never a partial diff. */
  newContent: z.string().min(1, "newContent must not be empty"),

  /** Human-readable explanation of why this change repairs the failure. */
  explanation: z.string().min(1, "explanation must not be empty"),

  /** IDs of P8 steps that are responsible for this failure. */
  relatedStepIds: z.array(z.string()),

  /** IDs of the P11 validation checks that this change is meant to fix. */
  relatedValidationCheckIds: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// ProposedRecovery — Bob's complete structured response
// ---------------------------------------------------------------------------

/**
 * Bob must return exactly this structure — never free-form prose.
 * The backend validates this before touching any files.
 */
export const proposedRecoverySchema = z.object({
  /** Short description of what Bob believes went wrong. */
  diagnosis: z.string().min(1, "diagnosis must not be empty"),

  /** Root cause analysis — advisory intelligence, not proven fact. */
  rootCause: z.string().min(1, "rootCause must not be empty"),

  /** Proposed file changes, validated individually. */
  changes: z.array(proposedRecoveryChangeSchema),
});

export type ProposedRecovery = z.infer<typeof proposedRecoverySchema>;

// ---------------------------------------------------------------------------
// RecoveryInput schema — validated at the API boundary
// ---------------------------------------------------------------------------

export const validationResultSchema = z.object({
  workspaceId: z.string().min(1),
  status: z.enum(["PASSED", "FAILED", "NOT_VALIDATED"]),
  checks: z.array(z.object({
    id: z.string(),
    type: z.enum(["DEPENDENCY", "TYPECHECK", "BUILD", "TEST"]),
    status: z.enum(["PASSED", "FAILED", "NOT_APPLICABLE", "SKIPPED"]),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    exitCode: z.number().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    durationMs: z.number(),
    reason: z.string().optional(),
    truncated: z.boolean().optional(),
  })),
  summary: z.object({
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
    notApplicable: z.number(),
    skipped: z.number(),
  }),
  startedAt: z.string(),
  completedAt: z.string(),
});

export const recoveryInputSchema = z.object({
  workspace: workspaceInputSchema,
  migrationPlan: migrationPlanSchema,
  migrationResult: codeMigrationResultSchema,
  testGenerationResult: testGenerationResultSchema.optional(),
  validationResult: validationResultSchema,
});
