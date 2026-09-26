/**
 * Autonomous Recovery Engine (P12).
 *
 * Bounded autonomous recovery loop:
 *
 *   1. If P11 already PASSED → return NOT_NEEDED immediately.
 *   2. For each attempt (max MAX_RECOVERY_ATTEMPTS):
 *      a. Ask Bob to diagnose the failure and propose a repair.
 *      b. Validate and authorize the entire proposal atomically.
 *      c. Apply the repair through P3.
 *      d. Re-run P11 validation.
 *      e. If P11 PASSED → RECOVERED.  Stop.
 *      f. If P11 still FAILED → record attempt, continue to next.
 *   3. If all attempts exhausted → STOPPED.
 *
 * Hard invariants:
 *  - SUCCESS requires P11 ValidationResult.status === "PASSED".
 *    Bob's confidence alone is NEVER sufficient.
 *  - Attempt limit is FINITE and enforced independently of Bob.
 *  - Duplicate repairs are detected and rejected.
 *  - Bob failures are bounded — they consume the current attempt budget.
 *  - No Git operations.  No code execution.  No arbitrary commands.
 *  - Zero hidden state — full evidence in RecoveryResult.
 */

import { ValidationError } from "@driftzero/shared";
import { MAX_RECOVERY_ATTEMPTS } from "@driftzero/shared";
import type {
  RecoveryInput,
  RecoveryResult,
  RecoveryAttempt,
  RecoveryAttemptStatus,
  RecoveryDiagnosis,
  ValidationResult,
} from "@driftzero/shared";
import { logger } from "../utils/logger.js";
import { runValidation } from "../validation/validation-engine.js";
import { diagnoseFailure } from "./diagnosis.js";
import { applyRepair } from "./repair.js";
import { recoveryInputSchema } from "./recovery-types.js";
import {
  RecoveryWorkspaceError,
  RecoveryParseError,
  RecoveryUnauthorizedFileError,
  RecoveryExpectedStateMismatchError,
  RecoveryScopeExceededError,
  RecoveryDuplicateRepairError,
} from "./recovery-errors.js";
import { DriftZeroError } from "@driftzero/shared";

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Execute the bounded autonomous recovery engine.
 *
 * @throws {ValidationError}        invalid input
 * @throws {RecoveryWorkspaceError} workspace not READY
 */
export async function runRecovery(input: RecoveryInput): Promise<RecoveryResult> {
  // 1. Validate input at the boundary
  const parsed = recoveryInputSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    throw new ValidationError(message);
  }

  const { workspace, migrationPlan, migrationResult, testGenerationResult, validationResult } =
    parsed.data;

  // 2. Workspace must be READY
  if (workspace.status !== "READY") {
    throw new RecoveryWorkspaceError(
      `Workspace ${workspace.id} is not in READY state (current: ${workspace.status})`
    );
  }

  logger.info("Recovery engine started", {
    workspaceId: workspace.id,
    initialValidationStatus: validationResult.status,
    maxAttempts: MAX_RECOVERY_ATTEMPTS,
  });

  // 3. If P11 already passed — nothing to do
  if (validationResult.status === "PASSED") {
    logger.info("Recovery not needed — validation already passed", {
      workspaceId: workspace.id,
    });
    return {
      workspaceId: workspace.id,
      status: "NOT_NEEDED",
      attempts: [],
      finalValidation: validationResult as ValidationResult,
      reason: "Validation already passed — no recovery required",
    };
  }

  // 4. Recovery loop — strictly bounded by MAX_RECOVERY_ATTEMPTS
  const attempts: RecoveryAttempt[] = [];
  let currentValidation: ValidationResult = validationResult as ValidationResult;

  // Track fingerprints of proposals we've already seen (duplicate detection)
  const seenProposalFingerprints = new Set<string>();

  for (let attemptNumber = 1; attemptNumber <= MAX_RECOVERY_ATTEMPTS; attemptNumber++) {
    logger.info("Recovery attempt started", {
      workspaceId: workspace.id,
      attempt: attemptNumber,
      maxAttempts: MAX_RECOVERY_ATTEMPTS,
    });

    // Collect all applied changes for context (P9 + P10)
    const allAppliedChanges = [
      ...migrationResult.changes,
      ...(testGenerationResult?.changes.map((c) => ({
        stepId: c.stepId,
        filePath: c.filePath,
        operation: c.operation as "MODIFY" | "CREATE",
        explanation: c.explanation,
      })) ?? []),
    ];

    // ── Step A: Diagnose + get Bob's repair proposal ──────────────────────
    let diagnosisResult: Awaited<ReturnType<typeof diagnoseFailure>>;

    try {
      diagnosisResult = await diagnoseFailure(
        workspace,
        migrationPlan,
        currentValidation,
        allAppliedChanges,
        attemptNumber
      );
    } catch (err) {
      // Bob call failure — consume this attempt and stop safely
      const reason = err instanceof Error ? err.message : "Unknown Bob failure";
      logger.error("Recovery attempt: Bob call failed", {
        workspaceId: workspace.id,
        attempt: attemptNumber,
        reason,
      });

      const diagnosis: RecoveryDiagnosis = {
        diagnosis: "Bob call failed",
        rootCause: reason,
        proposedChanges: [],
        bobDurationMs: 0,
      };

      attempts.push({
        attempt: attemptNumber,
        diagnosis,
        proposedChanges: [],
        appliedChanges: [],
        validation: currentValidation,
        status: "STOPPED",
        reason: `Bob call failed: ${reason}`,
      });

      return {
        workspaceId: workspace.id,
        status: "STOPPED",
        attempts,
        finalValidation: currentValidation,
        reason: `Recovery stopped at attempt ${attemptNumber}: Bob call failed — ${reason}`,
      };
    }

    const { proposal, bobDurationMs } = diagnosisResult;

    const diagnosis: RecoveryDiagnosis = {
      diagnosis: proposal.diagnosis,
      rootCause: proposal.rootCause,
      proposedChanges: proposal.changes.map((c) => ({
        filePath: c.filePath,
        operation: c.operation,
        explanation: c.explanation,
        relatedStepIds: c.relatedStepIds,
        relatedValidationCheckIds: c.relatedValidationCheckIds,
      })),
      bobDurationMs,
    };

    // ── Step B: Duplicate detection ───────────────────────────────────────
    const proposalFingerprint = computeProposalFingerprint(proposal.changes);

    if (seenProposalFingerprints.has(proposalFingerprint)) {
      logger.warn("Recovery attempt: duplicate proposal detected — stopping", {
        workspaceId: workspace.id,
        attempt: attemptNumber,
      });

      attempts.push({
        attempt: attemptNumber,
        diagnosis,
        proposedChanges: diagnosis.proposedChanges,
        appliedChanges: [],
        validation: currentValidation,
        status: "REJECTED",
        reason: `Duplicate repair proposal — identical to a previous attempt. Stopping to preserve recovery budget.`,
      });

      return {
        workspaceId: workspace.id,
        status: "STOPPED",
        attempts,
        finalValidation: currentValidation,
        reason: `Recovery stopped at attempt ${attemptNumber}: duplicate repair proposal detected`,
      };
    }

    seenProposalFingerprints.add(proposalFingerprint);

    // ── Step C: If Bob proposed no changes, treat as rejected ────────────
    if (proposal.changes.length === 0) {
      logger.warn("Recovery attempt: Bob proposed no changes", {
        workspaceId: workspace.id,
        attempt: attemptNumber,
      });

      attempts.push({
        attempt: attemptNumber,
        diagnosis,
        proposedChanges: [],
        appliedChanges: [],
        validation: currentValidation,
        status: "REJECTED",
        reason: `Bob diagnosed the failure but proposed no file changes`,
      });

      // No changes to apply — try next attempt (budget permitting) or stop
      if (attemptNumber >= MAX_RECOVERY_ATTEMPTS) break;
      continue;
    }

    // ── Step D: Atomically validate + apply repair ────────────────────────
    let appliedChanges: Awaited<ReturnType<typeof applyRepair>>;
    let applyError: string | null = null;
    let attemptStatus: RecoveryAttemptStatus = "FAILED";

    try {
      appliedChanges = await applyRepair(
        workspace,
        proposal,
        migrationPlan,
        migrationResult,
        testGenerationResult
      );
    } catch (err) {
      applyError = err instanceof Error ? err.message : "Unknown repair error";

      logger.warn("Recovery attempt: repair rejected or failed", {
        workspaceId: workspace.id,
        attempt: attemptNumber,
        reason: applyError,
        errorType: err instanceof DriftZeroError ? err.code : "UNKNOWN",
      });

      // Determine if this is a hard rejection (authorization/scope) or a transient failure
      const isRejection =
        err instanceof RecoveryUnauthorizedFileError ||
        err instanceof RecoveryExpectedStateMismatchError ||
        err instanceof RecoveryScopeExceededError ||
        err instanceof RecoveryDuplicateRepairError ||
        err instanceof RecoveryParseError;

      attempts.push({
        attempt: attemptNumber,
        diagnosis,
        proposedChanges: diagnosis.proposedChanges,
        appliedChanges: [],
        validation: currentValidation,
        status: isRejection ? "REJECTED" : "FAILED",
        reason: applyError,
      });

      // For hard rejections, stop immediately
      if (isRejection) {
        return {
          workspaceId: workspace.id,
          status: "STOPPED",
          attempts,
          finalValidation: currentValidation,
          reason: `Recovery stopped at attempt ${attemptNumber}: unsafe repair proposal — ${applyError}`,
        };
      }

      // For other failures (e.g. workspace I/O), continue if budget remains
      if (attemptNumber >= MAX_RECOVERY_ATTEMPTS) break;
      continue;
    }

    // ── Step E: Re-run P11 validation ─────────────────────────────────────
    logger.info("Recovery attempt: repair applied — re-running P11 validation", {
      workspaceId: workspace.id,
      attempt: attemptNumber,
      appliedChanges: appliedChanges.length,
    });

    const revalidation = await runValidation({
      workspace,
      migrationPlan,
      migrationResult,
      testGenerationResult,
    });

    currentValidation = revalidation;

    // ── Step F: Evaluate result ────────────────────────────────────────────
    if (revalidation.status === "PASSED") {
      attemptStatus = "RECOVERED";

      attempts.push({
        attempt: attemptNumber,
        diagnosis,
        proposedChanges: diagnosis.proposedChanges,
        appliedChanges,
        validation: revalidation,
        status: "RECOVERED",
        reason: "P11 validation passed after repair",
      });

      logger.info("Recovery succeeded", {
        workspaceId: workspace.id,
        attempt: attemptNumber,
      });

      return {
        workspaceId: workspace.id,
        status: "RECOVERED",
        attempts,
        finalValidation: revalidation,
        reason: `Recovery succeeded on attempt ${attemptNumber}`,
      };
    }

    // P11 still failing — record attempt and continue
    attempts.push({
      attempt: attemptNumber,
      diagnosis,
      proposedChanges: diagnosis.proposedChanges,
      appliedChanges,
      validation: revalidation,
      status: "FAILED",
      reason: `Repair applied but P11 validation still FAILED after attempt ${attemptNumber}`,
    });

    logger.warn("Recovery attempt: repair did not fix validation", {
      workspaceId: workspace.id,
      attempt: attemptNumber,
      validationStatus: revalidation.status,
    });
  }

  // 5. All attempts exhausted
  logger.warn("Recovery stopped: all attempts exhausted", {
    workspaceId: workspace.id,
    totalAttempts: attempts.length,
    maxAttempts: MAX_RECOVERY_ATTEMPTS,
  });

  return {
    workspaceId: workspace.id,
    status: attempts.length >= MAX_RECOVERY_ATTEMPTS ? "STOPPED" : "FAILED",
    attempts,
    finalValidation: currentValidation,
    reason: `Recovery stopped after ${attempts.length} attempt(s) — P11 validation did not pass`,
  };
}

// ---------------------------------------------------------------------------
// Duplicate repair detection
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic fingerprint for a proposal's changes.
 *
 * Used to detect identical repeated proposals, which waste recovery budget
 * and would loop indefinitely without this check.
 *
 * Fingerprint = sorted(filePath + operation + hash(newContent))
 */
function computeProposalFingerprint(
  changes: Array<{ filePath: string; operation: string; newContent: string }>
): string {
  const items = changes
    .map((c) => `${c.filePath}::${c.operation}::${simpleHash(c.newContent)}`)
    .sort();
  return items.join("|");
}

/**
 * Simple deterministic hash for duplicate detection.
 * Not a cryptographic hash — only needs to be consistent for the same input.
 */
function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h >>> 0; // unsigned 32-bit
}
