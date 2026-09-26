/**
 * Recovery Diagnosis (P12).
 *
 * Calls IBM Bob with the P11 failure context and parses the structured
 * repair proposal.  Bob output is treated as untrusted at every step.
 *
 * Responsibilities:
 *  - Build injection-safe prompt via buildRecoveryPrompt()
 *  - Read authorized file contents through P3
 *  - Call bobGenerate() (P2)
 *  - Strip markdown fences
 *  - JSON parse
 *  - Zod validate against proposedRecoverySchema
 *  - Return typed ProposedRecovery
 *
 * Does NOT:
 *  - Apply any changes
 *  - Verify authorization (that's repair.ts)
 *  - Retry Bob indefinitely (one call per attempt; failures propagate)
 */

import type { MigrationPlan, ValidationResult, MigrationChange, Workspace } from "@driftzero/shared";
import { bobGenerate } from "../bob/bob-client.js";
import { logger } from "../utils/logger.js";
import {
  readWorkspaceFile,
  safeResolvePath,
} from "../workspace/files.js";
import { PathTraversalError, WorkspaceFileNotFoundError } from "../workspace/workspace-errors.js";
import { buildRecoveryPrompt } from "../prompts/recovery.js";
import { proposedRecoverySchema, MAX_RECOVERY_ATTEMPTS } from "./recovery-types.js";
import type { ProposedRecovery } from "./recovery-types.js";
import { RecoveryParseError } from "./recovery-errors.js";

// ---------------------------------------------------------------------------
// Authorization scope helper
// ---------------------------------------------------------------------------

/**
 * Collect authorized file paths from the migration scope.
 *
 * Authorized = files referenced in the plan's steps + files that P9/P10 changed.
 * This is used to decide which file contents to provide as context.
 */
function collectAuthorizedPaths(
  plan: MigrationPlan,
  appliedChanges: MigrationChange[]
): Set<string> {
  const paths = new Set<string>();
  for (const step of plan.steps) {
    for (const f of step.affectedFiles) paths.add(f);
  }
  for (const change of appliedChanges) {
    paths.add(change.filePath);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Diagnosis entry point
// ---------------------------------------------------------------------------

/**
 * Ask IBM Bob to diagnose a P11 failure and propose a repair.
 *
 * Reads relevant file contents through P3, builds a safe prompt, calls Bob,
 * parses and schema-validates the response.
 *
 * @throws {RecoveryParseError}  Bob returned non-JSON or schema-invalid response
 * @throws {BobConfigurationError|BobAuthenticationError|BobTimeoutError|BobInferenceError}
 *   propagated from bobGenerate() — caller handles these
 */
export async function diagnoseFailure(
  workspace: Workspace,
  plan: MigrationPlan,
  validationResult: ValidationResult,
  appliedChanges: MigrationChange[],
  attemptNumber: number
): Promise<{ proposal: ProposedRecovery; bobDurationMs: number }> {
  // 1. Collect authorized file paths and read their current contents through P3
  const authorizedPaths = collectAuthorizedPaths(plan, appliedChanges);
  const fileContexts: Array<{ filePath: string; content: string }> = [];

  for (const filePath of authorizedPaths) {
    try {
      safeResolvePath(workspace.path, filePath);
      const content = await readWorkspaceFile(workspace.path, filePath);
      fileContexts.push({ filePath, content });
    } catch (err) {
      if (err instanceof WorkspaceFileNotFoundError) {
        // File was listed in plan but doesn't exist — include as absent context
        fileContexts.push({ filePath, content: "(file does not exist)" });
      } else if (err instanceof PathTraversalError) {
        logger.warn("Skipping unsafe path in recovery file context", { filePath });
      } else {
        throw err;
      }
    }
  }

  logger.info("Recovery diagnosis: calling Bob", {
    workspaceId: workspace.id,
    attemptNumber,
    maxAttempts: MAX_RECOVERY_ATTEMPTS,
    authorizedFiles: fileContexts.length,
    failedChecks: validationResult.checks.filter(c => c.status === "FAILED").length,
  });

  // 2. Build injection-safe prompt
  const prompt = buildRecoveryPrompt(
    plan,
    validationResult,
    appliedChanges,
    fileContexts,
    attemptNumber,
    MAX_RECOVERY_ATTEMPTS
  );

  // 3. Call Bob (errors propagate to caller)
  const bobResponse = await bobGenerate({ prompt });

  logger.info("Recovery diagnosis: Bob response received", {
    workspaceId: workspace.id,
    attemptNumber,
    durationMs: bobResponse.durationMs,
    responseLength: bobResponse.content.length,
  });

  // 4. Strip markdown fences if present
  const rawContent = stripMarkdownFences(bobResponse.content);

  // 5. JSON parse
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawContent);
  } catch {
    logger.error("Recovery diagnosis: Bob returned non-JSON", {
      workspaceId: workspace.id,
      attemptNumber,
      contentLength: bobResponse.content.length,
    });
    throw new RecoveryParseError(
      `Attempt ${attemptNumber}: Bob returned a response that could not be parsed as JSON`
    );
  }

  // 6. Zod validate
  const parsed = proposedRecoverySchema.safeParse(rawJson);
  if (!parsed.success) {
    const issues = parsed.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    logger.error("Recovery diagnosis: Bob response failed schema validation", {
      workspaceId: workspace.id,
      attemptNumber,
      issues,
    });
    throw new RecoveryParseError(
      `Attempt ${attemptNumber}: Bob recovery response did not match schema: ${issues}`
    );
  }

  return { proposal: parsed.data, bobDurationMs: bobResponse.durationMs };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch?.[1] !== undefined) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}
