/**
 * P16 Migration Safety Gate — comprehensive test suite.
 *
 * Covers:
 *  - SG-001 Validation rule (PASSED, FAILED, NOT_VALIDATED)
 *  - SG-002 Recovery Verification rule (NOT_REQUIRED, VERIFIED, FAILED)
 *  - SG-003 Unexpected Changes rule (CLEAN, UNEXPECTED_CHANGES, FAILED)
 *  - SG-004 Security Findings rule (CLEAN, FINDINGS by severity, PARTIAL, FAILED)
 *  - SG-005 Evidence Consistency rule (workspaceId, cross-checks)
 *  - Combined decision matrix (all pass, each individual fail)
 *  - Determinism
 *  - P16 boundary (no P17+ fields, no Bob calls, no commands)
 *  - Express 4→5 positive and negative proof fixtures
 */

import { describe, it, expect } from "vitest";
import { runSafetyGate } from "./safety-gate.js";
import {
  evaluateValidation,
  evaluateRecoveryVerification,
  evaluateUnexpectedChanges,
  evaluateSecurity,
  evaluateEvidenceConsistency,
} from "./safety-rules.js";
import type {
  SafetyGateInput,
  ValidationResult,
  RecoveryVerificationResult,
  UnexpectedChangeDetectionResult,
  SecurityScanResult,
  SecurityFinding,
} from "@driftzero/shared";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const WS_ID = "ws_test_p16";

function makeValidation(
  status: "PASSED" | "FAILED" | "NOT_VALIDATED" = "PASSED",
  workspaceId = WS_ID
): ValidationResult {
  return {
    workspaceId,
    status,
    checks: status === "PASSED"
      ? [{ id: "check-build", type: "BUILD", status: "PASSED", durationMs: 100 }]
      : [
          { id: "check-build", type: "BUILD", status: "FAILED", durationMs: 100,
            reason: "Build failed with exit code 1" },
        ],
    summary: { total: 1, passed: status === "PASSED" ? 1 : 0, failed: status === "PASSED" ? 0 : 1, notApplicable: 0, skipped: 0 },
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
  };
}

function makeRecoveryVerification(
  status: "NOT_REQUIRED" | "VERIFIED" | "FAILED" = "NOT_REQUIRED",
  recoveryStatus: "RECOVERED" | "NOT_NEEDED" | "FAILED" | "STOPPED" = "NOT_NEEDED"
): RecoveryVerificationResult {
  return {
    status,
    recoveryStatus,
    checks: status === "FAILED"
      ? [{ id: "vc-final", type: "FINAL_STATUS_CHECK", status: "FAILED",
           message: "Final validation was not PASSED" }]
      : [{ id: "vc-final", type: "FINAL_STATUS_CHECK", status: "PASSED",
           message: "Final validation is PASSED" }],
    finalValidation: status === "VERIFIED"
      ? { workspaceId: WS_ID, status: "PASSED", checks: [], summary: { total: 0, passed: 0, failed: 0, notApplicable: 0, skipped: 0 }, startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:01:00.000Z" }
      : undefined,
    verifiedAttempts: status === "VERIFIED" ? 1 : 0,
    verifiedChanges: status === "VERIFIED" ? 2 : 0,
    errors: status === "FAILED" ? ["Final validation was not PASSED"] : [],
    summary: status === "FAILED" ? "Recovery verification FAILED" : "Recovery verification passed",
  };
}

function makeUnexpectedChanges(
  status: "CLEAN" | "UNEXPECTED_CHANGES" | "FAILED" = "CLEAN",
  workspaceId = WS_ID
): UnexpectedChangeDetectionResult {
  return {
    workspaceId,
    status,
    actualChanges: [{ filePath: "src/app.ts", changeType: "MODIFIED" }],
    expectedChanges: status === "CLEAN"
      ? [{ filePath: "src/app.ts", source: "P9", relatedStepIds: ["STEP-001"] }]
      : [],
    unexpectedChanges: status === "UNEXPECTED_CHANGES"
      ? [{ filePath: "src/evil.ts", changeType: "MODIFIED", reason: "NOT_IN_MIGRATION_SCOPE", evidence: ["Not authorized"] }]
      : [],
    summary: {
      totalActualChanges: 1,
      totalExpectedChanges: status === "CLEAN" ? 1 : 0,
      totalUnexpectedChanges: status === "UNEXPECTED_CHANGES" ? 1 : 0,
      added: 0, modified: 1, deleted: 0, renamed: 0,
    },
  };
}

function makeSecurity(
  status: "CLEAN" | "FINDINGS" | "PARTIAL" | "FAILED" = "CLEAN",
  findings: SecurityFinding[] = [],
  workspaceId = WS_ID
): SecurityScanResult {
  const summary = {
    totalFindings: findings.length,
    critical: findings.filter((f) => f.severity === "CRITICAL").length,
    high: findings.filter((f) => f.severity === "HIGH").length,
    medium: findings.filter((f) => f.severity === "MEDIUM").length,
    low: findings.filter((f) => f.severity === "LOW").length,
    secretsDetected: findings.filter((f) => f.category === "SECRET").length,
    dependencyFindings: 0,
    codeFindings: findings.filter((f) => f.category === "CODE").length,
    configurationFindings: 0,
    aiReviewFindings: 0,
  };

  return {
    workspaceId,
    status,
    findings,
    summary,
    checks: [
      { id: "secret-scan", name: "Secret Scanner", status: "PASSED", findingCount: 0, durationMs: 10 },
      { id: "dependency-audit", name: "Dependency Audit",
        status: status === "PARTIAL" ? "SKIPPED" : "PASSED",
        findingCount: 0, durationMs: 5,
        reason: status === "PARTIAL" ? "npm audit not available" : undefined },
      { id: "bob-security-review", name: "IBM Bob Security Review",
        status: "PASSED", findingCount: 0, durationMs: 200 },
    ],
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:02:00.000Z",
  };
}

function makeSecurityFinding(
  severity: SecurityFinding["severity"],
  id = "SEC-001",
  category: SecurityFinding["category"] = "CODE"
): SecurityFinding {
  return {
    id,
    category,
    severity,
    title: `Test finding (${severity})`,
    description: `A ${severity} severity finding for testing`,
    filePath: "src/test.ts",
    line: 10,
    evidence: [`Pattern found at line 10`, `File: src/test.ts`],
    source: "DETERMINISTIC",
  };
}

function makeFullInput(overrides: Partial<SafetyGateInput> = {}): SafetyGateInput {
  return {
    workspaceId: WS_ID,
    validation: makeValidation("PASSED"),
    recoveryVerification: makeRecoveryVerification("NOT_REQUIRED", "NOT_NEEDED"),
    unexpectedChanges: makeUnexpectedChanges("CLEAN"),
    security: makeSecurity("CLEAN"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ============================================================
// SG-001 — Validation Status
// ============================================================
// ---------------------------------------------------------------------------

describe("SG-001 — Validation Status", () => {
  it("PASSED → PASS", () => {
    const result = evaluateValidation(makeValidation("PASSED"));
    expect(result.id).toBe("SG-001");
    expect(result.status).toBe("PASS");
    expect(result.blocking).toBe(true);
  });

  it("FAILED → FAIL (blocking)", () => {
    const result = evaluateValidation(makeValidation("FAILED"));
    expect(result.status).toBe("FAIL");
    expect(result.blocking).toBe(true);
    expect(result.reason).toMatch(/did not pass/i);
  });

  it("NOT_VALIDATED → FAIL (blocking)", () => {
    const result = evaluateValidation(makeValidation("NOT_VALIDATED"));
    expect(result.status).toBe("FAIL");
    expect(result.blocking).toBe(true);
  });

  it("evidence includes workspaceId and failed check details", () => {
    const validation = makeValidation("FAILED");
    const result = evaluateValidation(validation);
    const allEvidence = result.evidence.join("\n");
    expect(allEvidence).toContain(WS_ID);
    expect(allEvidence).toContain("FAILED");
  });

  it("FAILED validation → runSafetyGate returns STOP_SAFELY", () => {
    const result = runSafetyGate(makeFullInput({ validation: makeValidation("FAILED") }));
    expect(result.decision).toBe("STOP_SAFELY");
    expect(result.blockingReasons.some((r) => r.code === "VALIDATION_FAILED")).toBe(true);
  });

  it("PASSED validation contributes to SAFE_TO_PROCEED", () => {
    const result = runSafetyGate(makeFullInput());
    expect(result.decision).toBe("SAFE_TO_PROCEED");
    const sg001 = result.checks.find((c) => c.id === "SG-001");
    expect(sg001?.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// ============================================================
// SG-002 — Recovery Verification
// ============================================================
// ---------------------------------------------------------------------------

describe("SG-002 — Recovery Verification", () => {
  it("NOT_REQUIRED → PASS", () => {
    const result = evaluateRecoveryVerification(
      makeRecoveryVerification("NOT_REQUIRED", "NOT_NEEDED")
    );
    expect(result.id).toBe("SG-002");
    expect(result.status).toBe("PASS");
    expect(result.reason).toMatch(/not required/i);
  });

  it("VERIFIED → PASS", () => {
    const result = evaluateRecoveryVerification(
      makeRecoveryVerification("VERIFIED", "RECOVERED")
    );
    expect(result.status).toBe("PASS");
    expect(result.reason).toMatch(/verified/i);
  });

  it("FAILED → FAIL (blocking)", () => {
    const result = evaluateRecoveryVerification(
      makeRecoveryVerification("FAILED", "FAILED")
    );
    expect(result.status).toBe("FAIL");
    expect(result.blocking).toBe(true);
  });

  it("FAILED recovery verification → runSafetyGate returns STOP_SAFELY", () => {
    const result = runSafetyGate(
      makeFullInput({ recoveryVerification: makeRecoveryVerification("FAILED", "FAILED") })
    );
    expect(result.decision).toBe("STOP_SAFELY");
    expect(result.blockingReasons.some((r) => r.code === "RECOVERY_NOT_VERIFIED")).toBe(true);
  });

  it("evidence includes recovery status and error count", () => {
    const rv = makeRecoveryVerification("FAILED", "FAILED");
    const result = evaluateRecoveryVerification(rv);
    expect(result.evidence.join("\n")).toContain("FAILED");
  });

  it("VERIFIED recovery with finalValidation PASSED → PASS", () => {
    const rv: RecoveryVerificationResult = {
      ...makeRecoveryVerification("VERIFIED", "RECOVERED"),
      finalValidation: {
        workspaceId: WS_ID, status: "PASSED",
        checks: [], summary: { total: 0, passed: 0, failed: 0, notApplicable: 0, skipped: 0 },
        startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:01:00.000Z",
      },
    };
    const result = evaluateRecoveryVerification(rv);
    expect(result.status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// ============================================================
// SG-003 — Unexpected Changes
// ============================================================
// ---------------------------------------------------------------------------

describe("SG-003 — Unexpected Change Detection", () => {
  it("CLEAN → PASS", () => {
    const result = evaluateUnexpectedChanges(makeUnexpectedChanges("CLEAN"));
    expect(result.id).toBe("SG-003");
    expect(result.status).toBe("PASS");
  });

  it("UNEXPECTED_CHANGES → FAIL (blocking)", () => {
    const result = evaluateUnexpectedChanges(makeUnexpectedChanges("UNEXPECTED_CHANGES"));
    expect(result.status).toBe("FAIL");
    expect(result.blocking).toBe(true);
    expect(result.reason).toMatch(/unauthorized/i);
  });

  it("FAILED → NOT_VERIFIED (conservative stop)", () => {
    const result = evaluateUnexpectedChanges(makeUnexpectedChanges("FAILED"));
    expect(result.status).toBe("NOT_VERIFIED");
    expect(result.blocking).toBe(true);
  });

  it("UNEXPECTED_CHANGES → runSafetyGate returns STOP_SAFELY", () => {
    const result = runSafetyGate(
      makeFullInput({ unexpectedChanges: makeUnexpectedChanges("UNEXPECTED_CHANGES") })
    );
    expect(result.decision).toBe("STOP_SAFELY");
    expect(result.blockingReasons.some((r) => r.code === "UNEXPECTED_CHANGE")).toBe(true);
  });

  it("CLEAN unexpected changes contributes to SAFE_TO_PROCEED", () => {
    const result = runSafetyGate(makeFullInput());
    const sg003 = result.checks.find((c) => c.id === "SG-003");
    expect(sg003?.status).toBe("PASS");
  });

  it("FAILED (engine failure) → runSafetyGate returns STOP_SAFELY", () => {
    const result = runSafetyGate(
      makeFullInput({ unexpectedChanges: makeUnexpectedChanges("FAILED") })
    );
    expect(result.decision).toBe("STOP_SAFELY");
  });

  it("evidence lists unauthorized file paths", () => {
    const uc = makeUnexpectedChanges("UNEXPECTED_CHANGES");
    const result = evaluateUnexpectedChanges(uc);
    expect(result.evidence.join("\n")).toContain("src/evil.ts");
  });
});

// ---------------------------------------------------------------------------
// ============================================================
// SG-004 — Security Findings
// ============================================================
// ---------------------------------------------------------------------------

describe("SG-004 — Security Findings", () => {
  it("CLEAN → PASS", () => {
    const { check } = evaluateSecurity(makeSecurity("CLEAN"));
    expect(check.id).toBe("SG-004");
    expect(check.status).toBe("PASS");
  });

  it("CRITICAL finding → FAIL (blocking)", () => {
    const { check } = evaluateSecurity(
      makeSecurity("FINDINGS", [makeSecurityFinding("CRITICAL")])
    );
    expect(check.status).toBe("FAIL");
    expect(check.blocking).toBe(true);
  });

  it("HIGH finding → FAIL (blocking)", () => {
    const { check } = evaluateSecurity(
      makeSecurity("FINDINGS", [makeSecurityFinding("HIGH")])
    );
    expect(check.status).toBe("FAIL");
    expect(check.blocking).toBe(true);
  });

  it("MEDIUM finding only → PASS (with warning)", () => {
    const { check, warnings } = evaluateSecurity(
      makeSecurity("FINDINGS", [makeSecurityFinding("MEDIUM")])
    );
    expect(check.status).toBe("PASS");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]!.severity).toBe("WARNING");
  });

  it("LOW finding only → PASS (with warning)", () => {
    const { check, warnings } = evaluateSecurity(
      makeSecurity("FINDINGS", [makeSecurityFinding("LOW")])
    );
    expect(check.status).toBe("PASS");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("PARTIAL → NOT_VERIFIED (conservative stop)", () => {
    const { check } = evaluateSecurity(makeSecurity("PARTIAL"));
    expect(check.status).toBe("NOT_VERIFIED");
    expect(check.blocking).toBe(true);
  });

  it("FAILED → NOT_VERIFIED (conservative stop)", () => {
    const { check } = evaluateSecurity(makeSecurity("FAILED"));
    expect(check.status).toBe("NOT_VERIFIED");
    expect(check.blocking).toBe(true);
  });

  it("CRITICAL finding → runSafetyGate returns STOP_SAFELY with specific reason", () => {
    const result = runSafetyGate(
      makeFullInput({ security: makeSecurity("FINDINGS", [makeSecurityFinding("CRITICAL")]) })
    );
    expect(result.decision).toBe("STOP_SAFELY");
    const hasSecurityReason = result.blockingReasons.some(
      (r) => r.code.includes("SECURITY") || r.code === "SECURITY_FINDING_BLOCKING"
    );
    expect(hasSecurityReason).toBe(true);
  });

  it("HIGH finding → runSafetyGate returns STOP_SAFELY", () => {
    const result = runSafetyGate(
      makeFullInput({ security: makeSecurity("FINDINGS", [makeSecurityFinding("HIGH")]) })
    );
    expect(result.decision).toBe("STOP_SAFELY");
  });

  it("MEDIUM finding only → runSafetyGate returns SAFE_TO_PROCEED with warnings", () => {
    const result = runSafetyGate(
      makeFullInput({ security: makeSecurity("FINDINGS", [makeSecurityFinding("MEDIUM")]) })
    );
    expect(result.decision).toBe("SAFE_TO_PROCEED");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("LOW finding only → runSafetyGate returns SAFE_TO_PROCEED with warnings", () => {
    const result = runSafetyGate(
      makeFullInput({ security: makeSecurity("FINDINGS", [makeSecurityFinding("LOW")]) })
    );
    expect(result.decision).toBe("SAFE_TO_PROCEED");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("P15 PARTIAL → STOP_SAFELY (dependency audit unavailable = not verified)", () => {
    const result = runSafetyGate(
      makeFullInput({ security: makeSecurity("PARTIAL") })
    );
    expect(result.decision).toBe("STOP_SAFELY");
    const sg004 = result.checks.find((c) => c.id === "SG-004");
    expect(sg004?.status).toBe("NOT_VERIFIED");
  });

  it("blocking finding evidence does not contain raw secret values", () => {
    // Finding evidence should only contain redacted/descriptive info
    const finding = makeSecurityFinding("CRITICAL", "SEC-001", "SECRET");
    const result = runSafetyGate(
      makeFullInput({ security: makeSecurity("FINDINGS", [finding]) })
    );
    const allText = JSON.stringify(result);
    // Ensure no raw patterns like "sk_live_..." appear
    expect(allText).not.toMatch(/sk_live_[a-z0-9]/i);
    expect(allText).not.toMatch(/ghp_[A-Za-z0-9_]{30}/);
  });

  it("MEDIUM and CRITICAL together → STOP_SAFELY with MEDIUM only in warnings", () => {
    const findings = [
      makeSecurityFinding("CRITICAL", "SEC-001"),
      makeSecurityFinding("MEDIUM", "SEC-002"),
    ];
    const result = runSafetyGate(
      makeFullInput({ security: makeSecurity("FINDINGS", findings) })
    );
    expect(result.decision).toBe("STOP_SAFELY");
    // MEDIUM should be in warnings
    expect(result.warnings.some((w) => w.code === "SECURITY_MEDIUM_FINDING")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ============================================================
// SG-005 — Evidence Consistency
// ============================================================
// ---------------------------------------------------------------------------

describe("SG-005 — Evidence Consistency", () => {
  it("all workspaceIds match → PASS", () => {
    const result = evaluateEvidenceConsistency(
      WS_ID,
      makeValidation("PASSED"),
      makeRecoveryVerification("NOT_REQUIRED"),
      makeUnexpectedChanges("CLEAN"),
      makeSecurity("CLEAN"),
    );
    expect(result.id).toBe("SG-005");
    expect(result.status).toBe("PASS");
  });

  it("validation workspaceId mismatch → FAIL (blocking)", () => {
    const result = evaluateEvidenceConsistency(
      WS_ID,
      makeValidation("PASSED", "ws_different"),
      makeRecoveryVerification("NOT_REQUIRED"),
      makeUnexpectedChanges("CLEAN"),
      makeSecurity("CLEAN"),
    );
    expect(result.status).toBe("FAIL");
    expect(result.blocking).toBe(true);
    expect(result.evidence.join("\n")).toContain("ws_different");
  });

  it("unexpectedChanges workspaceId mismatch → FAIL", () => {
    const result = evaluateEvidenceConsistency(
      WS_ID,
      makeValidation("PASSED"),
      makeRecoveryVerification("NOT_REQUIRED"),
      makeUnexpectedChanges("CLEAN", "ws_other"),
      makeSecurity("CLEAN"),
    );
    expect(result.status).toBe("FAIL");
  });

  it("security workspaceId mismatch → FAIL", () => {
    const result = evaluateEvidenceConsistency(
      WS_ID,
      makeValidation("PASSED"),
      makeRecoveryVerification("NOT_REQUIRED"),
      makeUnexpectedChanges("CLEAN"),
      makeSecurity("CLEAN", [], "ws_security_mismatch"),
    );
    expect(result.status).toBe("FAIL");
  });

  it("workspaceId mismatch → runSafetyGate returns STOP_SAFELY", () => {
    const result = runSafetyGate({
      workspaceId: WS_ID,
      validation: makeValidation("PASSED", "ws_different"),
      recoveryVerification: makeRecoveryVerification("NOT_REQUIRED"),
      unexpectedChanges: makeUnexpectedChanges("CLEAN"),
      security: makeSecurity("CLEAN"),
    });
    expect(result.decision).toBe("STOP_SAFELY");
    expect(result.blockingReasons.some((r) => r.code === "EVIDENCE_CONFLICT")).toBe(true);
  });

  it("NOT_REQUIRED with validation FAILED → contradiction → FAIL", () => {
    const result = evaluateEvidenceConsistency(
      WS_ID,
      makeValidation("FAILED"),
      makeRecoveryVerification("NOT_REQUIRED", "NOT_NEEDED"),
      makeUnexpectedChanges("CLEAN"),
      makeSecurity("CLEAN"),
    );
    // NOT_REQUIRED + FAILED validation is contradictory
    expect(result.status).toBe("FAIL");
  });

  it("VERIFIED with finalValidation FAILED → contradiction → FAIL", () => {
    const rv: RecoveryVerificationResult = {
      status: "VERIFIED",
      recoveryStatus: "RECOVERED",
      checks: [{ id: "vc", type: "FINAL_STATUS_CHECK", status: "PASSED", message: "ok" }],
      finalValidation: {
        workspaceId: WS_ID, status: "FAILED",
        checks: [], summary: { total: 0, passed: 0, failed: 0, notApplicable: 0, skipped: 0 },
        startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:01:00.000Z",
      },
      verifiedAttempts: 1, verifiedChanges: 2,
      errors: [], summary: "verified",
    };
    const result = evaluateEvidenceConsistency(
      WS_ID,
      makeValidation("PASSED"),
      rv,
      makeUnexpectedChanges("CLEAN"),
      makeSecurity("CLEAN"),
    );
    expect(result.status).toBe("FAIL");
    expect(result.evidence.join("\n")).toContain("finalValidation");
  });
});

// ---------------------------------------------------------------------------
// ============================================================
// COMBINED DECISION MATRIX
// ============================================================
// ---------------------------------------------------------------------------

describe("runSafetyGate — combined decision matrix", () => {
  it("ALL PASS → SAFE_TO_PROCEED", () => {
    const result = runSafetyGate(makeFullInput());
    expect(result.decision).toBe("SAFE_TO_PROCEED");
    expect(result.blockingReasons).toHaveLength(0);
    expect(result.checks.every((c) => c.status === "PASS")).toBe(true);
  });

  it("validation FAILED (only) → STOP_SAFELY", () => {
    const result = runSafetyGate(makeFullInput({ validation: makeValidation("FAILED") }));
    expect(result.decision).toBe("STOP_SAFELY");
  });

  it("recovery verification FAILED (only) → STOP_SAFELY", () => {
    const result = runSafetyGate(
      makeFullInput({ recoveryVerification: makeRecoveryVerification("FAILED", "FAILED") })
    );
    expect(result.decision).toBe("STOP_SAFELY");
  });

  it("unexpected change (only) → STOP_SAFELY", () => {
    const result = runSafetyGate(
      makeFullInput({ unexpectedChanges: makeUnexpectedChanges("UNEXPECTED_CHANGES") })
    );
    expect(result.decision).toBe("STOP_SAFELY");
  });

  it("CRITICAL security finding (only) → STOP_SAFELY", () => {
    const result = runSafetyGate(
      makeFullInput({ security: makeSecurity("FINDINGS", [makeSecurityFinding("CRITICAL")]) })
    );
    expect(result.decision).toBe("STOP_SAFELY");
  });

  it("HIGH security finding (only) → STOP_SAFELY", () => {
    const result = runSafetyGate(
      makeFullInput({ security: makeSecurity("FINDINGS", [makeSecurityFinding("HIGH")]) })
    );
    expect(result.decision).toBe("STOP_SAFELY");
  });

  it("P15 PARTIAL (only) → STOP_SAFELY", () => {
    const result = runSafetyGate(makeFullInput({ security: makeSecurity("PARTIAL") }));
    expect(result.decision).toBe("STOP_SAFELY");
  });

  it("evidence conflict (only) → STOP_SAFELY", () => {
    const result = runSafetyGate({
      workspaceId: WS_ID,
      validation: makeValidation("PASSED", "ws_mismatch"),
      recoveryVerification: makeRecoveryVerification("NOT_REQUIRED"),
      unexpectedChanges: makeUnexpectedChanges("CLEAN"),
      security: makeSecurity("CLEAN"),
    });
    expect(result.decision).toBe("STOP_SAFELY");
  });

  it("multiple failures → STOP_SAFELY with all blocking reasons preserved", () => {
    const result = runSafetyGate({
      workspaceId: WS_ID,
      validation: makeValidation("FAILED"),
      recoveryVerification: makeRecoveryVerification("FAILED", "FAILED"),
      unexpectedChanges: makeUnexpectedChanges("UNEXPECTED_CHANGES"),
      security: makeSecurity("FINDINGS", [makeSecurityFinding("CRITICAL")]),
    });
    expect(result.decision).toBe("STOP_SAFELY");
    expect(result.blockingReasons.length).toBeGreaterThanOrEqual(4);
    const codes = result.blockingReasons.map((r) => r.code);
    expect(codes).toContain("VALIDATION_FAILED");
    expect(codes).toContain("RECOVERY_NOT_VERIFIED");
    expect(codes).toContain("UNEXPECTED_CHANGE");
  });

  it("validation passes + critical security → STOP_SAFELY", () => {
    const result = runSafetyGate(
      makeFullInput({ security: makeSecurity("FINDINGS", [makeSecurityFinding("CRITICAL")]) })
    );
    const sg001 = result.checks.find((c) => c.id === "SG-001");
    const sg004 = result.checks.find((c) => c.id === "SG-004");
    expect(sg001?.status).toBe("PASS");
    expect(sg004?.status).toBe("FAIL");
    expect(result.decision).toBe("STOP_SAFELY");
  });

  it("validation passes + unexpected change → STOP_SAFELY", () => {
    const result = runSafetyGate(
      makeFullInput({ unexpectedChanges: makeUnexpectedChanges("UNEXPECTED_CHANGES") })
    );
    const sg001 = result.checks.find((c) => c.id === "SG-001");
    expect(sg001?.status).toBe("PASS");
    expect(result.decision).toBe("STOP_SAFELY");
  });

  it("validation passes + recovery not verified → STOP_SAFELY", () => {
    const result = runSafetyGate(
      makeFullInput({ recoveryVerification: makeRecoveryVerification("FAILED", "FAILED") })
    );
    expect(result.decision).toBe("STOP_SAFELY");
  });

  it("validation passes + P15 PARTIAL → STOP_SAFELY", () => {
    const result = runSafetyGate(makeFullInput({ security: makeSecurity("PARTIAL") }));
    expect(result.decision).toBe("STOP_SAFELY");
  });

  it("MEDIUM findings with all other checks passing → SAFE_TO_PROCEED + warnings", () => {
    const result = runSafetyGate(
      makeFullInput({ security: makeSecurity("FINDINGS", [makeSecurityFinding("MEDIUM")]) })
    );
    expect(result.decision).toBe("SAFE_TO_PROCEED");
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.blockingReasons).toHaveLength(0);
  });

  it("recovery VERIFIED with all others passing → SAFE_TO_PROCEED", () => {
    const result = runSafetyGate(
      makeFullInput({ recoveryVerification: makeRecoveryVerification("VERIFIED", "RECOVERED") })
    );
    expect(result.decision).toBe("SAFE_TO_PROCEED");
  });
});

// ---------------------------------------------------------------------------
// ============================================================
// DETERMINISM TESTS
// ============================================================
// ---------------------------------------------------------------------------

describe("runSafetyGate — determinism", () => {
  it("same clean input → identical SAFE_TO_PROCEED result (twice)", () => {
    const input = makeFullInput();
    const r1 = runSafetyGate(input);
    const r2 = runSafetyGate(input);
    expect(r1.decision).toBe(r2.decision);
    expect(r1.checks.length).toBe(r2.checks.length);
    for (let i = 0; i < r1.checks.length; i++) {
      expect(r1.checks[i]!.id).toBe(r2.checks[i]!.id);
      expect(r1.checks[i]!.status).toBe(r2.checks[i]!.status);
    }
    expect(r1.blockingReasons.length).toBe(r2.blockingReasons.length);
    expect(r1.warnings.length).toBe(r2.warnings.length);
  });

  it("same failing input → identical STOP_SAFELY result (twice)", () => {
    const input = makeFullInput({ validation: makeValidation("FAILED") });
    const r1 = runSafetyGate(input);
    const r2 = runSafetyGate(input);
    expect(r1.decision).toBe(r2.decision);
    expect(r1.blockingReasons.map((r) => r.code)).toEqual(
      r2.blockingReasons.map((r) => r.code)
    );
  });

  it("checks always appear in SG-001 … SG-005 order", () => {
    const input = makeFullInput();
    const result = runSafetyGate(input);
    const ids = result.checks.map((c) => c.id);
    expect(ids).toEqual(["SG-001", "SG-002", "SG-003", "SG-004", "SG-005"]);
  });

  it("checks always appear in SG-001 … SG-005 order even with failures", () => {
    const input = makeFullInput({ validation: makeValidation("FAILED") });
    const result = runSafetyGate(input);
    const ids = result.checks.map((c) => c.id);
    expect(ids).toEqual(["SG-001", "SG-002", "SG-003", "SG-004", "SG-005"]);
  });
});

// ---------------------------------------------------------------------------
// ============================================================
// INPUT VALIDATION TESTS
// ============================================================
// ---------------------------------------------------------------------------

describe("runSafetyGate — input validation", () => {
  it("throws on missing required fields", () => {
    expect(() => runSafetyGate({} as SafetyGateInput)).toThrow();
  });

  it("throws on missing workspaceId", () => {
    const input = makeFullInput();
    // @ts-expect-error intentionally invalid
    delete input.workspaceId;
    expect(() => runSafetyGate(input as SafetyGateInput)).toThrow();
  });

  it("throws when validation is missing", () => {
    const input = makeFullInput();
    // @ts-expect-error intentionally invalid
    delete input.validation;
    expect(() => runSafetyGate(input as SafetyGateInput)).toThrow();
  });

  it("throws when security is missing", () => {
    const input = makeFullInput();
    // @ts-expect-error intentionally invalid
    delete input.security;
    expect(() => runSafetyGate(input as SafetyGateInput)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ============================================================
// SUMMARY TESTS
// ============================================================
// ---------------------------------------------------------------------------

describe("runSafetyGate — summary", () => {
  it("summary counts match checks array", () => {
    const result = runSafetyGate(makeFullInput());
    expect(result.summary.totalChecks).toBe(result.checks.length);
    expect(result.summary.passed).toBe(result.checks.filter((c) => c.status === "PASS").length);
    expect(result.summary.failed).toBe(result.checks.filter((c) => c.status === "FAIL").length);
    expect(result.summary.notVerified).toBe(result.checks.filter((c) => c.status === "NOT_VERIFIED").length);
    expect(result.summary.blockingReasonCount).toBe(result.blockingReasons.length);
    expect(result.summary.warningCount).toBe(result.warnings.length);
  });

  it("SAFE_TO_PROCEED has zero blocking reasons", () => {
    const result = runSafetyGate(makeFullInput());
    expect(result.summary.blockingReasonCount).toBe(0);
    expect(result.blockingReasons).toHaveLength(0);
  });

  it("STOP_SAFELY has at least one blocking reason", () => {
    const result = runSafetyGate(makeFullInput({ validation: makeValidation("FAILED") }));
    expect(result.summary.blockingReasonCount).toBeGreaterThan(0);
  });

  it("workspaceId is present in result", () => {
    const result = runSafetyGate(makeFullInput());
    expect(result.workspaceId).toBe(WS_ID);
  });
});

// ---------------------------------------------------------------------------
// ============================================================
// P16 BOUNDARY TESTS
// ============================================================
// ---------------------------------------------------------------------------

describe("P16 boundary — no P17+ functionality", () => {
  it("SafetyGateResult does not have canProceed, approved, rejected fields", () => {
    const result = runSafetyGate(makeFullInput());
    expect(result).not.toHaveProperty("canProceed");
    expect(result).not.toHaveProperty("approved");
    expect(result).not.toHaveProperty("rejected");
    expect(result).not.toHaveProperty("safetyScore");
    expect(result).not.toHaveProperty("confidence");
  });

  it("decision uses only SAFE_TO_PROCEED or STOP_SAFELY vocabulary", () => {
    const clean = runSafetyGate(makeFullInput());
    expect(["SAFE_TO_PROCEED", "STOP_SAFELY"]).toContain(clean.decision);

    const failing = runSafetyGate(makeFullInput({ validation: makeValidation("FAILED") }));
    expect(["SAFE_TO_PROCEED", "STOP_SAFELY"]).toContain(failing.decision);
  });

  it("runSafetyGate is synchronous (returns SafetyGateResult, not Promise)", () => {
    const result = runSafetyGate(makeFullInput());
    // If it returned a Promise, it would have a .then property
    expect(typeof result).toBe("object");
    expect(result).not.toHaveProperty("then");
  });
});

// ---------------------------------------------------------------------------
// ============================================================
// EXPRESS 4→5 PROOF FIXTURES
// ============================================================
// ---------------------------------------------------------------------------

describe("Express 4→5 — end-to-end safety proof", () => {
  // Positive path — all evidence clean
  it("POSITIVE: all evidence clean → SAFE_TO_PROCEED", () => {
    const input: SafetyGateInput = {
      workspaceId: "ws_express4_to_5",
      validation: {
        workspaceId: "ws_express4_to_5",
        status: "PASSED",
        checks: [
          { id: "check-dep", type: "DEPENDENCY", status: "PASSED", durationMs: 800 },
          { id: "check-typecheck", type: "TYPECHECK", status: "PASSED", durationMs: 1200 },
          { id: "check-build", type: "BUILD", status: "PASSED", durationMs: 2000 },
          { id: "check-test", type: "TEST", status: "PASSED", durationMs: 5000 },
        ],
        summary: { total: 4, passed: 4, failed: 0, notApplicable: 0, skipped: 0 },
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:05:00.000Z",
      },
      recoveryVerification: {
        status: "NOT_REQUIRED",
        recoveryStatus: "NOT_NEEDED",
        checks: [{ id: "vc-1", type: "INITIAL_FAILURE_CHECK", status: "PASSED",
                   message: "Initial validation was PASSED — recovery not required" }],
        verifiedAttempts: 0, verifiedChanges: 0,
        errors: [],
        summary: "Recovery was not required",
      },
      unexpectedChanges: {
        workspaceId: "ws_express4_to_5",
        status: "CLEAN",
        actualChanges: [
          { filePath: "src/app.ts", changeType: "MODIFIED" },
          { filePath: "package.json", changeType: "MODIFIED" },
        ],
        expectedChanges: [
          { filePath: "src/app.ts", source: "P9", relatedStepIds: ["STEP-001"] },
          { filePath: "package.json", source: "P9", relatedStepIds: ["STEP-002"] },
        ],
        unexpectedChanges: [],
        summary: { totalActualChanges: 2, totalExpectedChanges: 2, totalUnexpectedChanges: 0, added: 0, modified: 2, deleted: 0, renamed: 0 },
      },
      security: {
        workspaceId: "ws_express4_to_5",
        status: "CLEAN",
        findings: [],
        summary: { totalFindings: 0, critical: 0, high: 0, medium: 0, low: 0, secretsDetected: 0, dependencyFindings: 0, codeFindings: 0, configurationFindings: 0, aiReviewFindings: 0 },
        checks: [
          { id: "secret-scan", name: "Secret Scanner", status: "PASSED", findingCount: 0, durationMs: 50 },
          { id: "dependency-audit", name: "Dependency Audit", status: "PASSED", findingCount: 0, durationMs: 300 },
          { id: "code-analysis", name: "Code Analysis", status: "PASSED", findingCount: 0, durationMs: 20 },
          { id: "bob-security-review", name: "IBM Bob Security Review", status: "PASSED", findingCount: 0, durationMs: 400 },
        ],
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:02:00.000Z",
      },
    };

    const result = runSafetyGate(input);
    expect(result.decision).toBe("SAFE_TO_PROCEED");
    expect(result.blockingReasons).toHaveLength(0);
    expect(result.checks.every((c) => c.status === "PASS")).toBe(true);
  });

  // Negative: P11 FAIL
  it("NEGATIVE: P11 validation failed → STOP_SAFELY", () => {
    const input = makeFullInput({ validation: makeValidation("FAILED") });
    const result = runSafetyGate(input);
    expect(result.decision).toBe("STOP_SAFELY");
    expect(result.checks.find((c) => c.id === "SG-001")?.status).toBe("FAIL");
  });

  // Negative: P13 verification failed
  it("NEGATIVE: P13 recovery verification failed → STOP_SAFELY", () => {
    const input = makeFullInput({
      recoveryVerification: makeRecoveryVerification("FAILED", "FAILED"),
    });
    const result = runSafetyGate(input);
    expect(result.decision).toBe("STOP_SAFELY");
  });

  // Negative: P14 unauthorized change
  it("NEGATIVE: P14 unauthorized change → STOP_SAFELY", () => {
    const input = makeFullInput({
      unexpectedChanges: makeUnexpectedChanges("UNEXPECTED_CHANGES"),
    });
    const result = runSafetyGate(input);
    expect(result.decision).toBe("STOP_SAFELY");
  });

  // Negative: P15 critical security finding
  it("NEGATIVE: P15 critical security finding → STOP_SAFELY", () => {
    const input = makeFullInput({
      security: makeSecurity("FINDINGS", [makeSecurityFinding("CRITICAL", "SEC-001", "SECRET")]),
    });
    const result = runSafetyGate(input);
    expect(result.decision).toBe("STOP_SAFELY");
  });

  // Negative: P15 partial
  it("NEGATIVE: P15 PARTIAL → STOP_SAFELY", () => {
    const input = makeFullInput({ security: makeSecurity("PARTIAL") });
    const result = runSafetyGate(input);
    expect(result.decision).toBe("STOP_SAFELY");
  });

  // Negative: Workspace mismatch
  it("NEGATIVE: workspace ID mismatch → STOP_SAFELY", () => {
    const input: SafetyGateInput = {
      ...makeFullInput(),
      security: makeSecurity("CLEAN", [], "ws_completely_different"),
    };
    const result = runSafetyGate(input);
    expect(result.decision).toBe("STOP_SAFELY");
  });
});

// ---------------------------------------------------------------------------
// ============================================================
// DEDUPLICATION TESTS
// ============================================================
// ---------------------------------------------------------------------------

describe("runSafetyGate — deduplication of blocking reasons", () => {
  it("same issue appearing from multiple angles does not create duplicate reasons", () => {
    // SG-004 generates one "SECURITY_FINDING_BLOCKING" reason at check level
    // and individual reasons per finding.
    const findings = [
      makeSecurityFinding("CRITICAL", "SEC-001"),
      makeSecurityFinding("HIGH", "SEC-002"),
    ];
    const result = runSafetyGate(
      makeFullInput({ security: makeSecurity("FINDINGS", findings) })
    );

    // Should not have duplicate SECURITY_FINDING_BLOCKING codes
    const blockingCodes = result.blockingReasons.map((r) => r.code);
    const unique = new Set(blockingCodes);
    expect(blockingCodes.length).toBe(unique.size);
  });
});
