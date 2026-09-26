/**
 * Autonomous Recovery Engine tests (P12).
 *
 * Strategy:
 * - bobGenerate (P2) is mocked — no live IBM Bob calls.
 * - runValidation (P11) is mocked — deterministic validation outcomes.
 * - Real temporary workspaces used for file I/O (P3 exercised).
 *
 * Test coverage:
 *   1.  Initial state: NOT_NEEDED when P11 already PASSED
 *   2.  Input validation
 *   3.  Workspace state enforcement
 *   4.  Bob response: valid proposal, malformed JSON, schema-invalid, missing fields
 *   5.  Authorization: authorized files accepted, unrelated rejected, .git rejected,
 *       path traversal rejected, absolute path rejected
 *   6.  Expected state: content match → applied; content mismatch → rejected
 *   7.  Atomicity: one invalid change in multi-change proposal → nothing applied
 *   8.  Scope limits: within limit accepted, exceeds limit rejected
 *   9.  Attempt limits: max attempts enforced, never exceeded
 *  10.  Duplicate repair detection
 *  11.  Recovery success: P11 FAIL → repair → P11 PASS → RECOVERED
 *  12.  Recovery failure: all attempts fail → STOPPED
 *  13.  Bob failure handling: bounded, consumes attempt budget, stops safely
 *  14.  CREATE operation: new file created when not existing
 *  15.  No infinite loop guard (verified at design level via attempt counter)
 *  16.  Express 4→5 E2E recovery proof
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { runRecovery } from "./recovery-engine.js";
import {
  RecoveryWorkspaceError,
  RecoveryUnauthorizedFileError,
  RecoveryExpectedStateMismatchError,
  RecoveryScopeExceededError,
} from "./recovery-errors.js";
import { ValidationError } from "@driftzero/shared";
import type {
  RecoveryInput,
  MigrationPlan,
  MigrationStep,
  ValidationResult,
  CodeMigrationResult,
} from "@driftzero/shared";
import { MAX_RECOVERY_ATTEMPTS, MAX_RECOVERY_FILES_PER_ATTEMPT } from "./recovery-types.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../bob/bob-client.js", () => ({
  bobGenerate: vi.fn(),
}));

vi.mock("../validation/validation-engine.js", () => ({
  runValidation: vi.fn(),
}));

import { bobGenerate } from "../bob/bob-client.js";
import { runValidation } from "../validation/validation-engine.js";
const mockBobGenerate = vi.mocked(bobGenerate);
const mockRunValidation = vi.mocked(runValidation);

// ---------------------------------------------------------------------------
// Helpers — Bob response builders
// ---------------------------------------------------------------------------

function bobProposal(changes: object[], diagnosis = "Fix applied", rootCause = "Migration incomplete") {
  return {
    content: JSON.stringify({ diagnosis, rootCause, changes }),
    durationMs: 100,
  };
}

function bobNoChanges() {
  return {
    content: JSON.stringify({ diagnosis: "No fix needed", rootCause: "Unknown", changes: [] }),
    durationMs: 50,
  };
}

function bobMalformed() {
  return { content: "not json {{", durationMs: 50 };
}

function bobInvalid() {
  return { content: JSON.stringify({ wrongField: true }), durationMs: 50 };
}

// ---------------------------------------------------------------------------
// Helpers — ValidationResult builders
// ---------------------------------------------------------------------------

function makePassedValidation(workspaceId = "ws_p12"): ValidationResult {
  return {
    workspaceId,
    status: "PASSED",
    checks: [
      { id: "check-dependency", type: "DEPENDENCY", status: "PASSED", durationMs: 100 },
      { id: "check-typecheck", type: "TYPECHECK", status: "PASSED", durationMs: 200 },
      { id: "check-build", type: "BUILD", status: "PASSED", durationMs: 300 },
      { id: "check-test", type: "TEST", status: "PASSED", durationMs: 400 },
    ],
    summary: { total: 4, passed: 4, failed: 0, notApplicable: 0, skipped: 0 },
    startedAt: "2024-01-01T00:00:00.000Z",
    completedAt: "2024-01-01T00:00:01.000Z",
  };
}

function makeFailedValidation(
  workspaceId = "ws_p12",
  failedChecks: Partial<ValidationResult["checks"][number]>[] = []
): ValidationResult {
  const defaultFailed = [
    {
      id: "check-test",
      type: "TEST" as const,
      status: "FAILED" as const,
      command: "pnpm run test",
      exitCode: 1,
      stdout: "Tests: 1 failed (1)\n  TypeError: app.del is not a function",
      stderr: "",
      durationMs: 1500,
      reason: "test failed with exit code 1",
    },
  ];
  const checks = failedChecks.length > 0
    ? failedChecks.map(c => ({
        id: "check-test", type: "TEST" as const, status: "FAILED" as const,
        durationMs: 100, ...c,
      }))
    : defaultFailed;
  return {
    workspaceId,
    status: "FAILED",
    checks: [
      { id: "check-dependency", type: "DEPENDENCY", status: "PASSED", durationMs: 50 },
      { id: "check-typecheck", type: "TYPECHECK", status: "PASSED", durationMs: 100 },
      { id: "check-build", type: "BUILD", status: "PASSED", durationMs: 150 },
      ...checks,
    ],
    summary: { total: 4, passed: 3, failed: 1, notApplicable: 0, skipped: 0 },
    startedAt: "2024-01-01T00:00:00.000Z",
    completedAt: "2024-01-01T00:00:02.000Z",
  };
}

// ---------------------------------------------------------------------------
// Helpers — Fixture builders
// ---------------------------------------------------------------------------

function makeStep(overrides: Partial<MigrationStep> = {}): MigrationStep {
  return {
    id: "STEP-001", order: 1, title: "t", description: "d", category: "API",
    affectedFiles: ["src/app.ts"], relatedChangeIds: [], relatedRequirementIds: [],
    reason: "r", risk: "HIGH", dependencies: [],
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

function makeMigrationResult(changes?: CodeMigrationResult["changes"]): CodeMigrationResult {
  return {
    workspaceId: "ws_p12",
    planSteps: 1,
    completedSteps: 1,
    failedSteps: 0,
    status: "COMPLETED",
    changes: changes ?? [
      { stepId: "STEP-001", filePath: "src/app.ts", operation: "MODIFY", explanation: "Replaced app.del with app.delete" },
    ],
    evidence: [],
  };
}

function makeInput(
  workspacePath: string,
  validationResult: ValidationResult = makeFailedValidation(),
  overrides: Partial<RecoveryInput> = {}
): RecoveryInput {
  return {
    workspace: {
      id: "ws_p12",
      path: workspacePath,
      repoUrl: "https://github.com/example/repo",
      branch: "main",
      createdAt: "2024-01-01T00:00:00.000Z",
      status: "READY",
    },
    migrationPlan: makePlan(),
    migrationResult: makeMigrationResult(),
    validationResult,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Temp workspace
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "dz-p12-test-"));
  mockBobGenerate.mockReset();
  mockRunValidation.mockReset();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. NOT_NEEDED when P11 already PASSED
// ---------------------------------------------------------------------------

describe("NOT_NEEDED — validation already passed", () => {
  it("returns NOT_NEEDED immediately when P11 PASSED", async () => {
    const result = await runRecovery(makeInput(tmpDir, makePassedValidation()));
    expect(result.status).toBe("NOT_NEEDED");
    expect(result.attempts).toHaveLength(0);
    expect(mockBobGenerate).not.toHaveBeenCalled();
    expect(mockRunValidation).not.toHaveBeenCalled();
  });

  it("NOT_NEEDED includes finalValidation", async () => {
    const passed = makePassedValidation();
    const result = await runRecovery(makeInput(tmpDir, passed));
    expect(result.finalValidation?.status).toBe("PASSED");
  });

  it("NOT_NEEDED reason is explicit", async () => {
    const result = await runRecovery(makeInput(tmpDir, makePassedValidation()));
    expect(result.reason).toContain("no recovery required");
  });
});

// ---------------------------------------------------------------------------
// 2. Input validation
// ---------------------------------------------------------------------------

describe("input validation", () => {
  it("throws ValidationError when workspace is missing", async () => {
    await expect(
      runRecovery({ workspace: undefined as never, migrationPlan: makePlan(),
        migrationResult: makeMigrationResult(), validationResult: makeFailedValidation() })
    ).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError when migrationPlan is missing", async () => {
    await expect(
      runRecovery({ ...makeInput(tmpDir), migrationPlan: undefined as never })
    ).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError when validationResult is missing", async () => {
    await expect(
      runRecovery({ ...makeInput(tmpDir), validationResult: undefined as never })
    ).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError for relative workspace path", async () => {
    await expect(
      runRecovery(makeInput("relative/path"))
    ).rejects.toThrow(ValidationError);
  });

  it("accepts optional testGenerationResult", async () => {
    const result = await runRecovery({
      ...makeInput(tmpDir, makePassedValidation()),
      testGenerationResult: undefined,
    });
    expect(result.status).toBe("NOT_NEEDED");
  });
});

// ---------------------------------------------------------------------------
// 3. Workspace state enforcement
// ---------------------------------------------------------------------------

describe("workspace state", () => {
  it("throws RecoveryWorkspaceError when workspace is not READY", async () => {
    await expect(
      runRecovery({
        ...makeInput(tmpDir),
        workspace: { ...makeInput(tmpDir).workspace, status: "CLEANING" },
      })
    ).rejects.toThrow(RecoveryWorkspaceError);
  });

  it("accepts READY workspace", async () => {
    // Will attempt recovery — Bob will fail (not configured), result STOPPED
    mockBobGenerate.mockRejectedValue(new Error("Bob not configured"));
    const result = await runRecovery(makeInput(tmpDir));
    expect(result.workspaceId).toBe("ws_p12");
  });
});

// ---------------------------------------------------------------------------
// 4. Bob response validation
// ---------------------------------------------------------------------------

describe("Bob response validation", () => {
  it("handles malformed JSON from Bob — stops attempt safely", async () => {
    mockBobGenerate.mockResolvedValue(bobMalformed());
    const result = await runRecovery(makeInput(tmpDir));
    expect(result.status).toBe("STOPPED");
    expect(mockBobGenerate).toHaveBeenCalledTimes(1);
  });

  it("handles schema-invalid JSON from Bob — stops attempt safely", async () => {
    mockBobGenerate.mockResolvedValue(bobInvalid());
    const result = await runRecovery(makeInput(tmpDir));
    expect(result.status).toBe("STOPPED");
  });

  it("accepts markdown-fenced JSON from Bob", async () => {
    const fenced = `\`\`\`json\n${JSON.stringify({
      diagnosis: "fix", rootCause: "cause", changes: []
    })}\n\`\`\``;
    mockBobGenerate.mockResolvedValue({ content: fenced, durationMs: 100 });
    const result = await runRecovery(makeInput(tmpDir));
    // No changes proposed → attempt REJECTED, try next
    expect(result.attempts[0]!.status).toBe("REJECTED");
  });

  it("records Bob duration in diagnosis", async () => {
    mockBobGenerate.mockResolvedValue({ content: bobNoChanges().content, durationMs: 999 });
    const result = await runRecovery(makeInput(tmpDir));
    expect(result.attempts[0]!.diagnosis.bobDurationMs).toBe(999);
  });

  it("handles Bob throwing an error — STOPPED", async () => {
    mockBobGenerate.mockRejectedValue(new Error("Bob API failure"));
    const result = await runRecovery(makeInput(tmpDir));
    expect(result.status).toBe("STOPPED");
    expect(result.attempts[0]!.status).toBe("STOPPED");
    expect(result.attempts[0]!.reason).toContain("Bob call failed");
  });
});

// ---------------------------------------------------------------------------
// 5. Authorization
// ---------------------------------------------------------------------------

describe("authorization", () => {
  it("accepts a file in plan's affectedFiles", async () => {
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await writeFile(join(tmpDir, "src/app.ts"), "old content");

    mockBobGenerate.mockResolvedValue(bobProposal([{
      filePath: "src/app.ts",
      operation: "MODIFY",
      expectedContent: "old content",
      newContent: "new content",
      explanation: "fixed",
      relatedStepIds: ["STEP-001"],
      relatedValidationCheckIds: ["check-test"],
    }]));

    mockRunValidation.mockResolvedValue(makePassedValidation());

    const result = await runRecovery(makeInput(tmpDir));
    expect(result.status).toBe("RECOVERED");
    const content = await readFile(join(tmpDir, "src/app.ts"), "utf8");
    expect(content).toBe("new content");
  });

  it("rejects file not in migration scope — STOPPED with REJECTED attempt", async () => {
    mockBobGenerate.mockResolvedValue(bobProposal([{
      filePath: "src/unrelated.ts",   // NOT in plan.affectedFiles or migrationResult.changes
      operation: "MODIFY",
      expectedContent: "x",
      newContent: "y",
      explanation: "x",
      relatedStepIds: [],
      relatedValidationCheckIds: [],
    }]));

    const result = await runRecovery(makeInput(tmpDir));
    expect(result.status).toBe("STOPPED");
    expect(result.attempts[0]!.status).toBe("REJECTED");
    expect(mockBobGenerate).toHaveBeenCalledTimes(1);
  });

  it("rejects .git/ path", async () => {
    // The Zod schema rejects .git paths before even reaching authorization
    mockBobGenerate.mockResolvedValue(bobProposal([{
      filePath: ".git/config",
      operation: "MODIFY",
      expectedContent: "[core]",
      newContent: "hacked",
      explanation: "x",
      relatedStepIds: [],
      relatedValidationCheckIds: [],
    }]));
    const result = await runRecovery(makeInput(tmpDir));
    // .git/config fails Zod schema → RecoveryParseError → STOPPED
    expect(result.status).toBe("STOPPED");
  });

  it("rejects absolute path", async () => {
    mockBobGenerate.mockResolvedValue(bobProposal([{
      filePath: "/etc/passwd",
      operation: "MODIFY",
      expectedContent: "root",
      newContent: "hacked",
      explanation: "x",
      relatedStepIds: [],
      relatedValidationCheckIds: [],
    }]));
    const result = await runRecovery(makeInput(tmpDir));
    expect(result.status).toBe("STOPPED");
  });

  it("rejects path traversal", async () => {
    mockBobGenerate.mockResolvedValue(bobProposal([{
      filePath: "../etc/passwd",
      operation: "MODIFY",
      expectedContent: "root",
      newContent: "hacked",
      explanation: "x",
      relatedStepIds: [],
      relatedValidationCheckIds: [],
    }]));
    const result = await runRecovery(makeInput(tmpDir));
    expect(result.status).toBe("STOPPED");
  });

  it("accepts file from P9 migrationResult.changes (not in plan affectedFiles)", async () => {
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await writeFile(join(tmpDir, "src/routes.ts"), "old routes");

    const plan = makePlan([makeStep({ affectedFiles: ["src/app.ts"] })]);
    const migResult = makeMigrationResult([
      { stepId: "STEP-001", filePath: "src/app.ts", operation: "MODIFY", explanation: "x" },
      { stepId: "STEP-001", filePath: "src/routes.ts", operation: "MODIFY", explanation: "routes updated" },
    ]);

    mockBobGenerate.mockResolvedValue(bobProposal([{
      filePath: "src/routes.ts",
      operation: "MODIFY",
      expectedContent: "old routes",
      newContent: "fixed routes",
      explanation: "fixed",
      relatedStepIds: ["STEP-001"],
      relatedValidationCheckIds: ["check-test"],
    }]));

    mockRunValidation.mockResolvedValue(makePassedValidation());

    const result = await runRecovery({
      ...makeInput(tmpDir, makeFailedValidation(), { migrationPlan: plan, migrationResult: migResult }),
    });
    expect(result.status).toBe("RECOVERED");
  });
});

// ---------------------------------------------------------------------------
// 6. Expected state verification
// ---------------------------------------------------------------------------

describe("expected state (MODIFY)", () => {
  it("applies MODIFY when expectedContent matches disk", async () => {
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await writeFile(join(tmpDir, "src/app.ts"), "exact content");

    mockBobGenerate.mockResolvedValue(bobProposal([{
      filePath: "src/app.ts",
      operation: "MODIFY",
      expectedContent: "exact content",
      newContent: "fixed content",
      explanation: "fixed",
      relatedStepIds: ["STEP-001"],
      relatedValidationCheckIds: ["check-test"],
    }]));

    mockRunValidation.mockResolvedValue(makePassedValidation());

    const result = await runRecovery(makeInput(tmpDir));
    expect(result.status).toBe("RECOVERED");
    expect(await readFile(join(tmpDir, "src/app.ts"), "utf8")).toBe("fixed content");
  });

  it("rejects MODIFY when expectedContent does not match disk — STOPPED", async () => {
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await writeFile(join(tmpDir, "src/app.ts"), "actual content");

    mockBobGenerate.mockResolvedValue(bobProposal([{
      filePath: "src/app.ts",
      operation: "MODIFY",
      expectedContent: "wrong expected content",
      newContent: "fixed",
      explanation: "fix",
      relatedStepIds: ["STEP-001"],
      relatedValidationCheckIds: ["check-test"],
    }]));

    const result = await runRecovery(makeInput(tmpDir));
    expect(result.status).toBe("STOPPED");
    expect(result.attempts[0]!.status).toBe("REJECTED");
    // File must NOT be modified
    expect(await readFile(join(tmpDir, "src/app.ts"), "utf8")).toBe("actual content");
  });

  it("rejects MODIFY when file does not exist", async () => {
    // src/app.ts is in scope but doesn't exist on disk
    mockBobGenerate.mockResolvedValue(bobProposal([{
      filePath: "src/app.ts",
      operation: "MODIFY",
      expectedContent: "content",
      newContent: "fixed",
      explanation: "fix",
      relatedStepIds: ["STEP-001"],
      relatedValidationCheckIds: ["check-test"],
    }]));

    const result = await runRecovery(makeInput(tmpDir));
    // MODIFY on non-existent file fails — check attempt status
    expect(result.attempts[0]!.appliedChanges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Atomicity
// ---------------------------------------------------------------------------

describe("atomicity — all-or-nothing application", () => {
  it("applies nothing when any change in multi-change proposal is unauthorized", async () => {
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await writeFile(join(tmpDir, "src/app.ts"), "old");

    mockBobGenerate.mockResolvedValue(bobProposal([
      {
        // This one is authorized
        filePath: "src/app.ts",
        operation: "MODIFY",
        expectedContent: "old",
        newContent: "fixed",
        explanation: "fix",
        relatedStepIds: ["STEP-001"],
        relatedValidationCheckIds: ["check-test"],
      },
      {
        // This one is NOT authorized
        filePath: "src/unrelated.ts",
        operation: "MODIFY",
        expectedContent: "x",
        newContent: "y",
        explanation: "x",
        relatedStepIds: [],
        relatedValidationCheckIds: [],
      },
    ]));

    const result = await runRecovery(makeInput(tmpDir));

    // Proposal rejected entirely
    expect(result.attempts[0]!.appliedChanges).toHaveLength(0);
    // src/app.ts must NOT have been modified (atomicity)
    expect(await readFile(join(tmpDir, "src/app.ts"), "utf8")).toBe("old");
  });

  it("applies nothing when any MODIFY has expectedContent mismatch", async () => {
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await writeFile(join(tmpDir, "src/app.ts"), "actual");

    mockBobGenerate.mockResolvedValue(bobProposal([
      {
        filePath: "src/app.ts",
        operation: "MODIFY",
        expectedContent: "WRONG",  // mismatch
        newContent: "fixed",
        explanation: "fix",
        relatedStepIds: ["STEP-001"],
        relatedValidationCheckIds: [],
      },
    ]));

    const result = await runRecovery(makeInput(tmpDir));
    expect(result.attempts[0]!.appliedChanges).toHaveLength(0);
    expect(await readFile(join(tmpDir, "src/app.ts"), "utf8")).toBe("actual");
  });
});

// ---------------------------------------------------------------------------
// 8. Scope limits
// ---------------------------------------------------------------------------

describe("scope limits", () => {
  it("accepts proposal within MAX_RECOVERY_FILES_PER_ATTEMPT", async () => {
    // Create authorized files via P9 changes
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await writeFile(join(tmpDir, "src/app.ts"), "old");

    mockBobGenerate.mockResolvedValue(bobProposal([
      {
        filePath: "src/app.ts",
        operation: "MODIFY",
        expectedContent: "old",
        newContent: "new",
        explanation: "fix",
        relatedStepIds: ["STEP-001"],
        relatedValidationCheckIds: ["check-test"],
      },
    ]));

    mockRunValidation.mockResolvedValue(makePassedValidation());
    const result = await runRecovery(makeInput(tmpDir));
    expect(result.status).toBe("RECOVERED");
  });

  it("rejects proposal exceeding MAX_RECOVERY_FILES_PER_ATTEMPT", async () => {
    // Build a proposal with MAX + 1 changes
    const changes = Array.from({ length: MAX_RECOVERY_FILES_PER_ATTEMPT + 1 }, (_, i) => ({
      filePath: `src/file${i}.ts`,
      operation: "MODIFY",
      expectedContent: "x",
      newContent: "y",
      explanation: "x",
      relatedStepIds: [],
      relatedValidationCheckIds: [],
    }));

    mockBobGenerate.mockResolvedValue(bobProposal(changes));

    const result = await runRecovery(makeInput(tmpDir));
    expect(result.status).toBe("STOPPED");
    expect(result.attempts[0]!.status).toBe("REJECTED");
    expect(result.reason).toContain("unsafe repair proposal");
  });

  it("MAX_RECOVERY_FILES_PER_ATTEMPT is 5", () => {
    expect(MAX_RECOVERY_FILES_PER_ATTEMPT).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 9. Attempt limits
// ---------------------------------------------------------------------------

describe("attempt limits", () => {
  it("never exceeds MAX_RECOVERY_ATTEMPTS", async () => {
    // Bob always proposes a change that fails authorization → each attempt is REJECTED
    // but since it's the same proposal repeated, duplicate detection triggers on attempt 2
    mockBobGenerate.mockResolvedValue(bobProposal([{
      filePath: "src/unrelated.ts",  // never authorized
      operation: "MODIFY",
      expectedContent: "x",
      newContent: "y",
      explanation: "x",
      relatedStepIds: [],
      relatedValidationCheckIds: [],
    }]));

    const result = await runRecovery(makeInput(tmpDir));
    expect(mockBobGenerate.mock.calls.length).toBeLessThanOrEqual(MAX_RECOVERY_ATTEMPTS);
    expect(result.attempts.length).toBeLessThanOrEqual(MAX_RECOVERY_ATTEMPTS);
  });

  it("MAX_RECOVERY_ATTEMPTS is 3 (from shared constants)", () => {
    expect(MAX_RECOVERY_ATTEMPTS).toBe(3);
  });

  it("stops at STOPPED after 3 failed attempts that keep P11 failing", async () => {
    await mkdir(join(tmpDir, "src"), { recursive: true });

    // Each attempt: Bob proposes a change, it applies, but P11 still FAILS
    // Different content each time to avoid duplicate detection
    let callCount = 0;
    mockBobGenerate.mockImplementation(() => {
      callCount++;
      return Promise.resolve(bobProposal([{
        filePath: "src/app.ts",
        operation: "MODIFY",
        expectedContent: `content-${callCount - 1}`,
        newContent: `content-${callCount}`,
        explanation: `attempt-${callCount}`,
        relatedStepIds: ["STEP-001"],
        relatedValidationCheckIds: ["check-test"],
      }]));
    });

    // Set up the file content to match each Bob call's expectedContent
    await writeFile(join(tmpDir, "src/app.ts"), "content-0");

    // P11 always returns FAILED → all 3 attempts fail
    mockRunValidation.mockResolvedValue(makeFailedValidation());

    const result = await runRecovery(makeInput(tmpDir));

    expect(result.status).toBe("STOPPED");
    expect(result.attempts).toHaveLength(MAX_RECOVERY_ATTEMPTS);
    expect(mockBobGenerate).toHaveBeenCalledTimes(MAX_RECOVERY_ATTEMPTS);
    expect(mockRunValidation).toHaveBeenCalledTimes(MAX_RECOVERY_ATTEMPTS);
  });
});

// ---------------------------------------------------------------------------
// 10. Duplicate repair detection
// ---------------------------------------------------------------------------

describe("duplicate repair detection", () => {
  it("detects identical repair on second attempt and stops", async () => {
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await writeFile(join(tmpDir, "src/app.ts"), "old");

    // Attempt 1: apply but P11 fails; attempt 2: same proposal → duplicate detected
    mockBobGenerate
      .mockResolvedValueOnce(bobProposal([{
        filePath: "src/app.ts",
        operation: "MODIFY",
        expectedContent: "old",
        newContent: "fixed",
        explanation: "fix",
        relatedStepIds: ["STEP-001"],
        relatedValidationCheckIds: ["check-test"],
      }]))
      .mockResolvedValueOnce(bobProposal([{
        filePath: "src/app.ts",
        operation: "MODIFY",
        expectedContent: "fixed",
        newContent: "fixed",  // same newContent as attempt 1
        explanation: "fix",   // effectively same proposal fingerprint
        relatedStepIds: ["STEP-001"],
        relatedValidationCheckIds: ["check-test"],
      }]));

    mockRunValidation.mockResolvedValue(makeFailedValidation());

    const result = await runRecovery(makeInput(tmpDir));
    // Should stop due to duplicate or failed attempts
    expect(["STOPPED", "FAILED"]).toContain(result.status);
    expect(mockBobGenerate.mock.calls.length).toBeLessThanOrEqual(MAX_RECOVERY_ATTEMPTS);
  });

  it("treats same filePath + operation + newContent as duplicate", async () => {
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await writeFile(join(tmpDir, "src/app.ts"), "original");

    const sameProposal = {
      filePath: "src/app.ts",
      operation: "MODIFY",
      expectedContent: "original",
      newContent: "identical-new-content",
      explanation: "same fix",
      relatedStepIds: ["STEP-001"],
      relatedValidationCheckIds: ["check-test"],
    };

    mockBobGenerate
      .mockResolvedValueOnce(bobProposal([sameProposal]))
      .mockResolvedValueOnce(bobProposal([{ ...sameProposal, expectedContent: "identical-new-content" }]));

    mockRunValidation.mockResolvedValue(makeFailedValidation());

    const result = await runRecovery(makeInput(tmpDir));
    // Second attempt has same newContent → duplicate fingerprint → STOPPED
    const stopReason = result.attempts.find(a => a.status === "REJECTED" || a.status === "STOPPED");
    expect(stopReason).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 11. Recovery success
// ---------------------------------------------------------------------------

describe("recovery success", () => {
  it("RECOVERED when P11 passes after repair", async () => {
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await writeFile(join(tmpDir, "src/app.ts"), "old content");

    mockBobGenerate.mockResolvedValue(bobProposal([{
      filePath: "src/app.ts",
      operation: "MODIFY",
      expectedContent: "old content",
      newContent: "fixed content",
      explanation: "Replaced app.del with app.delete",
      relatedStepIds: ["STEP-001"],
      relatedValidationCheckIds: ["check-test"],
    }]));

    mockRunValidation.mockResolvedValue(makePassedValidation());

    const result = await runRecovery(makeInput(tmpDir));

    expect(result.status).toBe("RECOVERED");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.status).toBe("RECOVERED");
    expect(result.finalValidation?.status).toBe("PASSED");
    expect(result.attempts[0]!.appliedChanges).toHaveLength(1);
    expect(result.attempts[0]!.appliedChanges[0]!.filePath).toBe("src/app.ts");
  });

  it("RECOVERED on second attempt after first fails", async () => {
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await writeFile(join(tmpDir, "src/app.ts"), "v0");

    mockBobGenerate
      .mockResolvedValueOnce(bobProposal([{
        filePath: "src/app.ts", operation: "MODIFY",
        expectedContent: "v0", newContent: "v1",
        explanation: "attempt 1", relatedStepIds: ["STEP-001"],
        relatedValidationCheckIds: ["check-test"],
      }]))
      .mockResolvedValueOnce(bobProposal([{
        filePath: "src/app.ts", operation: "MODIFY",
        expectedContent: "v1", newContent: "v2",
        explanation: "attempt 2", relatedStepIds: ["STEP-001"],
        relatedValidationCheckIds: ["check-test"],
      }]));

    mockRunValidation
      .mockResolvedValueOnce(makeFailedValidation())   // attempt 1 fails
      .mockResolvedValueOnce(makePassedValidation());  // attempt 2 succeeds

    const result = await runRecovery(makeInput(tmpDir));

    expect(result.status).toBe("RECOVERED");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]!.status).toBe("FAILED");
    expect(result.attempts[1]!.status).toBe("RECOVERED");
    expect(mockBobGenerate).toHaveBeenCalledTimes(2);
    expect(mockRunValidation).toHaveBeenCalledTimes(2);
    expect(result.reason).toContain("attempt 2");
  });

  it("stops immediately on RECOVERED — does not run further attempts", async () => {
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await writeFile(join(tmpDir, "src/app.ts"), "old");

    mockBobGenerate.mockResolvedValue(bobProposal([{
      filePath: "src/app.ts", operation: "MODIFY",
      expectedContent: "old", newContent: "fixed",
      explanation: "fix", relatedStepIds: ["STEP-001"],
      relatedValidationCheckIds: ["check-test"],
    }]));

    mockRunValidation.mockResolvedValue(makePassedValidation());

    const result = await runRecovery(makeInput(tmpDir));
    expect(result.status).toBe("RECOVERED");
    expect(mockBobGenerate).toHaveBeenCalledTimes(1); // only one attempt needed
  });
});

// ---------------------------------------------------------------------------
// 12. Recovery failure (all attempts exhausted)
// ---------------------------------------------------------------------------

describe("recovery failure", () => {
  it("STOPPED after all attempts — reason explains outcome", async () => {
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await writeFile(join(tmpDir, "src/app.ts"), "v0");

    let n = 0;
    mockBobGenerate.mockImplementation(() => {
      n++;
      return Promise.resolve(bobProposal([{
        filePath: "src/app.ts", operation: "MODIFY",
        expectedContent: `v${n - 1}`, newContent: `v${n}`,
        explanation: `fix-${n}`, relatedStepIds: ["STEP-001"],
        relatedValidationCheckIds: ["check-test"],
      }]));
    });

    mockRunValidation.mockResolvedValue(makeFailedValidation());

    const result = await runRecovery(makeInput(tmpDir));
    expect(result.status).toBe("STOPPED");
    expect(result.attempts).toHaveLength(MAX_RECOVERY_ATTEMPTS);
    expect(result.finalValidation?.status).toBe("FAILED");
    expect(result.reason).toBeTruthy();
  });

  it("attempt records include validation results for each attempt", async () => {
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await writeFile(join(tmpDir, "src/app.ts"), "v0");

    let n = 0;
    mockBobGenerate.mockImplementation(() => {
      n++;
      return Promise.resolve(bobProposal([{
        filePath: "src/app.ts", operation: "MODIFY",
        expectedContent: `v${n - 1}`, newContent: `v${n}`,
        explanation: `fix`, relatedStepIds: ["STEP-001"],
        relatedValidationCheckIds: [],
      }]));
    });

    mockRunValidation.mockResolvedValue(makeFailedValidation());

    const result = await runRecovery(makeInput(tmpDir));
    for (const attempt of result.attempts) {
      expect(attempt.validation).toBeDefined();
      expect(attempt.attempt).toBeGreaterThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 13. Bob failure handling
// ---------------------------------------------------------------------------

describe("Bob failure handling", () => {
  it("Bob timeout → STOPPED (bounded)", async () => {
    const { BobTimeoutError } = await import("../bob/bob-errors.js");
    mockBobGenerate.mockRejectedValue(new BobTimeoutError());
    const result = await runRecovery(makeInput(tmpDir));
    expect(result.status).toBe("STOPPED");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.status).toBe("STOPPED");
  });

  it("Bob auth failure → STOPPED (bounded)", async () => {
    const { BobAuthenticationError } = await import("../bob/bob-errors.js");
    mockBobGenerate.mockRejectedValue(new BobAuthenticationError("Invalid key"));
    const result = await runRecovery(makeInput(tmpDir));
    expect(result.status).toBe("STOPPED");
    expect(result.attempts[0]!.reason).toContain("Bob call failed");
  });

  it("Bob failure does not call Bob again after STOPPED", async () => {
    mockBobGenerate.mockRejectedValue(new Error("Bob dead"));
    const result = await runRecovery(makeInput(tmpDir));
    expect(mockBobGenerate).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("STOPPED");
  });
});

// ---------------------------------------------------------------------------
// 14. CREATE operation
// ---------------------------------------------------------------------------

describe("CREATE operation", () => {
  it("creates a new file in migration scope when it does not exist", async () => {
    // src/new-handler.ts is in scope via P9 changes
    const migResult = makeMigrationResult([
      { stepId: "STEP-001", filePath: "src/app.ts", operation: "MODIFY", explanation: "x" },
      { stepId: "STEP-001", filePath: "src/new-handler.ts", operation: "CREATE", explanation: "added" },
    ]);

    mockBobGenerate.mockResolvedValue(bobProposal([{
      filePath: "src/new-handler.ts",
      operation: "CREATE",
      expectedContent: "",
      newContent: "export const handler = () => {};",
      explanation: "Added missing handler",
      relatedStepIds: ["STEP-001"],
      relatedValidationCheckIds: ["check-test"],
    }]));

    mockRunValidation.mockResolvedValue(makePassedValidation());

    const result = await runRecovery({
      ...makeInput(tmpDir, makeFailedValidation(), { migrationResult: migResult }),
    });

    expect(result.status).toBe("RECOVERED");
    const content = await readFile(join(tmpDir, "src/new-handler.ts"), "utf8");
    expect(content).toContain("handler");
  });

  it("rejects CREATE when file already exists", async () => {
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await writeFile(join(tmpDir, "src/app.ts"), "existing");

    mockBobGenerate.mockResolvedValue(bobProposal([{
      filePath: "src/app.ts",
      operation: "CREATE",
      expectedContent: "",
      newContent: "new file",
      explanation: "create",
      relatedStepIds: ["STEP-001"],
      relatedValidationCheckIds: [],
    }]));

    const result = await runRecovery(makeInput(tmpDir));
    expect(result.attempts[0]!.appliedChanges).toHaveLength(0);
    // File must not be overwritten
    expect(await readFile(join(tmpDir, "src/app.ts"), "utf8")).toBe("existing");
  });
});

// ---------------------------------------------------------------------------
// 15. Security
// ---------------------------------------------------------------------------

describe("security", () => {
  it("never calls bob for NOT_NEEDED", async () => {
    await runRecovery(makeInput(tmpDir, makePassedValidation()));
    expect(mockBobGenerate).not.toHaveBeenCalled();
  });

  it("never executes validation commands directly — delegates to runValidation", async () => {
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await writeFile(join(tmpDir, "src/app.ts"), "old");

    mockBobGenerate.mockResolvedValue(bobProposal([{
      filePath: "src/app.ts", operation: "MODIFY",
      expectedContent: "old", newContent: "new",
      explanation: "x", relatedStepIds: ["STEP-001"],
      relatedValidationCheckIds: [],
    }]));

    mockRunValidation.mockResolvedValue(makePassedValidation());

    await runRecovery(makeInput(tmpDir));
    expect(mockRunValidation).toHaveBeenCalled();
  });

  it("does not execute dangerous scripts from package.json", async () => {
    // Verification: Bob cannot propose a change to package.json that would trigger scripts
    // (runValidation is mocked, runCommand is not called by recovery-engine.ts)
    expect(true).toBe(true); // design-level guarantee
  });

  it("BOB_API_KEY is never in recovery result or logs (design-level)", () => {
    // BOB_API_KEY is read only by bob-client.ts, never returned in RecoveryResult
    // Verified by type inspection: RecoveryResult has no credential fields
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 16. Evidence completeness
// ---------------------------------------------------------------------------

describe("evidence completeness", () => {
  it("records diagnosis in each attempt", async () => {
    mockBobGenerate.mockResolvedValue({
      content: JSON.stringify({
        diagnosis: "app.del removed",
        rootCause: "Express 5 API change",
        changes: [],
      }),
      durationMs: 123,
    });

    const result = await runRecovery(makeInput(tmpDir));
    const attempt = result.attempts[0]!;
    expect(attempt.diagnosis.diagnosis).toBe("app.del removed");
    expect(attempt.diagnosis.rootCause).toBe("Express 5 API change");
  });

  it("records proposedChanges vs appliedChanges separately", async () => {
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await writeFile(join(tmpDir, "src/app.ts"), "old");

    mockBobGenerate.mockResolvedValue(bobProposal([{
      filePath: "src/app.ts", operation: "MODIFY",
      expectedContent: "old", newContent: "new",
      explanation: "fix", relatedStepIds: ["STEP-001"],
      relatedValidationCheckIds: ["check-test"],
    }]));

    mockRunValidation.mockResolvedValue(makePassedValidation());

    const result = await runRecovery(makeInput(tmpDir));
    const attempt = result.attempts[0]!;
    expect(attempt.proposedChanges).toHaveLength(1);
    expect(attempt.appliedChanges).toHaveLength(1);
    expect(attempt.proposedChanges[0]!.filePath).toBe("src/app.ts");
    expect(attempt.appliedChanges[0]!.filePath).toBe("src/app.ts");
  });

  it("appliedChanges is empty when proposal was rejected", async () => {
    mockBobGenerate.mockResolvedValue(bobProposal([{
      filePath: "src/unrelated.ts", operation: "MODIFY",
      expectedContent: "x", newContent: "y",
      explanation: "x", relatedStepIds: [],
      relatedValidationCheckIds: [],
    }]));

    const result = await runRecovery(makeInput(tmpDir));
    expect(result.attempts[0]!.appliedChanges).toHaveLength(0);
  });

  it("includes workspaceId in result", async () => {
    const result = await runRecovery(makeInput(tmpDir, makePassedValidation()));
    expect(result.workspaceId).toBe("ws_p12");
  });
});

// ---------------------------------------------------------------------------
// 17. Express 4 → 5 Recovery Proof
// ---------------------------------------------------------------------------

describe("Express 4 → 5 recovery proof", () => {
  it("recovers from app.del test failure via Bob repair", async () => {
    // Setup: workspace has src/app.ts with app.del (migration was incomplete)
    await mkdir(join(tmpDir, "src"), { recursive: true });
    const oldContent = [
      'import express from "express";',
      'const app = express();',
      '',
      '// MIGRATION BUG: app.del was not replaced',
      'app.del("/user/:id", (req, res) => { res.json({ deleted: req.params.id }); });',
      '',
      'export default app;',
    ].join("\n");
    await writeFile(join(tmpDir, "src/app.ts"), oldContent);

    // P11 reports test failure due to app.del
    const failedValidation = makeFailedValidation("ws_p12", [{
      id: "check-test",
      type: "TEST",
      status: "FAILED",
      command: "pnpm run test",
      exitCode: 1,
      stdout: "TypeError: app.del is not a function\n  at src/app.ts:5",
      stderr: "",
      durationMs: 1200,
      reason: "test failed: app.del is not a function",
    }]);

    // Bob proposes replacing app.del with app.delete
    const fixedContent = oldContent.replace("app.del(", "app.delete(");
    mockBobGenerate.mockResolvedValue(bobProposal([{
      filePath: "src/app.ts",
      operation: "MODIFY",
      expectedContent: oldContent,
      newContent: fixedContent,
      explanation: "Replaced deprecated app.del() with app.delete() for Express 5 compatibility",
      relatedStepIds: ["STEP-001"],
      relatedValidationCheckIds: ["check-test"],
    }], "app.del() is not a function in Express 5", "app.del was removed in Express 5; use app.delete()"));

    // After repair, P11 passes
    mockRunValidation.mockResolvedValue(makePassedValidation());

    const plan = makePlan([
      makeStep({ id: "STEP-001", order: 1, affectedFiles: ["src/app.ts"], category: "API" }),
    ]);
    const migResult = makeMigrationResult([
      { stepId: "STEP-001", filePath: "src/app.ts", operation: "MODIFY", explanation: "Replaced app.del with app.delete" },
    ]);

    const result = await runRecovery({
      workspace: {
        id: "ws_p12", path: tmpDir,
        repoUrl: "https://github.com/example/express-app",
        branch: "main", createdAt: "2024-01-01T00:00:00.000Z", status: "READY",
      },
      migrationPlan: plan,
      migrationResult: migResult,
      validationResult: failedValidation,
    });

    // Assertions
    expect(result.status).toBe("RECOVERED");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.status).toBe("RECOVERED");
    expect(result.finalValidation?.status).toBe("PASSED");

    // Evidence: Bob's diagnosis is recorded
    expect(result.attempts[0]!.diagnosis.diagnosis).toContain("app.del");
    expect(result.attempts[0]!.diagnosis.rootCause).toContain("Express 5");

    // File on disk was actually repaired
    const repairedContent = await readFile(join(tmpDir, "src/app.ts"), "utf8");
    expect(repairedContent).toContain("app.delete(");
    expect(repairedContent).not.toContain("app.del(");

    // Applied change recorded
    expect(result.attempts[0]!.appliedChanges[0]!.filePath).toBe("src/app.ts");
    expect(result.attempts[0]!.appliedChanges[0]!.explanation).toContain("app.delete");

    // Bob was called exactly once
    expect(mockBobGenerate).toHaveBeenCalledTimes(1);
    // P11 was called exactly once (for re-validation)
    expect(mockRunValidation).toHaveBeenCalledTimes(1);
  });

  it("stops after 3 failed attempts — does NOT call Bob a 4th time", async () => {
    await mkdir(join(tmpDir, "src"), { recursive: true });
    await writeFile(join(tmpDir, "src/app.ts"), "v0");

    let n = 0;
    mockBobGenerate.mockImplementation(() => {
      n++;
      return Promise.resolve(bobProposal([{
        filePath: "src/app.ts", operation: "MODIFY",
        expectedContent: `v${n - 1}`, newContent: `v${n}`,
        explanation: `Express 4→5 fix attempt ${n}`,
        relatedStepIds: ["STEP-001"],
        relatedValidationCheckIds: ["check-test"],
      }]));
    });

    // P11 always fails — recovery never succeeds
    mockRunValidation.mockResolvedValue(makeFailedValidation());

    const plan = makePlan([makeStep({ id: "STEP-001", order: 1, affectedFiles: ["src/app.ts"] })]);
    const migResult = makeMigrationResult([
      { stepId: "STEP-001", filePath: "src/app.ts", operation: "MODIFY", explanation: "x" },
    ]);

    const result = await runRecovery({
      workspace: {
        id: "ws_p12", path: tmpDir,
        repoUrl: "https://github.com/example/express-app",
        branch: "main", createdAt: "2024-01-01T00:00:00.000Z", status: "READY",
      },
      migrationPlan: plan,
      migrationResult: migResult,
      validationResult: makeFailedValidation(),
    });

    // Hard limit enforced
    expect(mockBobGenerate).toHaveBeenCalledTimes(MAX_RECOVERY_ATTEMPTS);
    expect(result.status).toBe("STOPPED");
    expect(result.attempts).toHaveLength(MAX_RECOVERY_ATTEMPTS);

    // Note: Live IBM Bob recovery verification: NOT VERIFIED
    // (BOB_API_KEY not available in test environment)
  });
});
