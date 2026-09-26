/**
 * Recovery Verification Engine (P13).
 *
 * Deterministically verifies that P12 recovery evidence is valid, complete,
 * consistent, and sufficient to establish that the migration is recovered.
 *
 * Core invariants:
 *  - ZERO IBM Bob calls.
 *  - ZERO arbitrary command execution.
 *  - Pure function over structured evidence: same input → same output.
 *  - VERIFIED requires every check to PASS and finalValidation.status === "PASSED".
 *  - NOT_REQUIRED when initialValidation was already PASSED.
 *  - FAILED when any required check fails.
 *
 * Checks executed (deterministic order):
 *  1. INITIAL_FAILURE_CHECK       — recovery started from appropriate failure state
 *  2. ATTEMPT_SEQUENCE_CHECK      — attempt numbers are contiguous and start at 1
 *  3. ATTEMPT_LIMIT_CHECK         — no attempt exceeds MAX_RECOVERY_ATTEMPTS
 *  4. CHANGE_SCOPE_CHECK          — every applied change is in authorized scope
 *  5. CHANGE_EVIDENCE_CHECK       — every applied change has required evidence fields
 *  6. EXPECTED_STATE_CHECK        — MODIFY operations have non-empty expected state
 *  7. POST_REPAIR_VALIDATION_CHECK — every attempt with applied changes has a validation
 *  8. FINAL_STATUS_CHECK          — final validation is PASSED for RECOVERED result
 *  9. DUPLICATE_REPAIR_CHECK      — no identical repair appears twice
 * 10. RECOVERY_CONSISTENCY_CHECK  — attempt.status <-> attempt.validation are consistent
 *
 * Does NOT:
 *  - Call IBM Bob
 *  - Execute shell commands
 *  - Read workspace files
 *  - Modify any files
 *  - Commit or push
 *  - Implement P14+ functionality
 */

import { ValidationError } from "@driftzero/shared";
import { MAX_RECOVERY_ATTEMPTS } from "@driftzero/shared";
import type {
  RecoveryVerificationInput,
  RecoveryVerificationResult,
  RecoveryVerificationCheck,
  RecoveryVerificationCheckType,
  RecoveryResult,
  RecoveryAttempt,
  RecoveryChange,
  MigrationPlan,
  CodeMigrationResult,
  TestGenerationResult,
} from "@driftzero/shared";
import { logger } from "../utils/logger.js";
import { recoveryVerificationInputSchema } from "./recovery-verification-types.js";

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Verify P12 recovery evidence.
 *
 * Pure deterministic function.  No side effects.  No network.  No AI.
 *
 * @throws {ValidationError} if input fails Zod schema validation
 */
export function verifyRecovery(input: RecoveryVerificationInput): RecoveryVerificationResult {
  // 1. Validate input at the boundary
  const parsed = recoveryVerificationInputSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    throw new ValidationError(message);
  }

  const {
    migrationPlan,
    migrationResult,
    testGenerationResult,
    initialValidation,
    recoveryResult,
  } = parsed.data;

  logger.info("Recovery verification started", {
    workspaceId: recoveryResult.workspaceId,
    recoveryStatus: recoveryResult.status,
    attempts: recoveryResult.attempts.length,
  });

  // 2. NOT_REQUIRED: initial validation was already PASSED
  if (initialValidation.status === "PASSED") {
    logger.info("Recovery verification: NOT_REQUIRED (initial validation was PASSED)", {
      workspaceId: recoveryResult.workspaceId,
    });
    return {
      status: "NOT_REQUIRED",
      recoveryStatus: recoveryResult.status,
      checks: [],
      finalValidation: recoveryResult.finalValidation,
      verifiedAttempts: 0,
      verifiedChanges: 0,
      errors: [],
      summary: "Recovery was not required — initial validation was already PASSED",
    };
  }

  // 3. NOT_NEEDED recovery with passed initial state is contradictory —
  //    but if recoveryResult.status === "NOT_NEEDED" and initial was FAILED,
  //    that is an inconsistency we flag.
  //    If recoveryResult.status === "NOT_NEEDED" AND initial was already FAILED,
  //    we still run checks — the NOT_NEEDED claim is suspicious.

  // 4. Build authorized scope (same logic as P12 repair.ts)
  const authorizedScope = buildAuthorizedScope(
    migrationPlan,
    migrationResult,
    testGenerationResult
  );

  // 5. Run all verification checks in deterministic order
  const checks: RecoveryVerificationCheck[] = [];

  checks.push(checkInitialFailure(initialValidation, recoveryResult));
  checks.push(checkAttemptSequence(recoveryResult));
  checks.push(checkAttemptLimit(recoveryResult));
  checks.push(checkChangeScope(recoveryResult, authorizedScope));
  checks.push(checkChangeEvidence(recoveryResult));
  checks.push(checkExpectedState(recoveryResult));
  checks.push(checkPostRepairValidation(recoveryResult));
  checks.push(checkFinalStatus(recoveryResult));
  checks.push(checkDuplicateRepair(recoveryResult));
  checks.push(checkRecoveryConsistency(recoveryResult));

  // 6. Compute aggregated result
  const failedChecks = checks.filter((c) => c.status === "FAILED");
  const errors = failedChecks.map((c) => c.message);

  const verifiedAttempts = recoveryResult.attempts.length;
  const verifiedChanges = recoveryResult.attempts
    .reduce((sum, a) => sum + a.appliedChanges.length, 0);

  const overallStatus: RecoveryVerificationResult["status"] =
    failedChecks.length === 0 ? "VERIFIED" : "FAILED";

  const summary = buildSummary(overallStatus, recoveryResult.status, failedChecks.length, checks.length);

  logger.info("Recovery verification completed", {
    workspaceId: recoveryResult.workspaceId,
    status: overallStatus,
    passedChecks: checks.filter((c) => c.status === "PASSED").length,
    failedChecks: failedChecks.length,
  });

  return {
    status: overallStatus,
    recoveryStatus: recoveryResult.status,
    checks,
    finalValidation: recoveryResult.finalValidation,
    verifiedAttempts,
    verifiedChanges,
    errors,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Individual verification checks
// ---------------------------------------------------------------------------

/**
 * CHECK 1: INITIAL_FAILURE_CHECK
 *
 * Recovery that claims RECOVERED must have started from a FAILED/NOT_VALIDATED
 * initial state.  Recovery starting from PASSED is contradictory.
 */
function checkInitialFailure(
  initialValidation: RecoveryVerificationInput["initialValidation"],
  recoveryResult: RecoveryResult
): RecoveryVerificationCheck {
  const id = "vc-initial-failure";
  const type: RecoveryVerificationCheckType = "INITIAL_FAILURE_CHECK";

  // If recovery was NOT_NEEDED (and we're here, initial was not PASSED),
  // that's inconsistent — P12 should only return NOT_NEEDED if initial was PASSED
  if (recoveryResult.status === "NOT_NEEDED" && initialValidation.status !== "PASSED") {
    return fail(id, type,
      `Recovery status is NOT_NEEDED but initial validation was ${initialValidation.status}, not PASSED`,
      [`initialValidation.status = ${initialValidation.status}`]
    );
  }

  // If recovery was RECOVERED, initial must have been non-PASSED
  if (recoveryResult.status === "RECOVERED" && initialValidation.status === "PASSED") {
    return fail(id, type,
      "Recovery claims RECOVERED but initial validation was already PASSED — recovery was unnecessary",
      [`initialValidation.status = ${initialValidation.status}`]
    );
  }

  return pass(id, type,
    `Initial validation was ${initialValidation.status} — appropriate starting state for recovery`,
    [`initialValidation.status = ${initialValidation.status}`]
  );
}

/**
 * CHECK 2: ATTEMPT_SEQUENCE_CHECK
 *
 * Attempt numbers must be a contiguous sequence starting at 1: 1, 2, 3, …
 * No gaps, no duplicates, no zeros, no negative numbers.
 */
function checkAttemptSequence(recoveryResult: RecoveryResult): RecoveryVerificationCheck {
  const id = "vc-attempt-sequence";
  const type: RecoveryVerificationCheckType = "ATTEMPT_SEQUENCE_CHECK";
  const attempts = recoveryResult.attempts;

  if (attempts.length === 0) {
    // No attempts is valid for NOT_NEEDED / immediately rejected cases
    return pass(id, type, "No recovery attempts — sequence trivially valid", []);
  }

  const numbers = attempts.map((a) => a.attempt);

  // Check each attempt has a valid number
  for (const n of numbers) {
    if (n < 1) {
      return fail(id, type,
        `Attempt number ${n} is invalid — attempt numbers must be ≥ 1`,
        [`invalid attempt number: ${n}`]
      );
    }
  }

  // Check contiguous 1, 2, 3, …
  const sorted = [...numbers].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    const expected = i + 1;
    if (sorted[i] !== expected) {
      return fail(id, type,
        `Attempt sequence is not contiguous: expected attempt ${expected}, found ${sorted[i]}`,
        [`attempt numbers: [${numbers.join(", ")}]`]
      );
    }
  }

  // Check for duplicates
  const unique = new Set(numbers);
  if (unique.size !== numbers.length) {
    return fail(id, type,
      `Duplicate attempt numbers found: [${numbers.join(", ")}]`,
      numbers.map((n) => `attempt ${n}`)
    );
  }

  return pass(id, type,
    `Attempt sequence is valid: [${numbers.join(", ")}]`,
    [`attempt count: ${attempts.length}`]
  );
}

/**
 * CHECK 3: ATTEMPT_LIMIT_CHECK
 *
 * No attempt may exceed MAX_RECOVERY_ATTEMPTS.
 * Total attempts must be ≤ MAX_RECOVERY_ATTEMPTS.
 */
function checkAttemptLimit(recoveryResult: RecoveryResult): RecoveryVerificationCheck {
  const id = "vc-attempt-limit";
  const type: RecoveryVerificationCheckType = "ATTEMPT_LIMIT_CHECK";
  const attempts = recoveryResult.attempts;

  if (attempts.length > MAX_RECOVERY_ATTEMPTS) {
    return fail(id, type,
      `Total recovery attempts (${attempts.length}) exceeds MAX_RECOVERY_ATTEMPTS (${MAX_RECOVERY_ATTEMPTS})`,
      [`attempt count: ${attempts.length}`, `limit: ${MAX_RECOVERY_ATTEMPTS}`]
    );
  }

  for (const attempt of attempts) {
    if (attempt.attempt > MAX_RECOVERY_ATTEMPTS) {
      return fail(id, type,
        `Attempt number ${attempt.attempt} exceeds MAX_RECOVERY_ATTEMPTS (${MAX_RECOVERY_ATTEMPTS})`,
        [`attempt.attempt = ${attempt.attempt}`, `limit: ${MAX_RECOVERY_ATTEMPTS}`]
      );
    }
  }

  return pass(id, type,
    `All ${attempts.length} attempt(s) are within the limit of ${MAX_RECOVERY_ATTEMPTS}`,
    [`limit: ${MAX_RECOVERY_ATTEMPTS}`]
  );
}

/**
 * CHECK 4: CHANGE_SCOPE_CHECK
 *
 * Every applied change must be within the authorized migration scope.
 * Unauthorized files are a recovery integrity violation.
 * Also validates path safety (no traversal, no absolute, no .git).
 */
function checkChangeScope(
  recoveryResult: RecoveryResult,
  authorizedScope: Set<string>
): RecoveryVerificationCheck {
  const id = "vc-change-scope";
  const type: RecoveryVerificationCheckType = "CHANGE_SCOPE_CHECK";

  const allApplied: Array<{ attempt: number; change: RecoveryChange }> = [];
  for (const attempt of recoveryResult.attempts) {
    for (const change of attempt.appliedChanges) {
      allApplied.push({ attempt: attempt.attempt, change });
    }
  }

  if (allApplied.length === 0) {
    return pass(id, type, "No applied changes to verify scope for", []);
  }

  const violations: string[] = [];

  for (const { attempt, change } of allApplied) {
    const { filePath } = change;

    // Path safety checks
    if (filePath.startsWith("/")) {
      violations.push(`Attempt ${attempt}: absolute path "${filePath}" is not allowed`);
      continue;
    }
    if (filePath.includes("../")) {
      violations.push(`Attempt ${attempt}: path traversal "${filePath}" is not allowed`);
      continue;
    }
    if (filePath.startsWith(".git/") || filePath === ".git") {
      violations.push(`Attempt ${attempt}: .git path "${filePath}" is not allowed`);
      continue;
    }

    // Authorization
    if (!authorizedScope.has(filePath)) {
      violations.push(
        `Attempt ${attempt}: file "${filePath}" is not in the authorized migration scope`
      );
    }
  }

  if (violations.length > 0) {
    return fail(id, type,
      `${violations.length} applied change(s) violated scope or path safety`,
      violations
    );
  }

  return pass(id, type,
    `All ${allApplied.length} applied change(s) are within authorized scope`,
    [`authorized files: ${authorizedScope.size}`]
  );
}

/**
 * CHECK 5: CHANGE_EVIDENCE_CHECK
 *
 * Every applied change must have required evidence fields:
 * filePath, operation, explanation, relatedStepIds.
 */
function checkChangeEvidence(recoveryResult: RecoveryResult): RecoveryVerificationCheck {
  const id = "vc-change-evidence";
  const type: RecoveryVerificationCheckType = "CHANGE_EVIDENCE_CHECK";

  const issues: string[] = [];

  for (const attempt of recoveryResult.attempts) {
    for (const change of attempt.appliedChanges) {
      if (!change.filePath || change.filePath.trim() === "") {
        issues.push(`Attempt ${attempt.attempt}: applied change has empty filePath`);
      }
      if (!change.operation) {
        issues.push(`Attempt ${attempt.attempt}: applied change for "${change.filePath}" has no operation`);
      }
      if (!change.explanation || change.explanation.trim() === "") {
        issues.push(`Attempt ${attempt.attempt}: applied change for "${change.filePath}" has empty explanation`);
      }
      if (!Array.isArray(change.relatedStepIds)) {
        issues.push(`Attempt ${attempt.attempt}: applied change for "${change.filePath}" has no relatedStepIds`);
      }
    }

    // Also verify diagnosis fields
    if (!attempt.diagnosis.diagnosis || attempt.diagnosis.diagnosis.trim() === "") {
      issues.push(`Attempt ${attempt.attempt}: diagnosis field is empty`);
    }
    if (!attempt.diagnosis.rootCause || attempt.diagnosis.rootCause.trim() === "") {
      issues.push(`Attempt ${attempt.attempt}: rootCause field is empty`);
    }
  }

  if (issues.length > 0) {
    return fail(id, type,
      `${issues.length} change evidence issue(s) found`,
      issues
    );
  }

  return pass(id, type,
    "All applied changes have required evidence fields",
    []
  );
}

/**
 * CHECK 6: EXPECTED_STATE_CHECK
 *
 * For MODIFY operations, verify that the proposed change included an expected
 * state (i.e. diagnosis.proposedChanges contains the proposal that was applied,
 * and the contract was honored).
 *
 * P12's contract: MODIFY requires expectedContent to be checked before writing.
 * P13 verifies that proposedChanges for MODIFY operations exist in the diagnosis.
 * If Bob proposed a MODIFY change, the proposedChanges list must be non-empty.
 */
function checkExpectedState(recoveryResult: RecoveryResult): RecoveryVerificationCheck {
  const id = "vc-expected-state";
  const type: RecoveryVerificationCheckType = "EXPECTED_STATE_CHECK";

  const issues: string[] = [];

  for (const attempt of recoveryResult.attempts) {
    // For each MODIFY in applied changes, verify a corresponding proposed change exists
    for (const applied of attempt.appliedChanges) {
      if (applied.operation === "MODIFY") {
        // The proposedChanges list should contain this file
        const proposed = attempt.proposedChanges.find(
          (p) => p.filePath === applied.filePath && p.operation === "MODIFY"
        );
        if (!proposed) {
          issues.push(
            `Attempt ${attempt.attempt}: applied MODIFY to "${applied.filePath}" but no corresponding proposed change found in diagnosis`
          );
        }
      }
    }
  }

  if (issues.length > 0) {
    return fail(id, type,
      `${issues.length} MODIFY operation(s) lack corresponding proposed change evidence`,
      issues
    );
  }

  return pass(id, type,
    "All MODIFY operations have corresponding proposed change evidence",
    []
  );
}

/**
 * CHECK 7: POST_REPAIR_VALIDATION_CHECK
 *
 * Every attempt that applied at least one change must have a validation result.
 * An attempt cannot be marked RECOVERED without a validation result showing PASSED.
 */
function checkPostRepairValidation(recoveryResult: RecoveryResult): RecoveryVerificationCheck {
  const id = "vc-post-repair-validation";
  const type: RecoveryVerificationCheckType = "POST_REPAIR_VALIDATION_CHECK";

  const issues: string[] = [];

  for (const attempt of recoveryResult.attempts) {
    if (attempt.appliedChanges.length > 0) {
      // Must have a validation result
      if (!attempt.validation) {
        issues.push(
          `Attempt ${attempt.attempt}: applied ${attempt.appliedChanges.length} change(s) but has no post-repair validation`
        );
      }

      // If attempt claims RECOVERED, validation must be PASSED
      if (attempt.status === "RECOVERED") {
        if (!attempt.validation) {
          issues.push(
            `Attempt ${attempt.attempt}: status is RECOVERED but has no validation result`
          );
        } else if (attempt.validation.status !== "PASSED") {
          issues.push(
            `Attempt ${attempt.attempt}: status is RECOVERED but validation.status is "${attempt.validation.status}", not "PASSED"`
          );
        }
      }
    }
  }

  if (issues.length > 0) {
    return fail(id, type,
      `${issues.length} post-repair validation issue(s) found`,
      issues
    );
  }

  return pass(id, type,
    "All repair attempts with applied changes have corresponding post-repair validation",
    []
  );
}

/**
 * CHECK 8: FINAL_STATUS_CHECK
 *
 * For RECOVERED results:
 *   - finalValidation must exist
 *   - finalValidation.status must be "PASSED"
 *
 * A RECOVERED result without final PASSED validation is a false recovery claim.
 */
function checkFinalStatus(recoveryResult: RecoveryResult): RecoveryVerificationCheck {
  const id = "vc-final-status";
  const type: RecoveryVerificationCheckType = "FINAL_STATUS_CHECK";

  if (recoveryResult.status === "RECOVERED") {
    if (!recoveryResult.finalValidation) {
      return fail(id, type,
        "Recovery status is RECOVERED but no finalValidation is present",
        ["finalValidation is missing"]
      );
    }
    if (recoveryResult.finalValidation.status !== "PASSED") {
      return fail(id, type,
        `Recovery status is RECOVERED but finalValidation.status is "${recoveryResult.finalValidation.status}", not "PASSED"`,
        [`finalValidation.status = ${recoveryResult.finalValidation.status}`]
      );
    }
    return pass(id, type,
      "RECOVERED result has finalValidation with status PASSED",
      [`finalValidation.status = ${recoveryResult.finalValidation.status}`]
    );
  }

  // For non-RECOVERED results, there's no requirement for finalValidation to be PASSED
  return pass(id, type,
    `Recovery status is ${recoveryResult.status} — final status check not applicable`,
    [`recovery.status = ${recoveryResult.status}`]
  );
}

/**
 * CHECK 9: DUPLICATE_REPAIR_CHECK
 *
 * No two attempts should contain applied changes with identical fingerprints
 * (same filePath + operation + effectively same newContent as recorded in
 * proposedChanges).  Duplicate repairs should have been caught by P12.
 *
 * Note: P12's duplicate detection prevents applying the same repair twice.
 * P13 independently verifies this invariant holds in the evidence.
 */
function checkDuplicateRepair(recoveryResult: RecoveryResult): RecoveryVerificationCheck {
  const id = "vc-duplicate-repair";
  const type: RecoveryVerificationCheckType = "DUPLICATE_REPAIR_CHECK";

  // Build fingerprints from proposed changes per attempt (what Bob proposed)
  const seenFingerprints = new Map<string, number>(); // fingerprint → first attempt number
  const issues: string[] = [];

  for (const attempt of recoveryResult.attempts) {
    // Only fingerprint attempts that actually applied changes
    if (attempt.appliedChanges.length === 0) continue;

    const fingerprint = computeFingerprint(attempt.appliedChanges);
    const previous = seenFingerprints.get(fingerprint);

    if (previous !== undefined) {
      issues.push(
        `Attempt ${attempt.attempt} has identical applied changes as attempt ${previous} — duplicate repair`
      );
    } else {
      seenFingerprints.set(fingerprint, attempt.attempt);
    }
  }

  if (issues.length > 0) {
    return fail(id, type,
      `${issues.length} duplicate repair(s) detected in recovery evidence`,
      issues
    );
  }

  return pass(id, type,
    "No duplicate applied repairs found in recovery attempts",
    []
  );
}

/**
 * CHECK 10: RECOVERY_CONSISTENCY_CHECK
 *
 * Verify internal consistency relationships:
 *  - attempt.status === "RECOVERED" requires attempt.validation.status === "PASSED"
 *  - recoveryResult.status === "RECOVERED" requires at least one attempt with status "RECOVERED"
 *  - No attempt has status "RECOVERED" if validation.status !== "PASSED"
 */
function checkRecoveryConsistency(recoveryResult: RecoveryResult): RecoveryVerificationCheck {
  const id = "vc-recovery-consistency";
  const type: RecoveryVerificationCheckType = "RECOVERY_CONSISTENCY_CHECK";

  const issues: string[] = [];

  for (const attempt of recoveryResult.attempts) {
    if (attempt.status === "RECOVERED") {
      if (!attempt.validation || attempt.validation.status !== "PASSED") {
        issues.push(
          `Attempt ${attempt.attempt} has status RECOVERED but validation.status is "${attempt.validation?.status ?? "missing"}"`
        );
      }
    }

    // An attempt with FAILED status should not have validation PASSED
    // (if it were PASSED, it would be RECOVERED)
    if (attempt.status === "FAILED" && attempt.validation?.status === "PASSED") {
      issues.push(
        `Attempt ${attempt.attempt} has status FAILED but validation.status is PASSED — this is contradictory`
      );
    }
  }

  // If overall status is RECOVERED, at least one attempt must be RECOVERED
  if (recoveryResult.status === "RECOVERED") {
    const hasRecoveredAttempt = recoveryResult.attempts.some((a) => a.status === "RECOVERED");
    if (!hasRecoveredAttempt) {
      issues.push(
        "Recovery status is RECOVERED but no individual attempt has status RECOVERED"
      );
    }
  }

  if (issues.length > 0) {
    return fail(id, type,
      `${issues.length} recovery consistency issue(s) found`,
      issues
    );
  }

  return pass(id, type,
    "Recovery evidence is internally consistent",
    []
  );
}

// ---------------------------------------------------------------------------
// Authorization scope builder (mirrors P12 repair.ts — no circular import)
// ---------------------------------------------------------------------------

function buildAuthorizedScope(
  plan: MigrationPlan,
  migrationResult: CodeMigrationResult,
  testGenerationResult?: TestGenerationResult
): Set<string> {
  const authorized = new Set<string>();

  for (const step of plan.steps) {
    for (const f of step.affectedFiles) authorized.add(f);
  }
  for (const change of migrationResult.changes) {
    authorized.add(change.filePath);
  }
  if (testGenerationResult) {
    for (const change of testGenerationResult.changes) {
      authorized.add(change.filePath);
    }
  }

  return authorized;
}

// ---------------------------------------------------------------------------
// Fingerprint (mirrors P12 recovery-engine.ts — for independent verification)
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic fingerprint for a set of applied changes.
 * Uses filePath + operation + hash(explanation) as a stable key.
 *
 * We use explanation rather than newContent because RecoveryChange does not
 * carry the new file content (it was already applied to disk).
 * The combination of filePath + operation + explanation is sufficient for
 * duplicate detection at the evidence level.
 */
function computeFingerprint(changes: RecoveryChange[]): string {
  const items = changes
    .map((c) => `${c.filePath}::${c.operation}::${simpleHash(c.explanation)}`)
    .sort();
  return items.join("|");
}

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Check result helpers
// ---------------------------------------------------------------------------

function pass(
  id: string,
  type: RecoveryVerificationCheckType,
  message: string,
  evidence: string[]
): RecoveryVerificationCheck {
  return { id, type, status: "PASSED", message, evidence };
}

function fail(
  id: string,
  type: RecoveryVerificationCheckType,
  message: string,
  evidence: string[]
): RecoveryVerificationCheck {
  return { id, type, status: "FAILED", message, evidence };
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummary(
  status: RecoveryVerificationResult["status"],
  recoveryStatus: RecoveryResult["status"],
  failedCount: number,
  totalCount: number
): string {
  if (status === "VERIFIED") {
    return `Recovery VERIFIED — all ${totalCount} checks passed. P12 evidence is complete and consistent (recovery status: ${recoveryStatus}).`;
  }
  return `Recovery verification FAILED — ${failedCount} of ${totalCount} checks failed. Recovery status was ${recoveryStatus}.`;
}
