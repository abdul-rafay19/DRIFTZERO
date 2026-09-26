/**
 * Unexpected Change Detection Engine (P14).
 *
 * Deterministically detects workspace changes that were not authorized
 * by the migration evidence (P9 / P10 / P12).
 *
 * Core invariants:
 *  - Zero IBM Bob calls.
 *  - Zero new command execution — reuses P3 gitStatus().
 *  - Deterministic: same workspace + same evidence → same result.
 *  - P8 affectedFiles are NOT treated as proof of actual change.
 *  - Authorization requires actual P9/P10/P12 applied-change evidence.
 *  - .git/ paths are never accepted as authorized changes.
 *  - Path safety enforced via P3 safeResolvePath.
 *  - Output is sorted deterministically by file path.
 *
 * Does NOT:
 *  - Call IBM Bob
 *  - Modify files
 *  - Commit / push
 *  - Run arbitrary commands
 *  - Implement AST diff intelligence (P17)
 *  - Implement security scanning (P15/P16)
 */

import { ValidationError } from "@driftzero/shared";
import type {
  UnexpectedChangeDetectionInput,
  UnexpectedChangeDetectionResult,
  ActualChange,
  ActualChangeType,
  ExpectedChange,
  UnexpectedChange,
  UnexpectedChangeSummary,
  RecoveryResult,
  CodeMigrationResult,
  TestGenerationResult,
} from "@driftzero/shared";
import { logger } from "../../utils/logger.js";
import { gitStatus } from "../../workspace/clone.js";
import { safeResolvePath } from "../../workspace/files.js";
import { PathTraversalError } from "../../workspace/workspace-errors.js";
import { unexpectedChangeInputSchema } from "./unexpected-changes-types.js";
import {
  UnexpectedChangeWorkspaceError,
  UnexpectedChangeGitError,
} from "./unexpected-changes-errors.js";

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Detect unexpected workspace changes.
 *
 * @throws {ValidationError}               invalid input
 * @throws {UnexpectedChangeWorkspaceError} workspace not READY
 * @throws {UnexpectedChangeGitError}       git status could not be obtained
 */
export async function detectUnexpectedChanges(
  input: UnexpectedChangeDetectionInput
): Promise<UnexpectedChangeDetectionResult> {
  // 1. Validate input at the boundary
  const parsed = unexpectedChangeInputSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    throw new ValidationError(message);
  }

  const { workspace, migrationResult, testGenerationResult, recoveryResult } = parsed.data;

  // 2. Workspace must be READY
  if (workspace.status !== "READY") {
    throw new UnexpectedChangeWorkspaceError(
      `Workspace ${workspace.id} is not in READY state (current: ${workspace.status})`
    );
  }

  logger.info("Unexpected change detection started", {
    workspaceId: workspace.id,
  });

  // 3. Get actual workspace changes via P3 gitStatus
  let statusOutput: string;
  try {
    statusOutput = await gitStatus(workspace.path);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Unknown git error";
    logger.error("Unexpected change detection: git status failed", {
      workspaceId: workspace.id, reason,
    });
    throw new UnexpectedChangeGitError(
      `git status failed for workspace ${workspace.id}: ${reason}`
    );
  }

  // 4. Parse actual changes from git status output
  const actualChanges = parseGitStatus(statusOutput, workspace.path);

  // 5. Build authorized expected change set from P9/P10/P12 evidence
  const expectedChanges = buildExpectedChanges(
    migrationResult,
    testGenerationResult,
    recoveryResult
  );

  const expectedPaths = new Set(expectedChanges.map((e) => e.filePath));

  // 6. Classify each actual change
  const unexpectedChanges: UnexpectedChange[] = [];

  for (const actual of actualChanges) {
    if (actual.changeType === "RENAMED") {
      // For renames, check both old and new path
      const oldAuthorized = actual.oldPath ? expectedPaths.has(actual.oldPath) : false;
      const newAuthorized = expectedPaths.has(actual.filePath);
      if (!oldAuthorized && !newAuthorized) {
        unexpectedChanges.push({
          filePath: actual.filePath,
          changeType: "RENAMED",
          reason: "UNEXPECTED_RENAME",
          evidence: [
            `Old path "${actual.oldPath ?? "?"}" not in authorized scope`,
            `New path "${actual.filePath}" not in authorized scope`,
          ],
        });
      }
    } else if (actual.changeType === "DELETED") {
      if (!expectedPaths.has(actual.filePath)) {
        unexpectedChanges.push({
          filePath: actual.filePath,
          changeType: "DELETED",
          reason: "UNEXPECTED_DELETE",
          evidence: [
            `"${actual.filePath}" was deleted but is not in any authorized migration change set`,
          ],
        });
      }
    } else if (actual.changeType === "ADDED") {
      if (!expectedPaths.has(actual.filePath)) {
        unexpectedChanges.push({
          filePath: actual.filePath,
          changeType: "ADDED",
          reason: "UNEXPECTED_CREATE",
          evidence: [
            `"${actual.filePath}" was created but no P9/P10/P12 evidence authorized its creation`,
          ],
        });
      }
    } else {
      // MODIFIED
      if (!expectedPaths.has(actual.filePath)) {
        unexpectedChanges.push({
          filePath: actual.filePath,
          changeType: "MODIFIED",
          reason: "NOT_IN_MIGRATION_SCOPE",
          evidence: [
            `"${actual.filePath}" was modified but is not in any authorized migration change set`,
          ],
        });
      }
    }
  }

  // 7. Sort deterministically
  const sortedActual = [...actualChanges].sort((a, b) => a.filePath.localeCompare(b.filePath));
  const sortedExpected = [...expectedChanges].sort((a, b) => a.filePath.localeCompare(b.filePath));
  const sortedUnexpected = [...unexpectedChanges].sort((a, b) => a.filePath.localeCompare(b.filePath));

  // 8. Compute summary
  const summary = buildSummary(sortedActual, sortedExpected, sortedUnexpected);

  // 9. Compute status
  const status: UnexpectedChangeDetectionResult["status"] =
    sortedUnexpected.length === 0 ? "CLEAN" : "UNEXPECTED_CHANGES";

  logger.info("Unexpected change detection completed", {
    workspaceId: workspace.id,
    status,
    actualChanges: sortedActual.length,
    expectedChanges: sortedExpected.length,
    unexpectedChanges: sortedUnexpected.length,
  });

  return {
    workspaceId: workspace.id,
    status,
    actualChanges: sortedActual,
    expectedChanges: sortedExpected,
    unexpectedChanges: sortedUnexpected,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Git status parser
// ---------------------------------------------------------------------------

/**
 * Parse `git status --short` (porcelain v1) output into ActualChange records.
 *
 * Porcelain v1 format:
 *   XY PATH
 *   XY ORIG_PATH -> NEW_PATH  (renames)
 *
 * X = index status, Y = worktree status
 * M = modified, A = added, D = deleted, R = renamed, ? = untracked
 *
 * We handle:
 *   M/A/D in either column → MODIFIED/ADDED/DELETED
 *   R in index → RENAMED
 *   ?? → ADDED (untracked)
 *   .git/ prefix → silently skipped (never legitimate migration change)
 *
 * Paths with unsafe characters (../, absolute, .git/) are rejected.
 */
export function parseGitStatus(statusOutput: string, workspacePath: string): ActualChange[] {
  if (!statusOutput.trim()) return [];

  const changes: ActualChange[] = [];
  const lines = statusOutput.split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;

    // Minimum: "XY PATH" → at least 4 chars
    if (line.length < 3) continue;

    const xy = line.slice(0, 2);
    const rest = line.slice(3); // after "XY "

    const x = xy[0] ?? " ";
    const y = xy[1] ?? " ";

    // Reject .git/ paths unconditionally
    if (rest.startsWith(".git/") || rest === ".git") {
      logger.warn("Skipping .git path in git status output", { path: rest });
      continue;
    }

    let changeType: ActualChangeType | null = null;
    let filePath = rest.trim();
    let oldPath: string | undefined;

    // Rename detection: "R  old -> new" (porcelain v1 with --short)
    // git status --short outputs renames as: "R  old\nnew" on two lines OR
    // "R  old -> new" as one line depending on git version.
    // We handle the common "R  old -> new" one-line form.
    if (x === "R" || y === "R") {
      const arrowIdx = rest.indexOf(" -> ");
      if (arrowIdx !== -1) {
        oldPath = rest.slice(0, arrowIdx).trim();
        filePath = rest.slice(arrowIdx + 4).trim();
      }
      changeType = "RENAMED";
    } else if (xy === "??") {
      // Untracked = added
      changeType = "ADDED";
    } else if (x === "D" || y === "D") {
      changeType = "DELETED";
    } else if (x === "A" || y === "A") {
      changeType = "ADDED";
    } else if (x === "M" || y === "M") {
      changeType = "MODIFIED";
    }

    if (!changeType || !filePath) continue;

    // Path safety — reject paths that would escape workspace or are .git
    if (!isPathSafe(filePath, workspacePath)) {
      logger.warn("Rejecting unsafe path from git status", { filePath });
      continue;
    }
    if (oldPath && !isPathSafe(oldPath, workspacePath)) {
      logger.warn("Rejecting unsafe old path from git status", { oldPath });
      continue;
    }

    changes.push({ filePath, changeType, ...(oldPath ? { oldPath } : {}) });
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Expected change set builder
// ---------------------------------------------------------------------------

/**
 * Build the complete authorized expected change set.
 *
 * Sources:
 *  P9 — CodeMigrationResult.changes
 *  P10 — TestGenerationResult.changes
 *  P12 — RecoveryResult.attempts[].appliedChanges (only applied, not proposed)
 *
 * P8 affectedFiles are intentionally excluded — they represent expected scope,
 * not proof of actual authorized change.
 */
function buildExpectedChanges(
  migrationResult: CodeMigrationResult,
  testGenerationResult?: TestGenerationResult,
  recoveryResult?: RecoveryResult
): ExpectedChange[] {
  const changes: ExpectedChange[] = [];

  // From P9
  for (const change of migrationResult.changes) {
    changes.push({
      filePath: change.filePath,
      source: "P9",
      relatedStepIds: [change.stepId],
    });
  }

  // From P10
  if (testGenerationResult) {
    for (const change of testGenerationResult.changes) {
      changes.push({
        filePath: change.filePath,
        source: "P10",
        relatedStepIds: [change.stepId],
      });
    }
  }

  // From P12 — only include if recovery actually applied changes
  if (recoveryResult) {
    for (const attempt of recoveryResult.attempts) {
      for (const applied of attempt.appliedChanges) {
        changes.push({
          filePath: applied.filePath,
          source: "P12",
          relatedStepIds: applied.relatedStepIds,
        });
      }
    }
  }

  // Deduplicate by filePath (a file authorized by multiple phases is still one expected change)
  const seen = new Set<string>();
  return changes.filter((c) => {
    if (seen.has(c.filePath)) return false;
    seen.add(c.filePath);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummary(
  actual: ActualChange[],
  expected: ExpectedChange[],
  unexpected: UnexpectedChange[]
): UnexpectedChangeSummary {
  return {
    totalActualChanges: actual.length,
    totalExpectedChanges: expected.length,
    totalUnexpectedChanges: unexpected.length,
    added: actual.filter((c) => c.changeType === "ADDED").length,
    modified: actual.filter((c) => c.changeType === "MODIFIED").length,
    deleted: actual.filter((c) => c.changeType === "DELETED").length,
    renamed: actual.filter((c) => c.changeType === "RENAMED").length,
  };
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/**
 * Returns true if filePath is safe to include as a change.
 *
 * Rejects:
 *  - Absolute paths
 *  - Paths containing ../
 *  - .git/ paths
 *
 * Uses P3 safeResolvePath for final authority where workspacePath is available.
 */
function isPathSafe(filePath: string, workspacePath: string): boolean {
  if (!filePath || filePath.trim() === "") return false;
  if (filePath.startsWith("/")) return false;
  if (filePath.includes("../")) return false;
  if (filePath.startsWith(".git/") || filePath === ".git") return false;

  try {
    safeResolvePath(workspacePath, filePath);
    return true;
  } catch (err) {
    if (err instanceof PathTraversalError) return false;
    // If safeResolvePath throws something else, treat as unsafe
    return false;
  }
}
