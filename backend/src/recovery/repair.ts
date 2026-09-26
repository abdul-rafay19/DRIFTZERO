/**
 * Recovery Repair (P12).
 *
 * Validates and atomically applies a Bob repair proposal.
 *
 * Critical invariants:
 *  1. ATOMIC — the entire proposal is validated before any file is written.
 *     If any change is unsafe, the entire proposal is rejected and nothing is applied.
 *  2. AUTHORIZED — every file must be within the migration scope (plan steps + P9/P10 changes).
 *  3. SCOPED — proposal must not exceed MAX_RECOVERY_FILES_PER_ATTEMPT.
 *  4. SAFE — all paths validated through P3 safeResolvePath.
 *  5. MODIFY guard — expectedContent must exactly match current disk content.
 *  6. CREATE guard — target file must not already exist.
 *
 * Does NOT:
 *  - Call Bob
 *  - Run validation
 *  - Commit or push
 */

import type {
  MigrationPlan,
  CodeMigrationResult,
  TestGenerationResult,
  Workspace,
  RecoveryChange,
} from "@driftzero/shared";
import { logger } from "../utils/logger.js";
import {
  readWorkspaceFile,
  writeWorkspaceFile,
  workspacePathExists,
  safeResolvePath,
} from "../workspace/files.js";
import {
  PathTraversalError,
  WorkspaceFileNotFoundError,
} from "../workspace/workspace-errors.js";
import type { ProposedRecovery } from "./recovery-types.js";
import { MAX_RECOVERY_FILES_PER_ATTEMPT } from "./recovery-types.js";
import {
  RecoveryUnauthorizedFileError,
  RecoveryExpectedStateMismatchError,
  RecoveryScopeExceededError,
} from "./recovery-errors.js";

// ---------------------------------------------------------------------------
// Authorization scope
// ---------------------------------------------------------------------------

/**
 * Build the complete set of authorized file paths for recovery.
 *
 * Sources:
 *  1. P8 plan — step.affectedFiles per step
 *  2. P9 applied changes — migrationResult.changes
 *  3. P10 applied test changes — testGenerationResult.changes (if present)
 */
export function buildAuthorizedScope(
  plan: MigrationPlan,
  migrationResult: CodeMigrationResult,
  testGenerationResult?: TestGenerationResult
): Set<string> {
  const authorized = new Set<string>();

  // From P8 plan steps
  for (const step of plan.steps) {
    for (const f of step.affectedFiles) {
      authorized.add(f);
    }
  }

  // From P9 changes
  for (const change of migrationResult.changes) {
    authorized.add(change.filePath);
  }

  // From P10 test changes
  if (testGenerationResult) {
    for (const change of testGenerationResult.changes) {
      authorized.add(change.filePath);
    }
  }

  return authorized;
}

// ---------------------------------------------------------------------------
// Pre-validation (atomic — nothing written yet)
// ---------------------------------------------------------------------------

interface PreValidatedChange {
  filePath: string;
  operation: "MODIFY" | "CREATE";
  currentContent: string | null; // null for CREATE
  newContent: string;
  explanation: string;
  relatedStepIds: string[];
  relatedValidationCheckIds: string[];
}

/**
 * Pre-validate the entire proposal.
 *
 * Checks all security/authorization/state constraints BEFORE any file is written.
 * If any check fails, throws immediately — nothing has been written.
 *
 * @throws {RecoveryScopeExceededError}         too many files
 * @throws {PathTraversalError}                 unsafe path
 * @throws {RecoveryUnauthorizedFileError}      file not in migration scope
 * @throws {RecoveryExpectedStateMismatchError} MODIFY content mismatch
 * @throws {WorkspaceFileNotFoundError}         MODIFY target does not exist
 * @throws {Error}                              CREATE target already exists
 */
async function preValidate(
  workspacePath: string,
  proposal: ProposedRecovery,
  authorizedScope: Set<string>
): Promise<PreValidatedChange[]> {
  const changes = proposal.changes;

  // 1. Scope limit
  if (changes.length > MAX_RECOVERY_FILES_PER_ATTEMPT) {
    throw new RecoveryScopeExceededError(changes.length, MAX_RECOVERY_FILES_PER_ATTEMPT);
  }

  const validated: PreValidatedChange[] = [];

  for (const change of changes) {
    const { filePath, operation, expectedContent, newContent, explanation,
            relatedStepIds, relatedValidationCheckIds } = change;

    // 2. Path safety (Zod already checked for leading / and ../, but P3 is the authority)
    try {
      safeResolvePath(workspacePath, filePath);
    } catch {
      throw new PathTraversalError(filePath);
    }

    // 3. Authorization — must be in migration scope
    if (!authorizedScope.has(filePath)) {
      throw new RecoveryUnauthorizedFileError(filePath);
    }

    if (operation === "MODIFY") {
      // 4a. MODIFY: file must exist and content must match expectedContent
      let currentContent: string;
      try {
        currentContent = await readWorkspaceFile(workspacePath, filePath);
      } catch (err) {
        if (err instanceof WorkspaceFileNotFoundError) {
          throw new WorkspaceFileNotFoundError(
            `MODIFY target "${filePath}" does not exist`
          );
        }
        throw err;
      }

      if (currentContent !== expectedContent) {
        throw new RecoveryExpectedStateMismatchError(filePath);
      }

      validated.push({
        filePath, operation, currentContent, newContent, explanation,
        relatedStepIds, relatedValidationCheckIds,
      });
    } else {
      // 4b. CREATE: file must NOT exist
      const exists = await workspacePathExists(workspacePath, filePath);
      if (exists) {
        throw new RecoveryUnauthorizedFileError(
          `CREATE failed: file "${filePath}" already exists`
        );
      }

      validated.push({
        filePath, operation, currentContent: null, newContent, explanation,
        relatedStepIds, relatedValidationCheckIds,
      });
    }
  }

  return validated;
}

// ---------------------------------------------------------------------------
// Apply (writes happen only after full pre-validation passes)
// ---------------------------------------------------------------------------

/**
 * Atomically validate and apply a Bob recovery proposal.
 *
 * The proposal is FULLY pre-validated before any file is written.
 * Returns the list of applied changes for evidence recording.
 *
 * @throws {RecoveryScopeExceededError}
 * @throws {PathTraversalError}
 * @throws {RecoveryUnauthorizedFileError}
 * @throws {RecoveryExpectedStateMismatchError}
 * @throws {WorkspaceFileNotFoundError}
 */
export async function applyRepair(
  workspace: Workspace,
  proposal: ProposedRecovery,
  plan: MigrationPlan,
  migrationResult: CodeMigrationResult,
  testGenerationResult?: TestGenerationResult
): Promise<RecoveryChange[]> {
  const authorizedScope = buildAuthorizedScope(plan, migrationResult, testGenerationResult);

  logger.info("Recovery repair: pre-validating proposal", {
    workspaceId: workspace.id,
    proposedChanges: proposal.changes.length,
    authorizedFiles: authorizedScope.size,
  });

  // PHASE 1: Pre-validate everything — no writes yet
  const validated = await preValidate(workspace.path, proposal, authorizedScope);

  logger.info("Recovery repair: pre-validation passed — applying changes", {
    workspaceId: workspace.id,
    changeCount: validated.length,
  });

  // PHASE 2: Apply all validated changes
  const appliedChanges: RecoveryChange[] = [];

  for (const change of validated) {
    await writeWorkspaceFile(workspace.path, change.filePath, change.newContent);

    appliedChanges.push({
      filePath: change.filePath,
      operation: change.operation,
      explanation: change.explanation,
      relatedStepIds: change.relatedStepIds,
      relatedValidationCheckIds: change.relatedValidationCheckIds,
    });

    logger.debug("Recovery repair: applied change", {
      filePath: change.filePath,
      operation: change.operation,
    });
  }

  logger.info("Recovery repair: all changes applied", {
    workspaceId: workspace.id,
    appliedCount: appliedChanges.length,
  });

  return appliedChanges;
}
