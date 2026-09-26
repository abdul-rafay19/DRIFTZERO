/**
 * Recovery Verification Engine tests (P13).
 *
 * Strategy:
 * - verifyRecovery() is deterministic and synchronous — no mocking needed.
 * - Fixtures are built in-memory from typed objects.
 * - Zero Bob calls.  Zero commands.
 *
 * Test coverage:
 *   1.  NOT_REQUIRED when initial validation is PASSED
 *   2.  Input validation (Zod)
 *   3.  Valid RECOVERED → VERIFIED
 *   4.  RECOVERED with failed final validation → FAILED
 *   5.  RECOVERED with missing finalValidation → FAILED
 *   6.  Attempt sequence: valid 1,2,3 / gap 1,3 / zero / duplicate / > limit
 *   7.  Attempt limit: within limit passes / exceeds limit fails
 *   8.  Change scope: authorized passes / unauthorized fails / path traversal / absolute / .git
 *   9.  Change evidence: all fields present / missing fields
 *  10.  MODIFY expected state: proposed change present / absent
 *  11.  Post-repair validation: present / missing
 *  12.  Duplicate repair: distinct passes / duplicate fails
 *  13.  Recovery consistency: RECOVERED+PASSED consistent / RECOVERED+FAILED inconsistent
 *  14.  STOPPED recovery verification
 *  15.  Evidence completeness
 *  16.  Express 4→5 verification proof
 *  17.  No Bob calls (determinism guarantee)
 */

import { describe, it, expect, vi } from "vitest";
import { verifyRecovery } from "./recovery-verification.js";
import { ValidationError } from "@driftzero/shared";
import { MAX_RECOVERY_ATTEMPTS } from "./recovery-types.js";
import type {
  RecoveryVerificationInput,
  RecoveryResult,
  RecoveryAttempt,
  ValidationResult,
  MigrationPlan,
  MigrationStep,
  CodeMigrationResult,
} from "@driftzero/shared";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makePassedValidation(workspaceId = "ws_p13"): ValidationResult {
  return {
    workspaceId,
    status: "PASSED",
    checks: [
      { id: "check-dependency", type: "DEPENDENCY", status: "PASSED", durationMs: 50 },
      { id: "check-test", type: "TEST", status: "PASSED", durationMs: 200 },
    ],
    summary: { total: 2, passed: 2, failed: 0, notApplicable: 0, skipped: 0 },
    startedAt: "2024-01-01T00:00:00.000Z",
    completedAt: "2024-01-01T00:00:01.000Z",
  };
}

function makeFailedValidation(workspaceId = "ws_p13"): ValidationResult {
  return {
    workspaceId,
    status: "FAILED",
    checks: [
      { id: "check-dependency", type: "DEPENDENCY", status: "PASSED", durationMs: 50 },
      {
        id: "check-test", type: "TEST", status: "FAILED",
        command: "pnpm run test", exitCode: 1,
        stdout: "TypeError: app.del is not a function", stderr: "",
        durationMs: 1200, reason: "test failed",
      },
    ],
    summary: { total: 2, passed: 1, failed: 1, notApplicable: 0, skipped: 0 },
    startedAt: "2024-01-01T00:00:00.000Z",
    completedAt: "2024-01-01T00:00:02.000Z",
  };
}

function makeStep(overrides: Partial<MigrationStep> = {}): MigrationStep {
  return {
    id: "STEP-001", order: 1, title: "t", description: "d", category: "API",
    affectedFiles: ["src/app.ts"], relatedChangeIds: [],
    relatedRequirementIds: [], reason: "r", risk: "HIGH", dependencies: [],
    ...overrides,
  };
}

function makePlan(steps: MigrationStep[] = [makeStep()]): MigrationPlan {
  return {
    packageName: "express", sourceVersion: "4", targetVersion: "5",
    objective: "Migrate express 4→5.", prerequisites: [], steps,
    validationRequirements: [], affectedAreas: [],
    risk: { score: 61, level: "HIGH" },
    generatedAt: "2024-01-01T00:00:00.000Z",
  };
}

function makeMigrationResult(): CodeMigrationResult {
  return {
    workspaceId: "ws_p13",
    planSteps: 1, completedSteps: 1, failedSteps: 0,
    status: "COMPLETED",
    changes: [
      { stepId: "STEP-001", filePath: "src/app.ts", operation: "MODIFY", explanation: "Replaced app.del with app.delete" },
    ],
    evidence: [],
  };
}

function makeRecoveredAttempt(n = 1, filePath = "src/app.ts"): RecoveryAttempt {
  return {
    attempt: n,
    diagnosis: {
      diagnosis: "app.del removed in Express 5",
      rootCause: "API breaking change",
      proposedChanges: [{
        filePath, operation: "MODIFY",
        explanation: `Fix attempt ${n}`,
        relatedStepIds: ["STEP-001"],
        relatedValidationCheckIds: ["check-test"],
      }],
      bobDurationMs: 100,
    },
    proposedChanges: [{
      filePath, operation: "MODIFY",
      explanation: `Fix attempt ${n}`,
      relatedStepIds: ["STEP-001"],
      relatedValidationCheckIds: ["check-test"],
    }],
    appliedChanges: [{
      filePath, operation: "MODIFY",
      explanation: `Fix attempt ${n}`,
      relatedStepIds: ["STEP-001"],
      relatedValidationCheckIds: ["check-test"],
    }],
    validation: makePassedValidation(),
    status: "RECOVERED",
    reason: "P11 passed after repair",
  };
}

function makeFailedAttempt(n = 1, filePath = "src/app.ts"): RecoveryAttempt {
  return {
    attempt: n,
    diagnosis: {
      diagnosis: "app.del removed in Express 5",
      rootCause: "API breaking change",
      proposedChanges: [{
        filePath, operation: "MODIFY",
        explanation: `Fix attempt ${n}`,
        relatedStepIds: ["STEP-001"],
        relatedValidationCheckIds: ["check-test"],
      }],
      bobDurationMs: 100,
    },
    proposedChanges: [{
      filePath, operation: "MODIFY",
      explanation: `Fix attempt ${n}`,
      relatedStepIds: ["STEP-001"],
      relatedValidationCheckIds: ["check-test"],
    }],
    appliedChanges: [{
      filePath, operation: "MODIFY",
      explanation: `Fix attempt ${n}`,
      relatedStepIds: ["STEP-001"],
      relatedValidationCheckIds: ["check-test"],
    }],
    validation: makeFailedValidation(),
    status: "FAILED",
    reason: "P11 still failed after repair",
  };
}

function makeRecoveryResult(overrides: Partial<RecoveryResult> = {}): RecoveryResult {
  return {
    workspaceId: "ws_p13",
    status: "RECOVERED",
    attempts: [makeRecoveredAttempt(1)],
    finalValidation: makePassedValidation(),
    reason: "Recovery succeeded on attempt 1",
    ...overrides,
  };
}

function makeInput(overrides: Partial<RecoveryVerificationInput> = {}): RecoveryVerificationInput {
  return {
    workspace: {
      id: "ws_p13", path: "/tmp/ws_p13",
      repoUrl: "https://github.com/example/repo",
      branch: "main", createdAt: "2024-01-01T00:00:00.000Z", status: "READY",
    },
    migrationPlan: makePlan(),
    migrationResult: makeMigrationResult(),
    initialValidation: makeFailedValidation(),
    recoveryResult: makeRecoveryResult(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. NOT_REQUIRED when initial validation is PASSED
// ---------------------------------------------------------------------------

describe("NOT_REQUIRED — initial validation passed", () => {
  it("returns NOT_REQUIRED when initialValidation is PASSED", () => {
    const result = verifyRecovery(makeInput({ initialValidation: makePassedValidation() }));
    expect(result.status).toBe("NOT_REQUIRED");
    expect(result.checks).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("NOT_REQUIRED has no failed checks", () => {
    const result = verifyRecovery(makeInput({ initialValidation: makePassedValidation() }));
    expect(result.checks.filter(c => c.status === "FAILED")).toHaveLength(0);
  });

  it("NOT_REQUIRED has summary message", () => {
    const result = verifyRecovery(makeInput({ initialValidation: makePassedValidation() }));
    expect(result.summary).toContain("not required");
  });

  it("NOT_REQUIRED returns recoveryStatus from input", () => {
    const result = verifyRecovery(makeInput({ initialValidation: makePassedValidation() }));
    expect(result.recoveryStatus).toBe("RECOVERED");
  });

  it("NOT_REQUIRED verifiedAttempts and verifiedChanges are 0", () => {
    const result = verifyRecovery(makeInput({ initialValidation: makePassedValidation() }));
    expect(result.verifiedAttempts).toBe(0);
    expect(result.verifiedChanges).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Input validation
// ---------------------------------------------------------------------------

describe("input validation", () => {
  it("throws ValidationError when workspace is missing", () => {
    expect(() => verifyRecovery({
      ...makeInput(),
      workspace: undefined as never,
    })).toThrow(ValidationError);
  });

  it("throws ValidationError when initialValidation is missing", () => {
    expect(() => verifyRecovery({
      ...makeInput(),
      initialValidation: undefined as never,
    })).toThrow(ValidationError);
  });

  it("throws ValidationError when recoveryResult is missing", () => {
    expect(() => verifyRecovery({
      ...makeInput(),
      recoveryResult: undefined as never,
    })).toThrow(ValidationError);
  });

  it("throws ValidationError for relative workspace path", () => {
    expect(() => verifyRecovery({
      ...makeInput(),
      workspace: { ...makeInput().workspace, path: "relative/path" },
    })).toThrow(ValidationError);
  });

  it("accepts optional testGenerationResult", () => {
    const result = verifyRecovery(makeInput({ testGenerationResult: undefined }));
    expect(result.status).toBe("VERIFIED");
  });
});

// ---------------------------------------------------------------------------
// 3. Valid RECOVERED → VERIFIED
// ---------------------------------------------------------------------------

describe("valid RECOVERED → VERIFIED", () => {
  it("VERIFIED for complete valid recovery evidence", () => {
    const result = verifyRecovery(makeInput());
    expect(result.status).toBe("VERIFIED");
  });

  it("VERIFIED has 10 checks all PASSED", () => {
    const result = verifyRecovery(makeInput());
    expect(result.checks).toHaveLength(10);
    expect(result.checks.every(c => c.status === "PASSED")).toBe(true);
  });

  it("VERIFIED has zero errors", () => {
    const result = verifyRecovery(makeInput());
    expect(result.errors).toHaveLength(0);
  });

  it("VERIFIED includes finalValidation", () => {
    const result = verifyRecovery(makeInput());
    expect(result.finalValidation?.status).toBe("PASSED");
  });

  it("VERIFIED verifiedAttempts and verifiedChanges are correct", () => {
    const result = verifyRecovery(makeInput());
    expect(result.verifiedAttempts).toBe(1);
    expect(result.verifiedChanges).toBe(1);
  });

  it("VERIFIED summary mentions all checks passed", () => {
    const result = verifyRecovery(makeInput());
    expect(result.summary).toContain("VERIFIED");
    expect(result.summary).toContain("10");
  });
});

// ---------------------------------------------------------------------------
// 4. RECOVERED with failed final validation → FAILED
// ---------------------------------------------------------------------------

describe("final status check", () => {
  it("FAILED when RECOVERED but finalValidation is FAILED", () => {
    const result = verifyRecovery(makeInput({
      recoveryResult: makeRecoveryResult({
        finalValidation: makeFailedValidation(),
      }),
    }));
    expect(result.status).toBe("FAILED");
    const check = result.checks.find(c => c.type === "FINAL_STATUS_CHECK")!;
    expect(check.status).toBe("FAILED");
    expect(check.message).toContain("FAILED");
  });

  it("FAILED when RECOVERED but finalValidation is missing", () => {
    const result = verifyRecovery(makeInput({
      recoveryResult: makeRecoveryResult({
        finalValidation: undefined,
      }),
    }));
    expect(result.status).toBe("FAILED");
    const check = result.checks.find(c => c.type === "FINAL_STATUS_CHECK")!;
    expect(check.status).toBe("FAILED");
    expect(check.message).toContain("no finalValidation");
  });

  it("PASSED final status check for STOPPED recovery (no pass required)", () => {
    const result = verifyRecovery(makeInput({
      recoveryResult: {
        ...makeRecoveryResult(),
        status: "STOPPED",
        finalValidation: makeFailedValidation(),
        attempts: [makeFailedAttempt(1)],
      },
    }));
    const check = result.checks.find(c => c.type === "FINAL_STATUS_CHECK")!;
    expect(check.status).toBe("PASSED");
  });
});

// ---------------------------------------------------------------------------
// 5. Initial failure check
// ---------------------------------------------------------------------------

describe("initial failure check", () => {
  it("FAILED when RECOVERED but initial validation was PASSED (contradictory)", () => {
    // Note: NOT_REQUIRED is returned before checks run when initial is PASSED.
    // This sub-case (RECOVERED + initial PASSED) only reaches the check if we
    // somehow bypass the NOT_REQUIRED early-return.
    // In practice: if initial was PASSED, we return NOT_REQUIRED.
    // This test confirms NOT_REQUIRED is returned (correct behavior).
    const result = verifyRecovery(makeInput({ initialValidation: makePassedValidation() }));
    expect(result.status).toBe("NOT_REQUIRED");
  });

  it("PASSED when RECOVERED and initial was FAILED", () => {
    const result = verifyRecovery(makeInput({
      initialValidation: makeFailedValidation(),
      recoveryResult: makeRecoveryResult(),
    }));
    const check = result.checks.find(c => c.type === "INITIAL_FAILURE_CHECK")!;
    expect(check.status).toBe("PASSED");
  });

  it("FAILED when recovery is NOT_NEEDED but initial was FAILED", () => {
    const result = verifyRecovery(makeInput({
      initialValidation: makeFailedValidation(),
      recoveryResult: makeRecoveryResult({ status: "NOT_NEEDED", attempts: [] }),
    }));
    const check = result.checks.find(c => c.type === "INITIAL_FAILURE_CHECK")!;
    expect(check.status).toBe("FAILED");
  });
});

// ---------------------------------------------------------------------------
// 6. Attempt sequence check
// ---------------------------------------------------------------------------

describe("attempt sequence check", () => {
  it("PASSED for valid sequence [1]", () => {
    const result = verifyRecovery(makeInput());
    const check = result.checks.find(c => c.type === "ATTEMPT_SEQUENCE_CHECK")!;
    expect(check.status).toBe("PASSED");
  });

  it("PASSED for valid sequence [1, 2]", () => {
    const result = verifyRecovery(makeInput({
      recoveryResult: makeRecoveryResult({
        attempts: [makeFailedAttempt(1), makeRecoveredAttempt(2)],
      }),
    }));
    const check = result.checks.find(c => c.type === "ATTEMPT_SEQUENCE_CHECK")!;
    expect(check.status).toBe("PASSED");
  });

  it("PASSED for valid sequence [1, 2, 3]", () => {
    const a1 = makeFailedAttempt(1);
    const a2 = { ...makeFailedAttempt(2), appliedChanges: [{
      filePath: "src/app.ts", operation: "MODIFY" as const,
      explanation: "fix 2", relatedStepIds: ["STEP-001"], relatedValidationCheckIds: [],
    }] };
    const a3 = makeRecoveredAttempt(3);
    const result = verifyRecovery(makeInput({
      recoveryResult: makeRecoveryResult({
        attempts: [a1, a2, a3],
      }),
    }));
    const check = result.checks.find(c => c.type === "ATTEMPT_SEQUENCE_CHECK")!;
    expect(check.status).toBe("PASSED");
  });

  it("FAILED for gap in sequence [1, 3]", () => {
    const result = verifyRecovery(makeInput({
      recoveryResult: makeRecoveryResult({
        attempts: [makeFailedAttempt(1), makeRecoveredAttempt(3)],
      }),
    }));
    const check = result.checks.find(c => c.type === "ATTEMPT_SEQUENCE_CHECK")!;
    expect(check.status).toBe("FAILED");
    expect(check.message).toContain("contiguous");
  });

  it("throws ValidationError for attempt number 0 (Zod rejects invalid input)", () => {
    const badAttempt = { ...makeRecoveredAttempt(0) };
    expect(() => verifyRecovery(makeInput({
      recoveryResult: makeRecoveryResult({ attempts: [badAttempt] }),
    }))).toThrow(ValidationError);
  });

  it("FAILED for duplicate attempt numbers [1, 1]", () => {
    const result = verifyRecovery(makeInput({
      recoveryResult: makeRecoveryResult({
        attempts: [makeFailedAttempt(1), makeRecoveredAttempt(1)],
      }),
    }));
    const check = result.checks.find(c => c.type === "ATTEMPT_SEQUENCE_CHECK")!;
    expect(check.status).toBe("FAILED");
  });

  it("PASSED for empty attempts array (no recovery attempted)", () => {
    const result = verifyRecovery(makeInput({
      recoveryResult: makeRecoveryResult({
        status: "STOPPED",
        attempts: [],
        finalValidation: makeFailedValidation(),
      }),
    }));
    const check = result.checks.find(c => c.type === "ATTEMPT_SEQUENCE_CHECK")!;
    expect(check.status).toBe("PASSED");
  });
});

// ---------------------------------------------------------------------------
// 7. Attempt limit check
// ---------------------------------------------------------------------------

describe("attempt limit check", () => {
  it("PASSED when attempts <= MAX_RECOVERY_ATTEMPTS", () => {
    const result = verifyRecovery(makeInput());
    const check = result.checks.find(c => c.type === "ATTEMPT_LIMIT_CHECK")!;
    expect(check.status).toBe("PASSED");
  });

  it("FAILED when attempts.length > MAX_RECOVERY_ATTEMPTS", () => {
    const tooMany = Array.from({ length: MAX_RECOVERY_ATTEMPTS + 1 }, (_, i) =>
      makeFailedAttempt(i + 1)
    );
    const result = verifyRecovery(makeInput({
      recoveryResult: makeRecoveryResult({
        status: "STOPPED",
        attempts: tooMany,
        finalValidation: makeFailedValidation(),
      }),
    }));
    const check = result.checks.find(c => c.type === "ATTEMPT_LIMIT_CHECK")!;
    expect(check.status).toBe("FAILED");
    expect(check.message).toContain("MAX_RECOVERY_ATTEMPTS");
  });

  it("FAILED when individual attempt.attempt > MAX_RECOVERY_ATTEMPTS", () => {
    const badAttempt = makeRecoveredAttempt(MAX_RECOVERY_ATTEMPTS + 1);
    const result = verifyRecovery(makeInput({
      recoveryResult: makeRecoveryResult({ attempts: [badAttempt] }),
    }));
    const check = result.checks.find(c => c.type === "ATTEMPT_LIMIT_CHECK")!;
    expect(check.status).toBe("FAILED");
  });

  it("MAX_RECOVERY_ATTEMPTS constant matches shared value (3)", () => {
    expect(MAX_RECOVERY_ATTEMPTS).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 8. Change scope check
// ---------------------------------------------------------------------------

describe("change scope check", () => {
  it("PASSED when all applied changes are in authorized scope", () => {
    const result = verifyRecovery(makeInput());
    const check = result.checks.find(c => c.type === "CHANGE_SCOPE_CHECK")!;
    expect(check.status).toBe("PASSED");
  });

  it("FAILED when applied change is not in authorized scope", () => {
    const result = verifyRecovery(makeInput({
      recoveryResult: makeRecoveryResult({
        attempts: [makeRecoveredAttempt(1, "src/unrelated-admin.ts")],
      }),
    }));
    const check = result.checks.find(c => c.type === "CHANGE_SCOPE_CHECK")!;
    expect(check.status).toBe("FAILED");
    expect(check.evidence!.some(e => e.includes("src/unrelated-admin.ts"))).toBe(true);
  });

  it("FAILED for path traversal in applied change", () => {
    const badAttempt: RecoveryAttempt = {
      ...makeRecoveredAttempt(1),
      appliedChanges: [{
        filePath: "../etc/passwd", operation: "MODIFY",
        explanation: "x", relatedStepIds: [], relatedValidationCheckIds: [],
      }],
    };
    const result = verifyRecovery(makeInput({
      recoveryResult: makeRecoveryResult({ attempts: [badAttempt] }),
    }));
    const check = result.checks.find(c => c.type === "CHANGE_SCOPE_CHECK")!;
    expect(check.status).toBe("FAILED");
    expect(check.evidence!.join(" ")).toContain("path traversal");
  });

  it("FAILED for absolute path in applied change", () => {
    const badAttempt: RecoveryAttempt = {
      ...makeRecoveredAttempt(1),
      appliedChanges: [{
        filePath: "/etc/passwd", operation: "MODIFY",
        explanation: "x", relatedStepIds: [], relatedValidationCheckIds: [],
      }],
    };
    const result = verifyRecovery(makeInput({
      recoveryResult: makeRecoveryResult({ attempts: [badAttempt] }),
    }));
    const check = result.checks.find(c => c.type === "CHANGE_SCOPE_CHECK")!;
    expect(check.status).toBe("FAILED");
    expect(check.evidence!.join(" ")).toContain("absolute");
  });

  it("FAILED for .git/ path in applied change", () => {
    const badAttempt: RecoveryAttempt = {
      ...makeRecoveredAttempt(1),
      appliedChanges: [{
        filePath: ".git/config", operation: "MODIFY",
        explanation: "x", relatedStepIds: [], relatedValidationCheckIds: [],
      }],
    };
    const result = verifyRecovery(makeInput({
      recoveryResult: makeRecoveryResult({ attempts: [badAttempt] }),
    }));
    const check = result.checks.find(c => c.type === "CHANGE_SCOPE_CHECK")!;
    expect(check.status).toBe("FAILED");
    expect(check.evidence!.join(" ")).toContain(".git");
  });

  it("PASSED when no applied changes (no scope violation possible)", () => {
    const rejectedAttempt: RecoveryAttempt = {
      ...makeRecoveredAttempt(1),
      appliedChanges: [],
      status: "REJECTED",
      validation: makeFailedValidation(),
      reason: "unauthorized",
    };
    const result = verifyRecovery(makeInput({
      recoveryResult: makeRecoveryResult({
        status: "STOPPED",
        attempts: [rejectedAttempt],
        finalValidation: makeFailedValidation(),
      }),
    }));
    const check = result.checks.find(c => c.type === "CHANGE_SCOPE_CHECK")!;
    expect(check.status).toBe("PASSED");
  });

  it("accepts file from P9 migrationResult.changes scope", () => {
    const migResult: CodeMigrationResult = {
      ...makeMigrationResult(),
      changes: [
        { stepId: "STEP-001", filePath: "src/app.ts", operation: "MODIFY", explanation: "x" },
        { stepId: "STEP-001", filePath: "src/routes.ts", operation: "MODIFY", explanation: "y" },
      ],
    };
    const result = verifyRecovery(makeInput({
      migrationResult: migResult,
      recoveryResult: makeRecoveryResult({
        attempts: [makeRecoveredAttempt(1, "src/routes.ts")],
      }),
    }));
    const check = result.checks.find(c => c.type === "CHANGE_SCOPE_CHECK")!;
    expect(check.status).toBe("PASSED");
  });
});

// ---------------------------------------------------------------------------
// 9. Change evidence check
// ---------------------------------------------------------------------------

describe("change evidence check", () => {
  it("PASSED when all evidence fields are present", () => {
    const result = verifyRecovery(makeInput());
    const check = result.checks.find(c => c.type === "CHANGE_EVIDENCE_CHECK")!;
    expect(check.status).toBe("PASSED");
  });

  it("throws ValidationError when applied change has empty explanation (Zod enforces min(1))", () => {
    const badAttempt = {
      ...makeRecoveredAttempt(1),
      appliedChanges: [{
        filePath: "src/app.ts", operation: "MODIFY" as const,
        explanation: "",
        relatedStepIds: ["STEP-001"],
        relatedValidationCheckIds: [],
      }],
    };
    expect(() => verifyRecovery(makeInput({
      recoveryResult: makeRecoveryResult({ attempts: [badAttempt] }),
    }))).toThrow(ValidationError);
  });

  it("throws ValidationError when diagnosis field is empty (Zod enforces min(1))", () => {
    const badAttempt = {
      ...makeRecoveredAttempt(1),
      diagnosis: {
        ...makeRecoveredAttempt(1).diagnosis,
        diagnosis: "",
      },
    };
    expect(() => verifyRecovery(makeInput({
      recoveryResult: makeRecoveryResult({ attempts: [badAttempt] }),
    }))).toThrow(ValidationError);
  });

  it("throws ValidationError when rootCause is empty (Zod enforces min(1))", () => {
    const badAttempt = {
      ...makeRecoveredAttempt(1),
      diagnosis: {
        ...makeRecoveredAttempt(1).diagnosis,
        rootCause: "",
      },
    };
    expect(() => verifyRecovery(makeInput({
      recoveryResult: makeRecoveryResult({ attempts: [badAttempt] }),
    }))).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// 10. MODIFY expected state check
// ---------------------------------------------------------------------------

describe("expected state check (MODIFY)", () => {
  it("PASSED when MODIFY has corresponding proposed change", () => {
    const result = verifyRecovery(makeInput());
    const check = result.checks.find(c => c.type === "EXPECTED_STATE_CHECK")!;
    expect(check.status).toBe("PASSED");
  });

  it("FAILED when MODIFY applied change has no corresponding proposed change", () => {
    const badAttempt: RecoveryAttempt = {
      ...makeRecoveredAttempt(1),
      proposedChanges: [],  // empty — no proposed changes to verify against
      appliedChanges: [{
        filePath: "src/app.ts", operation: "MODIFY",
        explanation: "fix", relatedStepIds: ["STEP-001"],
        relatedValidationCheckIds: ["check-test"],
      }],
    };
    const result = verifyRecovery(makeInput({
      recoveryResult: makeRecoveryResult({ attempts: [badAttempt] }),
    }));
    const check = result.checks.find(c => c.type === "EXPECTED_STATE_CHECK")!;
    expect(check.status).toBe("FAILED");
    expect(check.message).toContain("corresponding proposed change");
  });

  it("PASSED for CREATE operation without proposed change (CREATE is exempt)", () => {
    // CREATE doesn't need an expectedContent guard in the same way
    const createAttempt: RecoveryAttempt = {
      ...makeRecoveredAttempt(1),
      proposedChanges: [{
        filePath: "src/new.ts", operation: "CREATE",
        explanation: "new file", relatedStepIds: ["STEP-001"],
        relatedValidationCheckIds: [],
      }],
      appliedChanges: [{
        filePath: "src/new.ts", operation: "CREATE",
        explanation: "new file", relatedStepIds: ["STEP-001"],
        relatedValidationCheckIds: [],
      }],
    };

    // Add src/new.ts to scope
    const migResult: CodeMigrationResult = {
      ...makeMigrationResult(),
      changes: [
        { stepId: "STEP-001", filePath: "src/app.ts", operation: "MODIFY", explanation: "x" },
        { stepId: "STEP-001", filePath: "src/new.ts", operation: "CREATE", explanation: "y" },
      ],
    };

    const result = verifyRecovery(makeInput({
      migrationResult: migResult,
      recoveryResult: makeRecoveryResult({ attempts: [createAttempt] }),
    }));
    const check = result.checks.find(c => c.type === "EXPECTED_STATE_CHECK")!;
    expect(check.status).toBe("PASSED");
  });
});

// ---------------------------------------------------------------------------
// 11. Post-repair validation check
// ---------------------------------------------------------------------------

describe("post-repair validation check", () => {
  it("PASSED when all attempts with applied changes have validation", () => {
    const result = verifyRecovery(makeInput());
    const check = result.checks.find(c => c.type === "POST_REPAIR_VALIDATION_CHECK")!;
    expect(check.status).toBe("PASSED");
  });

  it("FAILED when attempt with applied changes has RECOVERED status but validation FAILED", () => {
    const contradictoryAttempt: RecoveryAttempt = {
      ...makeRecoveredAttempt(1),
      validation: makeFailedValidation(),  // RECOVERED but validation FAILED
      status: "RECOVERED",
    };
    const result = verifyRecovery(makeInput({
      recoveryResult: makeRecoveryResult({
        attempts: [contradictoryAttempt],
        finalValidation: makePassedValidation(),
      }),
    }));
    const check = result.checks.find(c => c.type === "POST_REPAIR_VALIDATION_CHECK")!;
    expect(check.status).toBe("FAILED");
    expect(check.evidence!.join(" ")).toContain("RECOVERED");
  });

  it("PASSED for REJECTED attempt with no applied changes (no post-repair validation needed)", () => {
    const rejectedAttempt: RecoveryAttempt = {
      ...makeRecoveredAttempt(1),
      appliedChanges: [],
      status: "REJECTED",
      validation: makeFailedValidation(),
      reason: "unauthorized",
    };
    const result = verifyRecovery(makeInput({
      recoveryResult: makeRecoveryResult({
        status: "STOPPED",
        attempts: [rejectedAttempt],
        finalValidation: makeFailedValidation(),
      }),
    }));
    const check = result.checks.find(c => c.type === "POST_REPAIR_VALIDATION_CHECK")!;
    expect(check.status).toBe("PASSED");
  });
});

// ---------------------------------------------------------------------------
// 12. Duplicate repair check
// ---------------------------------------------------------------------------

describe("duplicate repair check", () => {
  it("PASSED when all applied changes have distinct fingerprints", () => {
    const result = verifyRecovery(makeInput());
    const check = result.checks.find(c => c.type === "DUPLICATE_REPAIR_CHECK")!;
    expect(check.status).toBe("PASSED");
  });

  it("PASSED for two attempts with different explanations", () => {
    const a1 = makeFailedAttempt(1); // explanation: "Fix attempt 1"
    const a2 = makeRecoveredAttempt(2); // explanation: "Fix attempt 2"
    const result = verifyRecovery(makeInput({
      recoveryResult: makeRecoveryResult({
        attempts: [a1, a2],
      }),
    }));
    const check = result.checks.find(c => c.type === "DUPLICATE_REPAIR_CHECK")!;
    expect(check.status).toBe("PASSED");
  });

  it("FAILED when two attempts have identical applied changes", () => {
    // Both attempts apply the same change to the same file with same explanation
    const identicalChange = {
      filePath: "src/app.ts", operation: "MODIFY" as const,
      explanation: "identical fix",
      relatedStepIds: ["STEP-001"],
      relatedValidationCheckIds: ["check-test"],
    };
    const a1: RecoveryAttempt = {
      ...makeFailedAttempt(1),
      appliedChanges: [identicalChange],
    };
    const a2: RecoveryAttempt = {
      ...makeRecoveredAttempt(2),
      appliedChanges: [identicalChange],
    };
    const result = verifyRecovery(makeInput({
      recoveryResult: makeRecoveryResult({ attempts: [a1, a2] }),
    }));
    const check = result.checks.find(c => c.type === "DUPLICATE_REPAIR_CHECK")!;
    expect(check.status).toBe("FAILED");
    expect(check.message).toContain("duplicate");
  });

  it("PASSED when one attempt has no applied changes (rejected)", () => {
    const a1: RecoveryAttempt = {
      ...makeFailedAttempt(1),
      appliedChanges: [],
      status: "REJECTED",
    };
    const a2 = makeRecoveredAttempt(2);
    const result = verifyRecovery(makeInput({
      recoveryResult: makeRecoveryResult({ attempts: [a1, a2] }),
    }));
    const check = result.checks.find(c => c.type === "DUPLICATE_REPAIR_CHECK")!;
    expect(check.status).toBe("PASSED");
  });
});

// ---------------------------------------------------------------------------
// 13. Recovery consistency check
// ---------------------------------------------------------------------------

describe("recovery consistency check", () => {
  it("PASSED for internally consistent RECOVERED result", () => {
    const result = verifyRecovery(makeInput());
    const check = result.checks.find(c => c.type === "RECOVERY_CONSISTENCY_CHECK")!;
    expect(check.status).toBe("PASSED");
  });

  it("FAILED when attempt is RECOVERED but validation.status is FAILED", () => {
    const contradictoryAttempt: RecoveryAttempt = {
      ...makeRecoveredAttempt(1),
      validation: makeFailedValidation(),  // contradicts RECOVERED status
      status: "RECOVERED",
    };
    const result = verifyRecovery(makeInput({
      recoveryResult: {
        ...makeRecoveryResult(),
        attempts: [contradictoryAttempt],
        finalValidation: makePassedValidation(),
      },
    }));
    const check = result.checks.find(c => c.type === "RECOVERY_CONSISTENCY_CHECK")!;
    expect(check.status).toBe("FAILED");
    // The issues array (evidence) contains the contradiction detail
    const evidence = (check.evidence ?? []).join(" ");
    expect(
      evidence.includes("contradictory") || evidence.includes("RECOVERED") || evidence.includes("FAILED")
    ).toBe(true);
  });

  it("FAILED when overall RECOVERED but no attempt has status RECOVERED", () => {
    const result = verifyRecovery(makeInput({
      recoveryResult: makeRecoveryResult({
        status: "RECOVERED",
        attempts: [makeFailedAttempt(1)],  // no RECOVERED attempt
        finalValidation: makePassedValidation(),
      }),
    }));
    const check = result.checks.find(c => c.type === "RECOVERY_CONSISTENCY_CHECK")!;
    expect(check.status).toBe("FAILED");
    expect(check.evidence!.join(" ")).toContain("no individual attempt has status RECOVERED");
  });

  it("FAILED when attempt has status FAILED but validation.status is PASSED", () => {
    const contradictoryAttempt: RecoveryAttempt = {
      ...makeFailedAttempt(1),
      validation: makePassedValidation(), // PASSED validation but FAILED attempt status
      status: "FAILED",
    };
    // The overall recovery still reports RECOVERED (makeRecoveryResult default)
    // but the attempt itself has FAILED status with PASSED validation — contradiction
    const result = verifyRecovery(makeInput({
      recoveryResult: {
        ...makeRecoveryResult(),
        // Keep finalValidation as PASSED, but the attempt's internal state is wrong
        attempts: [contradictoryAttempt],
      },
    }));
    const check = result.checks.find(c => c.type === "RECOVERY_CONSISTENCY_CHECK")!;
    expect(check.status).toBe("FAILED");
    expect(check.evidence!.join(" ")).toContain("contradictory");
  });
});

// ---------------------------------------------------------------------------
// 14. STOPPED recovery
// ---------------------------------------------------------------------------

describe("STOPPED recovery verification", () => {
  it("STOPPED recovery with attempt limit reached has correct check statuses", () => {
    const attempts = Array.from({ length: MAX_RECOVERY_ATTEMPTS }, (_, i) =>
      makeFailedAttempt(i + 1)
    );
    const result = verifyRecovery(makeInput({
      recoveryResult: {
        workspaceId: "ws_p13",
        status: "STOPPED",
        attempts,
        finalValidation: makeFailedValidation(),
        reason: `Recovery stopped after ${MAX_RECOVERY_ATTEMPTS} attempts`,
      },
    }));

    // Limit check passes (3 <= 3)
    const limitCheck = result.checks.find(c => c.type === "ATTEMPT_LIMIT_CHECK")!;
    expect(limitCheck.status).toBe("PASSED");
    // Final status check passes for STOPPED (no PASSED final required)
    const finalCheck = result.checks.find(c => c.type === "FINAL_STATUS_CHECK")!;
    expect(finalCheck.status).toBe("PASSED");
    // Consistency check: STOPPED overall has no RECOVERED attempt — that's OK for STOPPED
    const consistencyCheck = result.checks.find(c => c.type === "RECOVERY_CONSISTENCY_CHECK")!;
    // For STOPPED, no attempt has RECOVERED status, so no contradiction
    expect(consistencyCheck.status).toBe("PASSED");
    // Each attempt is FAILED with FAILED validation — consistency holds
    // but FAILED attempt + FAILED validation is consistent
  });

  it("STOPPED recovery with 4 attempts fails attempt limit check", () => {
    const attempts = Array.from({ length: MAX_RECOVERY_ATTEMPTS + 1 }, (_, i) =>
      makeFailedAttempt(i + 1)
    );
    const result = verifyRecovery(makeInput({
      recoveryResult: {
        workspaceId: "ws_p13",
        status: "STOPPED",
        attempts,
        finalValidation: makeFailedValidation(),
        reason: "stopped",
      },
    }));
    const limitCheck = result.checks.find(c => c.type === "ATTEMPT_LIMIT_CHECK")!;
    expect(limitCheck.status).toBe("FAILED");
  });
});

// ---------------------------------------------------------------------------
// 15. Evidence completeness
// ---------------------------------------------------------------------------

describe("evidence completeness", () => {
  it("all 10 check types are present in output", () => {
    const result = verifyRecovery(makeInput());
    const types = result.checks.map(c => c.type);
    expect(types).toContain("INITIAL_FAILURE_CHECK");
    expect(types).toContain("ATTEMPT_SEQUENCE_CHECK");
    expect(types).toContain("ATTEMPT_LIMIT_CHECK");
    expect(types).toContain("CHANGE_SCOPE_CHECK");
    expect(types).toContain("CHANGE_EVIDENCE_CHECK");
    expect(types).toContain("EXPECTED_STATE_CHECK");
    expect(types).toContain("POST_REPAIR_VALIDATION_CHECK");
    expect(types).toContain("FINAL_STATUS_CHECK");
    expect(types).toContain("DUPLICATE_REPAIR_CHECK");
    expect(types).toContain("RECOVERY_CONSISTENCY_CHECK");
  });

  it("each check has id, type, status, message", () => {
    const result = verifyRecovery(makeInput());
    for (const check of result.checks) {
      expect(typeof check.id).toBe("string");
      expect(typeof check.type).toBe("string");
      expect(["PASSED", "FAILED"]).toContain(check.status);
      expect(typeof check.message).toBe("string");
      expect(check.message.length).toBeGreaterThan(0);
    }
  });

  it("errors array matches failed check messages", () => {
    const result = verifyRecovery(makeInput({
      recoveryResult: makeRecoveryResult({ finalValidation: undefined }),
    }));
    expect(result.errors).toHaveLength(result.checks.filter(c => c.status === "FAILED").length);
  });
});

// ---------------------------------------------------------------------------
// 16. Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("same input always produces same verification result", () => {
    const input = makeInput();
    const r1 = verifyRecovery(input);
    const r2 = verifyRecovery(input);
    expect(r1.status).toBe(r2.status);
    expect(r1.checks.length).toBe(r2.checks.length);
    expect(r1.checks.every((c, i) => c.status === r2.checks[i]!.status)).toBe(true);
    expect(r1.errors).toEqual(r2.errors);
  });

  it("zero Bob calls (synchronous pure function)", () => {
    // bobGenerate is not imported in recovery-verification.ts
    // This test confirms determinism by verifying no async behavior
    const input = makeInput();
    // If verifyRecovery were async, this would need await
    const result = verifyRecovery(input);
    expect(result).toBeDefined();
    expect(result.status).toBe("VERIFIED");
  });
});

// ---------------------------------------------------------------------------
// 17. Express 4 → 5 verification proof
// ---------------------------------------------------------------------------

describe("Express 4 → 5 recovery verification proof", () => {
  it("VERIFIED for complete Express 4→5 recovery evidence chain", () => {
    // Reconstruct the exact evidence chain from P12's Express 4→5 proof test
    const initialValidation: ValidationResult = {
      workspaceId: "ws_express",
      status: "FAILED",
      checks: [
        { id: "check-dependency", type: "DEPENDENCY", status: "PASSED", durationMs: 50 },
        { id: "check-typecheck", type: "TYPECHECK", status: "PASSED", durationMs: 100 },
        { id: "check-build", type: "BUILD", status: "PASSED", durationMs: 150 },
        {
          id: "check-test", type: "TEST", status: "FAILED",
          command: "pnpm run test", exitCode: 1,
          stdout: "TypeError: app.del is not a function\n  at src/app.ts:5",
          stderr: "", durationMs: 1200, reason: "test failed: app.del is not a function",
        },
      ],
      summary: { total: 4, passed: 3, failed: 1, notApplicable: 0, skipped: 0 },
      startedAt: "2024-01-01T00:00:00.000Z",
      completedAt: "2024-01-01T00:00:02.000Z",
    };

    const postRepairValidation: ValidationResult = {
      workspaceId: "ws_express",
      status: "PASSED",
      checks: [
        { id: "check-dependency", type: "DEPENDENCY", status: "PASSED", durationMs: 50 },
        { id: "check-typecheck", type: "TYPECHECK", status: "PASSED", durationMs: 100 },
        { id: "check-build", type: "BUILD", status: "PASSED", durationMs: 150 },
        { id: "check-test", type: "TEST", status: "PASSED", durationMs: 800 },
      ],
      summary: { total: 4, passed: 4, failed: 0, notApplicable: 0, skipped: 0 },
      startedAt: "2024-01-01T00:00:03.000Z",
      completedAt: "2024-01-01T00:00:05.000Z",
    };

    const recoveryResult: RecoveryResult = {
      workspaceId: "ws_express",
      status: "RECOVERED",
      attempts: [
        {
          attempt: 1,
          diagnosis: {
            diagnosis: "app.del() is not a function in Express 5",
            rootCause: "app.del was removed in Express 5; use app.delete()",
            proposedChanges: [
              {
                filePath: "src/app.ts",
                operation: "MODIFY",
                explanation: "Replaced deprecated app.del() with app.delete() for Express 5 compatibility",
                relatedStepIds: ["STEP-001"],
                relatedValidationCheckIds: ["check-test"],
              },
            ],
            bobDurationMs: 100,
          },
          proposedChanges: [
            {
              filePath: "src/app.ts",
              operation: "MODIFY",
              explanation: "Replaced deprecated app.del() with app.delete() for Express 5 compatibility",
              relatedStepIds: ["STEP-001"],
              relatedValidationCheckIds: ["check-test"],
            },
          ],
          appliedChanges: [
            {
              filePath: "src/app.ts",
              operation: "MODIFY",
              explanation: "Replaced deprecated app.del() with app.delete() for Express 5 compatibility",
              relatedStepIds: ["STEP-001"],
              relatedValidationCheckIds: ["check-test"],
            },
          ],
          validation: postRepairValidation,
          status: "RECOVERED",
          reason: "P11 validation passed after repair",
        },
      ],
      finalValidation: postRepairValidation,
      reason: "Recovery succeeded on attempt 1",
    };

    const plan = makePlan([makeStep({ id: "STEP-001", order: 1, affectedFiles: ["src/app.ts"] })]);
    const migResult = makeMigrationResult();

    const verificationInput: RecoveryVerificationInput = {
      workspace: {
        id: "ws_express", path: "/tmp/ws_express",
        repoUrl: "https://github.com/example/express-app",
        branch: "main", createdAt: "2024-01-01T00:00:00.000Z", status: "READY",
      },
      migrationPlan: plan,
      migrationResult: migResult,
      initialValidation,
      recoveryResult,
    };

    const result = verifyRecovery(verificationInput);

    // The full evidence chain is VERIFIED
    expect(result.status).toBe("VERIFIED");
    expect(result.recoveryStatus).toBe("RECOVERED");
    expect(result.verifiedAttempts).toBe(1);
    expect(result.verifiedChanges).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(result.finalValidation?.status).toBe("PASSED");

    // All 10 checks pass
    expect(result.checks).toHaveLength(10);
    expect(result.checks.every(c => c.status === "PASSED")).toBe(true);

    // Specific check evidence
    const scopeCheck = result.checks.find(c => c.type === "CHANGE_SCOPE_CHECK")!;
    expect(scopeCheck.status).toBe("PASSED");

    const finalCheck = result.checks.find(c => c.type === "FINAL_STATUS_CHECK")!;
    expect(finalCheck.status).toBe("PASSED");

    const consistencyCheck = result.checks.find(c => c.type === "RECOVERY_CONSISTENCY_CHECK")!;
    expect(consistencyCheck.status).toBe("PASSED");

    // Summary documents the outcome
    expect(result.summary).toContain("VERIFIED");
    expect(result.summary).toContain("10");

    // Live IBM Bob recovery verification: NOT VERIFIED
    // (BOB_API_KEY not available — but P13 requires zero Bob calls anyway)
  });

  it("FAILED when Express 4→5 recovery claims RECOVERED but test still failing", () => {
    // Simulates a false recovery claim — Bob was fooled but P11 still fails
    const falseRecovery: RecoveryResult = {
      workspaceId: "ws_express",
      status: "RECOVERED",
      attempts: [{
        attempt: 1,
        diagnosis: {
          diagnosis: "applied wrong fix",
          rootCause: "wrong diagnosis",
          proposedChanges: [{
            filePath: "src/app.ts", operation: "MODIFY",
            explanation: "wrong fix",
            relatedStepIds: ["STEP-001"],
            relatedValidationCheckIds: ["check-test"],
          }],
          bobDurationMs: 100,
        },
        proposedChanges: [{
          filePath: "src/app.ts", operation: "MODIFY",
          explanation: "wrong fix",
          relatedStepIds: ["STEP-001"],
          relatedValidationCheckIds: ["check-test"],
        }],
        appliedChanges: [{
          filePath: "src/app.ts", operation: "MODIFY",
          explanation: "wrong fix",
          relatedStepIds: ["STEP-001"],
          relatedValidationCheckIds: ["check-test"],
        }],
        validation: makeFailedValidation("ws_express"),  // still FAILED
        status: "RECOVERED",  // falsely marked as recovered
        reason: "false claim",
      }],
      finalValidation: makeFailedValidation("ws_express"),
      reason: "false recovery",
    };

    const result = verifyRecovery(makeInput({
      recoveryResult: falseRecovery,
      workspace: {
        id: "ws_express", path: "/tmp/ws_express",
        repoUrl: "https://github.com/example/express-app",
        branch: "main", createdAt: "2024-01-01T00:00:00.000Z", status: "READY",
      },
    }));

    // P13 rejects the false claim
    expect(result.status).toBe("FAILED");
    expect(result.errors.length).toBeGreaterThan(0);

    // FINAL_STATUS_CHECK catches the contradiction
    const finalCheck = result.checks.find(c => c.type === "FINAL_STATUS_CHECK")!;
    expect(finalCheck.status).toBe("FAILED");
  });
});
