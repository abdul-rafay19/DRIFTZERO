/**
 * P16 Migration Safety Gate — main engine.
 *
 * Deterministic, pure function engine:
 *   same input → same decision
 *
 * Invariants:
 *  - 0 IBM Bob calls
 *  - 0 command executions
 *  - 0 file system access
 *  - All safety checks executed in fixed order (SG-001 → SG-005)
 *  - Missing evidence → STOP_SAFELY (fail-safe)
 *  - Contradictory evidence → STOP_SAFELY
 *  - ALL mandatory checks must PASS for SAFE_TO_PROCEED
 *
 * Does NOT:
 *  - Write files
 *  - Modify code
 *  - Run recovery
 *  - Commit/push
 *  - Create PRs
 *  - Implement P17+
 */

import { ValidationError } from "@driftzero/shared";
import type {
  SafetyGateInput,
  SafetyGateResult,
  SafetyCheckResult,
  SafetyReason,
  SafetySummary,
  SafetyDecision,
} from "@driftzero/shared";
import { logger } from "../utils/logger.js";
import { safetyGateInputSchema } from "./safety-types.js";
import {
  evaluateValidation,
  evaluateRecoveryVerification,
  evaluateUnexpectedChanges,
  evaluateSecurity,
  evaluateEvidenceConsistency,
  checkToBlockingReason,
  deduplicateReasons,
} from "./safety-rules.js";

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the P16 Migration Safety Gate.
 *
 * @throws {ValidationError}   on invalid Zod input
 *
 * Pure function — never throws for safety-logic failures.
 * Returns STOP_SAFELY with explicit reasons for all failure cases.
 */
export function runSafetyGate(input: SafetyGateInput): SafetyGateResult {
  // 1. Validate input at the boundary
  const parsed = safetyGateInputSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    throw new ValidationError(message);
  }

  const { workspaceId, validation, recoveryVerification, unexpectedChanges, security } =
    parsed.data;

  logger.info("Safety gate evaluation started", { workspaceId });

  // 2. Run all checks in fixed order
  const sg001 = evaluateValidation(validation);
  const sg002 = evaluateRecoveryVerification(recoveryVerification);
  const sg003 = evaluateUnexpectedChanges(unexpectedChanges);
  const sg004result = evaluateSecurity(security);
  const sg004 = sg004result.check;
  const sg005 = evaluateEvidenceConsistency(
    workspaceId,
    validation,
    recoveryVerification,
    unexpectedChanges,
    security
  );

  const checks: SafetyCheckResult[] = [sg001, sg002, sg003, sg004, sg005];

  // 3. Collect blocking reasons from failed/not-verified checks
  const rawBlockingReasons: SafetyReason[] = checks
    .filter((c) => c.blocking && (c.status === "FAIL" || c.status === "NOT_VERIFIED"))
    .map(checkToBlockingReason);

  // 4. Add security-specific blocking reasons for individual findings
  //    (if SG-004 is blocking due to specific findings, add finding-level reasons)
  if (sg004.status === "FAIL") {
    const blockingFindings = security.findings.filter(
      (f) => f.severity === "CRITICAL" || f.severity === "HIGH"
    );
    for (const finding of blockingFindings) {
      rawBlockingReasons.push({
        code: `SECURITY_${finding.severity}_FINDING`,
        severity: "ERROR",
        title: `Security finding (${finding.severity}): ${finding.title}`,
        message: finding.description,
        evidence: [
          `finding id: ${finding.id}`,
          `category: ${finding.category}`,
          `severity: ${finding.severity}`,
          ...(finding.filePath ? [`file: ${finding.filePath}`] : []),
          ...finding.evidence.slice(0, 3),
        ],
      });
    }
  }

  // 5. Deduplicate blocking reasons
  const blockingReasons = deduplicateReasons(rawBlockingReasons);

  // 6. Collect warnings from security evaluation
  const warnings = deduplicateReasons(sg004result.warnings);

  // 7. Determine final decision
  const hasMandatoryFailure = checks.some(
    (c) => c.blocking && (c.status === "FAIL" || c.status === "NOT_VERIFIED")
  );

  const decision: SafetyDecision = hasMandatoryFailure
    ? "STOP_SAFELY"
    : "SAFE_TO_PROCEED";

  // 8. Build summary
  const summary = buildSummary(checks, blockingReasons, warnings);

  logger.info("Safety gate evaluation completed", {
    workspaceId,
    decision,
    blockingReasons: blockingReasons.length,
    warnings: warnings.length,
  });

  return {
    workspaceId,
    decision,
    checks,
    blockingReasons,
    warnings,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummary(
  checks: SafetyCheckResult[],
  blockingReasons: SafetyReason[],
  warnings: SafetyReason[]
): SafetySummary {
  return {
    totalChecks: checks.length,
    passed: checks.filter((c) => c.status === "PASS").length,
    failed: checks.filter((c) => c.status === "FAIL").length,
    notVerified: checks.filter((c) => c.status === "NOT_VERIFIED").length,
    blockingReasonCount: blockingReasons.length,
    warningCount: warnings.length,
  };
}
