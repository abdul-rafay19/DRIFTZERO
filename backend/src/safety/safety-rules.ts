/**
 * P16 Safety Gate — deterministic rule definitions.
 *
 * Every rule is a pure function: (input) → SafetyCheckResult.
 *
 * Rules are evaluated in stable order:
 *   SG-001  Validation Status
 *   SG-002  Recovery Verification
 *   SG-003  Unexpected Changes
 *   SG-004  Security Findings
 *   SG-005  Evidence Consistency
 *
 * Core invariants:
 *  - 0 Bob calls
 *  - 0 command executions
 *  - 0 file system access
 *  - Pure functions: same input → same output
 *  - Missing / unrecognized / contradictory evidence → FAIL / NOT_VERIFIED
 *  - Never optimistic: uncertainty → STOP_SAFELY
 */

import type {
  SafetyCheckResult,
  SafetyReason,
  ValidationResult,
  RecoveryVerificationResult,
  UnexpectedChangeDetectionResult,
  SecurityScanResult,
  SecurityFinding,
} from "@driftzero/shared";

// ---------------------------------------------------------------------------
// Security severity policy — deterministic, documented
// ---------------------------------------------------------------------------

/**
 * Blocking severities: CRITICAL and HIGH always block progression.
 * Warning severities: MEDIUM and LOW produce advisory warnings only.
 */
export const BLOCKING_SEVERITIES = new Set<SecurityFinding["severity"]>(["CRITICAL", "HIGH"]);
export const WARNING_SEVERITIES = new Set<SecurityFinding["severity"]>(["MEDIUM", "LOW"]);

// ---------------------------------------------------------------------------
// SG-001 — P11 Validation Status
// ---------------------------------------------------------------------------

/**
 * Safe condition:  validation.status === "PASSED"
 * Blocking:        FAILED, NOT_VALIDATED, or any other value
 */
export function evaluateValidation(
  validation: ValidationResult
): SafetyCheckResult {
  const id = "SG-001";
  const name = "P11 Validation Status";

  if (validation.status === "PASSED") {
    const passedChecks = validation.checks.filter((c) => c.status === "PASSED").length;
    return {
      id, name, status: "PASS", blocking: true,
      reason: `All validation checks passed (${passedChecks}/${validation.summary.total}).`,
      evidence: [
        `workspaceId: ${validation.workspaceId}`,
        `validation.status: PASSED`,
        `checks passed: ${passedChecks}/${validation.summary.total}`,
      ],
    };
  }

  // FAILED or NOT_VALIDATED
  const failedChecks = validation.checks.filter((c) => c.status === "FAILED");
  const evidence = [
    `workspaceId: ${validation.workspaceId}`,
    `validation.status: ${validation.status}`,
    `failed checks: ${failedChecks.length}`,
    ...failedChecks.slice(0, 5).map(
      (c) => `  [${c.type}] ${c.id}: ${c.reason ?? "no reason"}`
    ),
  ];

  return {
    id, name, status: "FAIL", blocking: true,
    reason: `Validation did not pass (status: ${validation.status}). Migration must not proceed.`,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// SG-002 — P13 Recovery Verification
// ---------------------------------------------------------------------------

/**
 * Safe conditions:
 *   - recoveryVerification.status === "NOT_REQUIRED"  (no recovery needed)
 *   - recoveryVerification.status === "VERIFIED"       (recovery confirmed)
 *
 * Blocking:
 *   - "FAILED" — recovery evidence is invalid or insufficient
 *   - anything else → NOT_VERIFIED
 */
export function evaluateRecoveryVerification(
  rv: RecoveryVerificationResult
): SafetyCheckResult {
  const id = "SG-002";
  const name = "P13 Recovery Verification";

  if (rv.status === "NOT_REQUIRED") {
    return {
      id, name, status: "PASS", blocking: true,
      reason: "Recovery was not required — initial validation already passed.",
      evidence: [
        `recoveryVerification.status: NOT_REQUIRED`,
        `recoveryVerification.recoveryStatus: ${rv.recoveryStatus}`,
      ],
    };
  }

  if (rv.status === "VERIFIED") {
    return {
      id, name, status: "PASS", blocking: true,
      reason: `Recovery was verified (${rv.verifiedAttempts} attempt(s), ${rv.verifiedChanges} change(s)).`,
      evidence: [
        `recoveryVerification.status: VERIFIED`,
        `verifiedAttempts: ${rv.verifiedAttempts}`,
        `verifiedChanges: ${rv.verifiedChanges}`,
      ],
    };
  }

  // FAILED
  const failedChecks = rv.checks.filter((c) => c.status === "FAILED");
  const evidence = [
    `recoveryVerification.status: ${rv.status}`,
    `recoveryVerification.recoveryStatus: ${rv.recoveryStatus}`,
    `verification errors: ${rv.errors.length}`,
    ...rv.errors.slice(0, 5).map((e) => `  ${e}`),
    ...failedChecks.slice(0, 5).map((c) => `  FAILED check [${c.type}]: ${c.message}`),
  ];

  return {
    id, name, status: "FAIL", blocking: true,
    reason: `Recovery verification failed (${rv.errors.length} error(s)). Migration must not proceed.`,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// SG-003 — P14 Unexpected Change Detection
// ---------------------------------------------------------------------------

/**
 * Safe condition:  unexpectedChanges.status === "CLEAN"
 * Blocking:        UNEXPECTED_CHANGES (unauthorized scope)
 * NOT_VERIFIED:    FAILED (engine could not reliably detect) → conservative stop
 */
export function evaluateUnexpectedChanges(
  uc: UnexpectedChangeDetectionResult
): SafetyCheckResult {
  const id = "SG-003";
  const name = "P14 Unexpected Change Detection";

  if (uc.status === "CLEAN") {
    return {
      id, name, status: "PASS", blocking: true,
      reason: `No unauthorized workspace changes detected (${uc.summary.totalActualChanges} actual change(s), all authorized).`,
      evidence: [
        `workspaceId: ${uc.workspaceId}`,
        `unexpectedChanges.status: CLEAN`,
        `totalActualChanges: ${uc.summary.totalActualChanges}`,
        `totalExpectedChanges: ${uc.summary.totalExpectedChanges}`,
      ],
    };
  }

  if (uc.status === "UNEXPECTED_CHANGES") {
    const examples = uc.unexpectedChanges.slice(0, 5).map(
      (u) => `  [${u.changeType}] ${u.filePath} (${u.reason})`
    );
    const evidence = [
      `workspaceId: ${uc.workspaceId}`,
      `unexpectedChanges.status: UNEXPECTED_CHANGES`,
      `unauthorized changes: ${uc.unexpectedChanges.length}`,
      ...examples,
    ];
    return {
      id, name, status: "FAIL", blocking: true,
      reason: `${uc.unexpectedChanges.length} unauthorized workspace change(s) detected. Migration must not proceed.`,
      evidence,
    };
  }

  // FAILED — engine could not establish authorized scope
  return {
    id, name, status: "NOT_VERIFIED", blocking: true,
    reason: "Unexpected change detection could not establish workspace scope. Failing safely.",
    evidence: [
      `workspaceId: ${uc.workspaceId}`,
      `unexpectedChanges.status: ${uc.status}`,
    ],
  };
}

// ---------------------------------------------------------------------------
// SG-004 — P15 Security Findings
// ---------------------------------------------------------------------------

/**
 * Security policy (deterministic):
 *   CRITICAL / HIGH   → blocking
 *   MEDIUM / LOW      → advisory warning
 *   P15 PARTIAL       → NOT_VERIFIED → conservative stop
 *   P15 FAILED        → NOT_VERIFIED → conservative stop
 *   P15 CLEAN         → PASS
 *   P15 FINDINGS      → evaluate individual findings; blocking if any CRITICAL/HIGH
 */
export function evaluateSecurity(
  security: SecurityScanResult
): { check: SafetyCheckResult; warnings: SafetyReason[] } {
  const id = "SG-004";
  const name = "P15 Security Engine";

  // P15 engine failure or partial — conservative stop
  if (security.status === "FAILED") {
    return {
      check: {
        id, name, status: "NOT_VERIFIED", blocking: true,
        reason: "Security engine reported a failure status. Cannot verify security. Failing safely.",
        evidence: [
          `workspaceId: ${security.workspaceId}`,
          `security.status: FAILED`,
        ],
      },
      warnings: [],
    };
  }

  if (security.status === "PARTIAL") {
    // Determine which optional component was unavailable
    const unavailableChecks = security.checks
      .filter((c) => c.status === "SKIPPED" || c.status === "FAILED")
      .map((c) => c.name);
    return {
      check: {
        id, name, status: "NOT_VERIFIED", blocking: true,
        reason:
          "Security scan is PARTIAL — one or more required checks could not be verified. " +
          "Cannot approve migration with incomplete security evidence.",
        evidence: [
          `workspaceId: ${security.workspaceId}`,
          `security.status: PARTIAL`,
          `unverified components: ${unavailableChecks.join(", ") || "(unknown)"}`,
        ],
      },
      warnings: [],
    };
  }

  // CLEAN — all checks ran, no findings
  if (security.status === "CLEAN") {
    return {
      check: {
        id, name, status: "PASS", blocking: true,
        reason: "Security scan completed with no findings.",
        evidence: [
          `workspaceId: ${security.workspaceId}`,
          `security.status: CLEAN`,
          `totalFindings: 0`,
        ],
      },
      warnings: [],
    };
  }

  // FINDINGS — evaluate individual findings
  const blockingFindings = security.findings.filter(
    (f) => BLOCKING_SEVERITIES.has(f.severity)
  );
  const warningFindings = security.findings.filter(
    (f) => WARNING_SEVERITIES.has(f.severity)
  );

  // Build warnings for MEDIUM/LOW
  const warnings: SafetyReason[] = warningFindings.map((f) => ({
    code: `SECURITY_${f.severity}_FINDING`,
    severity: "WARNING" as const,
    title: `Security finding (${f.severity}): ${f.title}`,
    message: f.description,
    evidence: [
      `finding id: ${f.id}`,
      `category: ${f.category}`,
      `severity: ${f.severity}`,
      ...(f.filePath ? [`file: ${f.filePath}`] : []),
      ...f.evidence.slice(0, 3),
    ],
  }));

  if (blockingFindings.length === 0) {
    return {
      check: {
        id, name, status: "PASS", blocking: true,
        reason: `Security findings exist but none are blocking (${warningFindings.length} warning(s) only).`,
        evidence: [
          `workspaceId: ${security.workspaceId}`,
          `security.status: FINDINGS`,
          `blocking findings: 0`,
          `warning findings: ${warningFindings.length}`,
          `total findings: ${security.summary.totalFindings}`,
        ],
      },
      warnings,
    };
  }

  // Blocking findings exist
  const evidence = [
    `workspaceId: ${security.workspaceId}`,
    `security.status: FINDINGS`,
    `blocking findings: ${blockingFindings.length} (CRITICAL: ${security.summary.critical}, HIGH: ${security.summary.high})`,
    ...blockingFindings.slice(0, 5).map(
      (f) => `  [${f.severity}/${f.category}] ${f.id}: ${f.title}` +
        (f.filePath ? ` (${f.filePath})` : "")
    ),
  ];

  return {
    check: {
      id, name, status: "FAIL", blocking: true,
      reason: `${blockingFindings.length} blocking security finding(s) detected (CRITICAL: ${security.summary.critical}, HIGH: ${security.summary.high}).`,
      evidence,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// SG-005 — Evidence Consistency
// ---------------------------------------------------------------------------

/**
 * Cross-checks supplied results for internal consistency.
 *
 * Checks:
 *   (a) workspaceId consistency across all results that contain one
 *   (b) Recovery verification / validation cross-check:
 *       if recoveryVerification.status === "NOT_REQUIRED", the validation
 *       status should be PASSED (or at least not have a contradiction).
 *   (c) Unexpected changes workspaceId matches top-level workspaceId
 */
export function evaluateEvidenceConsistency(
  workspaceId: string,
  validation: ValidationResult,
  rv: RecoveryVerificationResult,
  uc: UnexpectedChangeDetectionResult,
  security: SecurityScanResult
): SafetyCheckResult {
  const id = "SG-005";
  const name = "Evidence Consistency";
  const violations: string[] = [];

  // (a) workspaceId consistency
  const wsIds: Record<string, string> = {
    "input.workspaceId": workspaceId,
    "validation.workspaceId": validation.workspaceId,
    "unexpectedChanges.workspaceId": uc.workspaceId,
    "security.workspaceId": security.workspaceId,
  };

  for (const [label, wsId] of Object.entries(wsIds)) {
    if (wsId !== workspaceId) {
      violations.push(`workspaceId mismatch: ${label} = "${wsId}" (expected "${workspaceId}")`);
    }
  }

  // (b) Recovery-validation cross-check
  // If P13 says NOT_REQUIRED, the initial validation must have been PASSED.
  // We verify: validation.status must be PASSED when rv.status is NOT_REQUIRED.
  if (
    rv.status === "NOT_REQUIRED" &&
    rv.recoveryStatus !== "NOT_NEEDED" &&
    rv.recoveryStatus !== "RECOVERED"
  ) {
    violations.push(
      `Recovery verification contradiction: status=NOT_REQUIRED but recoveryStatus=${rv.recoveryStatus}`
    );
  }

  // (c) If rv.status === "NOT_REQUIRED", validation should be PASSED.
  if (rv.status === "NOT_REQUIRED" && validation.status !== "PASSED") {
    violations.push(
      `Contradiction: recovery verification is NOT_REQUIRED but validation.status=${validation.status}. ` +
      `NOT_REQUIRED implies initial validation was already passing.`
    );
  }

  // (d) If rv.status === "VERIFIED", check that finalValidation (if present) is PASSED
  if (
    rv.status === "VERIFIED" &&
    rv.finalValidation !== undefined &&
    rv.finalValidation.status !== "PASSED"
  ) {
    violations.push(
      `Contradiction: recovery verification is VERIFIED but finalValidation.status=${rv.finalValidation.status}`
    );
  }

  if (violations.length > 0) {
    return {
      id, name, status: "FAIL", blocking: true,
      reason: `Evidence consistency failure: ${violations.length} contradiction(s) detected. Cannot trust supplied evidence.`,
      evidence: violations,
    };
  }

  return {
    id, name, status: "PASS", blocking: true,
    reason: "All supplied evidence is internally consistent.",
    evidence: [
      `workspaceId: ${workspaceId}`,
      `All workspace IDs match.`,
      `Recovery-validation cross-check: consistent.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Blocking reason builders
// ---------------------------------------------------------------------------

/**
 * Build a structured SafetyReason from a failing/not-verified check.
 * Called by the main engine to populate blockingReasons.
 */
export function checkToBlockingReason(check: SafetyCheckResult): SafetyReason {
  const codeMap: Record<string, string> = {
    "SG-001": "VALIDATION_FAILED",
    "SG-002": "RECOVERY_NOT_VERIFIED",
    "SG-003": "UNEXPECTED_CHANGE",
    "SG-004": "SECURITY_FINDING_BLOCKING",
    "SG-005": "EVIDENCE_CONFLICT",
  };

  const code = codeMap[check.id] ?? `${check.id}_FAILED`;

  // NOT_VERIFIED is also a blocking-level issue
  const title =
    check.status === "NOT_VERIFIED"
      ? `${check.name} — Not Verified`
      : `${check.name} — Failed`;

  return {
    code,
    severity: "ERROR",
    title,
    message: check.reason,
    evidence: check.evidence,
  };
}

/**
 * Deduplicate reasons by code. Preserves first occurrence.
 */
export function deduplicateReasons(reasons: SafetyReason[]): SafetyReason[] {
  const seen = new Set<string>();
  return reasons.filter((r) => {
    if (seen.has(r.code)) return false;
    seen.add(r.code);
    return true;
  });
}
