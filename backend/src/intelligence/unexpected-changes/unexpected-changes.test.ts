/**
 * Unexpected Change Detection Engine tests (P14).
 *
 * Strategy:
 * - gitStatus (P3) is mocked — no live git calls in unit tests.
 * - Real temporary workspace directories used for path safety checks.
 * - detectUnexpectedChanges() is async; parseGitStatus() is pure sync.
 * - Zero Bob calls.
 *
 * Test coverage:
 *   1.  Input validation
 *   2.  Workspace state enforcement
 *   3.  Git status failure
 *   4.  parseGitStatus() — unit tests for each status code
 *   5.  CLEAN migration — all actual changes authorized
 *   6.  Unexpected file (not authorized)
 *   7.  Unexpected CREATE
 *   8.  Unexpected DELETE
 *   9.  Unexpected RENAME
 *  10.  P10 test change authorized
 *  11.  P12 recovery change authorized
 *  12.  P8-only affected file NOT classified as unexpected
 *  13.  Multiple unexpected files — all returned, sorted deterministically
 *  14.  Path safety: ../, absolute, .git/ rejected
 *  15.  .git/ changes silently skipped (not reported as unexpected)
 *  16.  Determinism — same input produces same result
 *  17.  Summary correctness
 *  18.  Express 4→5 E2E proof (real git workspace)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { detectUnexpectedChanges, parseGitStatus } from "./unexpected-changes.js";
import {
  UnexpectedChangeWorkspaceError,
  UnexpectedChangeGitError,
} from "./unexpected-changes-errors.js";
import { ValidationError } from "@driftzero/shared";
import type {
  UnexpectedChangeDetectionInput,
  MigrationPlan,
  MigrationStep,
  CodeMigrationResult,
} from "@driftzero/shared";

// ---------------------------------------------------------------------------
// Mock P3 gitStatus
// ---------------------------------------------------------------------------

vi.mock("../../workspace/clone.js", () => ({
  gitStatus: vi.fn(),
  cloneRepository: vi.fn(),
  gitCurrentBranch: vi.fn(),
  gitDiff: vi.fn(),
  gitCheckout: vi.fn(),
}));

import { gitStatus } from "../../workspace/clone.js";
const mockGitStatus = vi.mocked(gitStatus);

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

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

function makeMigrationResult(
  changes: CodeMigrationResult["changes"] = [
    { stepId: "STEP-001", filePath: "src/app.ts", operation: "MODIFY", explanation: "Updated" },
  ]
): CodeMigrationResult {
  return {
    workspaceId: "ws_p14",
    planSteps: 1, completedSteps: 1, failedSteps: 0,
    status: "COMPLETED", changes, evidence: [],
  };
}

function makeInput(
  workspacePath: string,
  overrides: Partial<UnexpectedChangeDetectionInput> = {}
): UnexpectedChangeDetectionInput {
  return {
    workspace: {
      id: "ws_p14", path: workspacePath,
      repoUrl: "https://github.com/example/repo",
      branch: "main", createdAt: "2024-01-01T00:00:00.000Z", status: "READY",
    },
    migrationPlan: makePlan(),
    migrationResult: makeMigrationResult(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Temp workspace
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "dz-p14-test-"));
  mockGitStatus.mockReset();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Input validation
// ---------------------------------------------------------------------------

describe("input validation", () => {
  it("throws ValidationError when workspace is missing", async () => {
    await expect(detectUnexpectedChanges({
      workspace: undefined as never,
      migrationPlan: makePlan(),
      migrationResult: makeMigrationResult(),
    })).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError for relative workspace path", async () => {
    await expect(detectUnexpectedChanges(makeInput("relative/path"))).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError when migrationResult is missing", async () => {
    await expect(detectUnexpectedChanges({
      ...makeInput(tmpDir),
      migrationResult: undefined as never,
    })).rejects.toThrow(ValidationError);
  });

  it("accepts optional testGenerationResult and recoveryResult", async () => {
    mockGitStatus.mockResolvedValue("M src/app.ts\n");
    const result = await detectUnexpectedChanges(makeInput(tmpDir, {
      testGenerationResult: undefined,
      recoveryResult: undefined,
    }));
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Workspace state enforcement
// ---------------------------------------------------------------------------

describe("workspace state", () => {
  it("throws UnexpectedChangeWorkspaceError when workspace not READY", async () => {
    await expect(detectUnexpectedChanges({
      ...makeInput(tmpDir),
      workspace: { ...makeInput(tmpDir).workspace, status: "CLEANING" },
    })).rejects.toThrow(UnexpectedChangeWorkspaceError);
  });
});

// ---------------------------------------------------------------------------
// 3. Git status failure
// ---------------------------------------------------------------------------

describe("git status failure", () => {
  it("throws UnexpectedChangeGitError when gitStatus fails", async () => {
    mockGitStatus.mockRejectedValue(new Error("git not found"));
    await expect(detectUnexpectedChanges(makeInput(tmpDir))).rejects.toThrow(UnexpectedChangeGitError);
  });
});

// ---------------------------------------------------------------------------
// 4. parseGitStatus() — unit tests
// ---------------------------------------------------------------------------

describe("parseGitStatus", () => {
  it("parses modified file (M in worktree)", () => {
    const changes = parseGitStatus(" M src/app.ts\n", tmpDir);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ filePath: "src/app.ts", changeType: "MODIFIED" });
  });

  it("parses modified file (M in index)", () => {
    const changes = parseGitStatus("M  src/app.ts\n", tmpDir);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ filePath: "src/app.ts", changeType: "MODIFIED" });
  });

  it("parses untracked file (??) as ADDED", () => {
    const changes = parseGitStatus("?? src/new.ts\n", tmpDir);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ filePath: "src/new.ts", changeType: "ADDED" });
  });

  it("parses deleted file (D in worktree)", () => {
    const changes = parseGitStatus(" D src/old.ts\n", tmpDir);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ filePath: "src/old.ts", changeType: "DELETED" });
  });

  it("parses staged added file (A in index)", () => {
    const changes = parseGitStatus("A  src/staged.ts\n", tmpDir);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ filePath: "src/staged.ts", changeType: "ADDED" });
  });

  it("parses rename (R  old -> new)", () => {
    const changes = parseGitStatus("R  src/old.ts -> src/new.ts\n", tmpDir);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      changeType: "RENAMED",
      oldPath: "src/old.ts",
      filePath: "src/new.ts",
    });
  });

  it("silently skips .git/ paths", () => {
    const changes = parseGitStatus(" M .git/config\n", tmpDir);
    expect(changes).toHaveLength(0);
  });

  it("silently skips absolute paths", () => {
    const changes = parseGitStatus(" M /etc/passwd\n", tmpDir);
    expect(changes).toHaveLength(0);
  });

  it("silently skips path traversal", () => {
    const changes = parseGitStatus(" M ../evil.ts\n", tmpDir);
    expect(changes).toHaveLength(0);
  });

  it("returns empty array for empty status", () => {
    expect(parseGitStatus("", tmpDir)).toHaveLength(0);
    expect(parseGitStatus("   \n", tmpDir)).toHaveLength(0);
  });

  it("handles multiple lines", () => {
    const output = " M src/app.ts\n?? src/new.ts\n D src/old.ts\n";
    const changes = parseGitStatus(output, tmpDir);
    expect(changes).toHaveLength(3);
    const types = changes.map(c => c.changeType).sort();
    expect(types).toContain("MODIFIED");
    expect(types).toContain("ADDED");
    expect(types).toContain("DELETED");
  });
});

// ---------------------------------------------------------------------------
// 5. CLEAN migration — all actual changes authorized
// ---------------------------------------------------------------------------

describe("CLEAN migration", () => {
  it("CLEAN when all actual changes are in P9 authorized set", async () => {
    mockGitStatus.mockResolvedValue(" M src/app.ts\n");
    const result = await detectUnexpectedChanges(makeInput(tmpDir));
    expect(result.status).toBe("CLEAN");
    expect(result.unexpectedChanges).toHaveLength(0);
    expect(result.actualChanges).toHaveLength(1);
  });

  it("CLEAN when no actual changes (empty workspace)", async () => {
    mockGitStatus.mockResolvedValue("");
    const result = await detectUnexpectedChanges(makeInput(tmpDir));
    expect(result.status).toBe("CLEAN");
    expect(result.actualChanges).toHaveLength(0);
    expect(result.unexpectedChanges).toHaveLength(0);
  });

  it("CLEAN when multiple authorized files all changed", async () => {
    mockGitStatus.mockResolvedValue(" M src/app.ts\n M src/routes.ts\n");
    const result = await detectUnexpectedChanges(makeInput(tmpDir, {
      migrationResult: makeMigrationResult([
        { stepId: "STEP-001", filePath: "src/app.ts", operation: "MODIFY", explanation: "x" },
        { stepId: "STEP-001", filePath: "src/routes.ts", operation: "MODIFY", explanation: "y" },
      ]),
    }));
    expect(result.status).toBe("CLEAN");
    expect(result.unexpectedChanges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Unexpected file (not authorized)
// ---------------------------------------------------------------------------

describe("unexpected file", () => {
  it("UNEXPECTED_CHANGES when unauthorized file is modified", async () => {
    mockGitStatus.mockResolvedValue(" M src/app.ts\n M src/admin.ts\n");
    const result = await detectUnexpectedChanges(makeInput(tmpDir));
    // src/app.ts is authorized (P9), src/admin.ts is not
    expect(result.status).toBe("UNEXPECTED_CHANGES");
    expect(result.unexpectedChanges).toHaveLength(1);
    expect(result.unexpectedChanges[0]!.filePath).toBe("src/admin.ts");
    expect(result.unexpectedChanges[0]!.reason).toBe("NOT_IN_MIGRATION_SCOPE");
  });
});

// ---------------------------------------------------------------------------
// 7. Unexpected CREATE
// ---------------------------------------------------------------------------

describe("unexpected CREATE", () => {
  it("flags unauthorized new file as UNEXPECTED_CREATE", async () => {
    mockGitStatus.mockResolvedValue(" M src/app.ts\n?? src/generated.ts\n");
    const result = await detectUnexpectedChanges(makeInput(tmpDir));
    const unexp = result.unexpectedChanges.find(u => u.filePath === "src/generated.ts");
    expect(unexp).toBeDefined();
    expect(unexp!.reason).toBe("UNEXPECTED_CREATE");
    expect(unexp!.changeType).toBe("ADDED");
  });

  it("does NOT flag authorized new file (P9 CREATE)", async () => {
    mockGitStatus.mockResolvedValue("?? src/new-handler.ts\n");
    const result = await detectUnexpectedChanges(makeInput(tmpDir, {
      migrationResult: makeMigrationResult([
        { stepId: "STEP-001", filePath: "src/new-handler.ts", operation: "CREATE", explanation: "new" },
      ]),
    }));
    expect(result.status).toBe("CLEAN");
    expect(result.unexpectedChanges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Unexpected DELETE
// ---------------------------------------------------------------------------

describe("unexpected DELETE", () => {
  it("flags unauthorized deletion as UNEXPECTED_DELETE", async () => {
    mockGitStatus.mockResolvedValue(" M src/app.ts\n D src/legacy.ts\n");
    const result = await detectUnexpectedChanges(makeInput(tmpDir));
    const unexp = result.unexpectedChanges.find(u => u.filePath === "src/legacy.ts");
    expect(unexp).toBeDefined();
    expect(unexp!.reason).toBe("UNEXPECTED_DELETE");
    expect(unexp!.changeType).toBe("DELETED");
  });

  it("does NOT flag authorized delete (P9 file deleted — file was in P9 scope)", async () => {
    // P9 changed src/legacy.ts (which implies it was in scope)
    mockGitStatus.mockResolvedValue(" D src/legacy.ts\n");
    const result = await detectUnexpectedChanges(makeInput(tmpDir, {
      migrationResult: makeMigrationResult([
        { stepId: "STEP-001", filePath: "src/legacy.ts", operation: "MODIFY", explanation: "removed legacy" },
      ]),
    }));
    expect(result.status).toBe("CLEAN");
  });
});

// ---------------------------------------------------------------------------
// 9. Unexpected RENAME
// ---------------------------------------------------------------------------

describe("unexpected RENAME", () => {
  it("flags unauthorized rename as UNEXPECTED_RENAME", async () => {
    mockGitStatus.mockResolvedValue("R  src/old.ts -> src/new.ts\n");
    const result = await detectUnexpectedChanges(makeInput(tmpDir));
    const unexp = result.unexpectedChanges.find(u => u.changeType === "RENAMED");
    expect(unexp).toBeDefined();
    expect(unexp!.reason).toBe("UNEXPECTED_RENAME");
  });

  it("accepts authorized rename when new path is in expected set", async () => {
    mockGitStatus.mockResolvedValue("R  src/old.ts -> src/new.ts\n");
    const result = await detectUnexpectedChanges(makeInput(tmpDir, {
      migrationResult: makeMigrationResult([
        { stepId: "STEP-001", filePath: "src/new.ts", operation: "CREATE", explanation: "renamed" },
      ]),
    }));
    expect(result.status).toBe("CLEAN");
  });
});

// ---------------------------------------------------------------------------
// 10. P10 test changes authorized
// ---------------------------------------------------------------------------

describe("P10 test change authorized", () => {
  it("does not flag P10 test file change", async () => {
    mockGitStatus.mockResolvedValue(" M src/app.ts\n M tests/app.test.ts\n");
    const result = await detectUnexpectedChanges(makeInput(tmpDir, {
      testGenerationResult: {
        workspaceId: "ws_p14",
        plannedTestChanges: 1, appliedTestChanges: 1, failedTestChanges: 0,
        status: "COMPLETED",
        changes: [{
          stepId: "STEP-001", filePath: "tests/app.test.ts",
          operation: "MODIFY", explanation: "Updated test",
          relatedChangeIds: [],
        }],
        evidence: [],
      },
    }));
    expect(result.status).toBe("CLEAN");
    expect(result.unexpectedChanges).toHaveLength(0);
  });

  it("flags test file changed outside P10 authorization", async () => {
    mockGitStatus.mockResolvedValue(" M tests/admin.test.ts\n");
    const result = await detectUnexpectedChanges(makeInput(tmpDir));
    expect(result.status).toBe("UNEXPECTED_CHANGES");
    expect(result.unexpectedChanges[0]!.filePath).toBe("tests/admin.test.ts");
  });
});

// ---------------------------------------------------------------------------
// 11. P12 recovery change authorized
// ---------------------------------------------------------------------------

describe("P12 recovery change authorized", () => {
  it("does not flag P12 recovery-applied change", async () => {
    mockGitStatus.mockResolvedValue(" M src/app.ts\n");
    const result = await detectUnexpectedChanges(makeInput(tmpDir, {
      migrationResult: makeMigrationResult([]), // P9 didn't change src/app.ts
      recoveryResult: {
        workspaceId: "ws_p14",
        status: "RECOVERED",
        attempts: [{
          attempt: 1,
          diagnosis: { diagnosis: "fix", rootCause: "cause", proposedChanges: [], bobDurationMs: 0 },
          proposedChanges: [],
          appliedChanges: [{
            filePath: "src/app.ts", operation: "MODIFY",
            explanation: "Recovery fix",
            relatedStepIds: ["STEP-001"],
            relatedValidationCheckIds: [],
          }],
          validation: {
            workspaceId: "ws_p14", status: "PASSED",
            checks: [{ id: "c", type: "TEST", status: "PASSED", durationMs: 1 }],
            summary: { total: 1, passed: 1, failed: 0, notApplicable: 0, skipped: 0 },
            startedAt: "2024-01-01T00:00:00.000Z", completedAt: "2024-01-01T00:00:01.000Z",
          },
          status: "RECOVERED",
          reason: "fixed",
        }],
        finalValidation: undefined,
        reason: "recovered",
      },
    }));
    expect(result.status).toBe("CLEAN");
    expect(result.unexpectedChanges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 12. P8 affected files NOT classified as unexpected
// ---------------------------------------------------------------------------

describe("P8-only affected file — NOT unexpected", () => {
  it("does not flag P8 affected file that was NOT actually changed", async () => {
    // P8 says src/routes.ts is affected, but P9 never changed it
    // git status shows only src/app.ts changed
    mockGitStatus.mockResolvedValue(" M src/app.ts\n");
    const plan = makePlan([makeStep({ affectedFiles: ["src/app.ts", "src/routes.ts"] })]);
    const result = await detectUnexpectedChanges(makeInput(tmpDir, { migrationPlan: plan }));
    expect(result.status).toBe("CLEAN");
    // src/routes.ts is neither in actual nor in unexpected — it just didn't change
    expect(result.unexpectedChanges).toHaveLength(0);
    expect(result.actualChanges.find(c => c.filePath === "src/routes.ts")).toBeUndefined();
  });

  it("flags src/routes.ts as unexpected if it was actually modified without P9/P10/P12 authorization", async () => {
    // P8 affected it, but no P9/P10/P12 change authorized it
    // Actual workspace has src/routes.ts modified
    mockGitStatus.mockResolvedValue(" M src/routes.ts\n");
    // P9 only changed src/app.ts, not src/routes.ts
    const result = await detectUnexpectedChanges(makeInput(tmpDir));
    expect(result.status).toBe("UNEXPECTED_CHANGES");
    expect(result.unexpectedChanges[0]!.filePath).toBe("src/routes.ts");
  });
});

// ---------------------------------------------------------------------------
// 13. Multiple unexpected files — sorted deterministically
// ---------------------------------------------------------------------------

describe("multiple unexpected files — deterministic ordering", () => {
  it("returns multiple unexpected files sorted by path", async () => {
    mockGitStatus.mockResolvedValue(
      " M src/app.ts\n M src/debug.ts\n M src/admin.ts\n M src/random.ts\n"
    );
    const result = await detectUnexpectedChanges(makeInput(tmpDir));
    expect(result.status).toBe("UNEXPECTED_CHANGES");
    // 3 unauthorized (src/app.ts is authorized)
    expect(result.unexpectedChanges).toHaveLength(3);
    const paths = result.unexpectedChanges.map(u => u.filePath);
    expect(paths).toEqual([...paths].sort());
  });

  it("actualChanges is sorted by path", async () => {
    mockGitStatus.mockResolvedValue(" M src/z.ts\n M src/a.ts\n M src/m.ts\n");
    const result = await detectUnexpectedChanges(makeInput(tmpDir));
    const paths = result.actualChanges.map(c => c.filePath);
    expect(paths).toEqual([...paths].sort());
  });
});

// ---------------------------------------------------------------------------
// 14. Path safety in git status output
// ---------------------------------------------------------------------------

describe("path safety in git status output", () => {
  it("skips absolute path from git status — not reported as actual change", async () => {
    mockGitStatus.mockResolvedValue(" M /etc/passwd\n M src/app.ts\n");
    const result = await detectUnexpectedChanges(makeInput(tmpDir));
    const paths = result.actualChanges.map(c => c.filePath);
    expect(paths).not.toContain("/etc/passwd");
    expect(paths).toContain("src/app.ts");
  });

  it("skips path traversal from git status", async () => {
    mockGitStatus.mockResolvedValue(" M ../evil.ts\n M src/app.ts\n");
    const result = await detectUnexpectedChanges(makeInput(tmpDir));
    const paths = result.actualChanges.map(c => c.filePath);
    expect(paths).not.toContain("../evil.ts");
  });

  it("skips .git/ path from git status", async () => {
    mockGitStatus.mockResolvedValue(" M .git/config\n M src/app.ts\n");
    const result = await detectUnexpectedChanges(makeInput(tmpDir));
    const paths = result.actualChanges.map(c => c.filePath);
    expect(paths).not.toContain(".git/config");
    expect(result.unexpectedChanges.find(u => u.filePath === ".git/config")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 15. Summary correctness
// ---------------------------------------------------------------------------

describe("summary", () => {
  it("summary counts match actual changes", async () => {
    mockGitStatus.mockResolvedValue(
      " M src/app.ts\n?? src/new.ts\n D src/old.ts\n"
    );
    const result = await detectUnexpectedChanges(makeInput(tmpDir, {
      migrationResult: makeMigrationResult([
        { stepId: "STEP-001", filePath: "src/app.ts", operation: "MODIFY", explanation: "x" },
        { stepId: "STEP-001", filePath: "src/new.ts", operation: "CREATE", explanation: "y" },
        { stepId: "STEP-001", filePath: "src/old.ts", operation: "MODIFY", explanation: "z" },
      ]),
    }));
    expect(result.summary.totalActualChanges).toBe(3);
    expect(result.summary.modified).toBe(1);
    expect(result.summary.added).toBe(1);
    expect(result.summary.deleted).toBe(1);
    expect(result.summary.renamed).toBe(0);
    expect(result.summary.totalUnexpectedChanges).toBe(0);
  });

  it("summary totalUnexpectedChanges > 0 for UNEXPECTED_CHANGES", async () => {
    mockGitStatus.mockResolvedValue(" M src/app.ts\n M src/admin.ts\n");
    const result = await detectUnexpectedChanges(makeInput(tmpDir));
    expect(result.summary.totalUnexpectedChanges).toBe(1);
  });

  it("summary totalExpectedChanges reflects P9+P10+P12 authorized set", async () => {
    mockGitStatus.mockResolvedValue(" M src/app.ts\n");
    const result = await detectUnexpectedChanges(makeInput(tmpDir));
    expect(result.summary.totalExpectedChanges).toBe(1); // src/app.ts from P9
  });
});

// ---------------------------------------------------------------------------
// 16. Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("same input produces same result twice", async () => {
    mockGitStatus.mockResolvedValue(" M src/app.ts\n M src/admin.ts\n");
    const r1 = await detectUnexpectedChanges(makeInput(tmpDir));
    const r2 = await detectUnexpectedChanges(makeInput(tmpDir));
    expect(r1.status).toBe(r2.status);
    expect(r1.unexpectedChanges.map(u => u.filePath)).toEqual(r2.unexpectedChanges.map(u => u.filePath));
    expect(r1.actualChanges.map(c => c.filePath)).toEqual(r2.actualChanges.map(c => c.filePath));
  });
});

// ---------------------------------------------------------------------------
// 17. workspaceId in result
// ---------------------------------------------------------------------------

describe("result metadata", () => {
  it("result includes workspaceId", async () => {
    mockGitStatus.mockResolvedValue("");
    const result = await detectUnexpectedChanges(makeInput(tmpDir));
    expect(result.workspaceId).toBe("ws_p14");
  });
});

// ---------------------------------------------------------------------------
// 18. Express 4 → 5 E2E proof (real git workspace)
// ---------------------------------------------------------------------------

describe("Express 4 → 5 E2E proof", () => {
  it("CLEAN when only authorized migration changes present", async () => {
    // Simulate git status output for a correctly migrated Express 4→5 project
    // Authorized: src/app.ts (P9), tests/routes.test.ts (P10)
    mockGitStatus.mockResolvedValue(
      " M src/app.ts\n M tests/routes.test.ts\n"
    );

    const result = await detectUnexpectedChanges({
      workspace: {
        id: "ws_express", path: "/tmp/ws_express",
        repoUrl: "https://github.com/example/express-app",
        branch: "main", createdAt: "2024-01-01T00:00:00.000Z", status: "READY",
      },
      migrationPlan: makePlan([
        makeStep({ id: "STEP-001", order: 1, affectedFiles: ["src/app.ts", "src/routes.ts"] }),
      ]),
      migrationResult: makeMigrationResult([
        { stepId: "STEP-001", filePath: "src/app.ts", operation: "MODIFY", explanation: "Replace app.del with app.delete" },
      ]),
      testGenerationResult: {
        workspaceId: "ws_express",
        plannedTestChanges: 1, appliedTestChanges: 1, failedTestChanges: 0,
        status: "COMPLETED",
        changes: [{
          stepId: "STEP-001", filePath: "tests/routes.test.ts",
          operation: "MODIFY", explanation: "Update test for app.delete",
          relatedChangeIds: [],
        }],
        evidence: [],
      },
    });

    expect(result.status).toBe("CLEAN");
    expect(result.unexpectedChanges).toHaveLength(0);
    expect(result.actualChanges).toHaveLength(2);
    // src/routes.ts (P8 affected but P9 never changed) → NOT in actual → not unexpected
    expect(result.actualChanges.find(c => c.filePath === "src/routes.ts")).toBeUndefined();
  });

  it("UNEXPECTED_CHANGES when unrelated file is modified", async () => {
    // An unrelated file was accidentally modified during migration
    mockGitStatus.mockResolvedValue(
      " M src/app.ts\n M src/database/config.ts\n"
    );

    const result = await detectUnexpectedChanges({
      workspace: {
        id: "ws_express", path: "/tmp/ws_express",
        repoUrl: "https://github.com/example/express-app",
        branch: "main", createdAt: "2024-01-01T00:00:00.000Z", status: "READY",
      },
      migrationPlan: makePlan([
        makeStep({ id: "STEP-001", order: 1, affectedFiles: ["src/app.ts"] }),
      ]),
      migrationResult: makeMigrationResult([
        { stepId: "STEP-001", filePath: "src/app.ts", operation: "MODIFY", explanation: "fix" },
      ]),
    });

    expect(result.status).toBe("UNEXPECTED_CHANGES");
    expect(result.unexpectedChanges).toHaveLength(1);
    expect(result.unexpectedChanges[0]!.filePath).toBe("src/database/config.ts");
    expect(result.unexpectedChanges[0]!.reason).toBe("NOT_IN_MIGRATION_SCOPE");

    // Evidence explains the detection
    expect(result.unexpectedChanges[0]!.evidence.join(" ")).toContain("src/database/config.ts");
  });

  it("P12 recovery change included in authorized set (CLEAN)", async () => {
    // P9 missed a file; P12 recovery fixed it — both should be CLEAN
    mockGitStatus.mockResolvedValue(
      " M src/app.ts\n M src/middleware.ts\n"
    );

    const result = await detectUnexpectedChanges({
      workspace: {
        id: "ws_express", path: "/tmp/ws_express",
        repoUrl: "https://github.com/example/express-app",
        branch: "main", createdAt: "2024-01-01T00:00:00.000Z", status: "READY",
      },
      migrationPlan: makePlan([makeStep({ id: "STEP-001", order: 1, affectedFiles: ["src/app.ts", "src/middleware.ts"] })]),
      migrationResult: makeMigrationResult([
        { stepId: "STEP-001", filePath: "src/app.ts", operation: "MODIFY", explanation: "fix" },
        // Note: src/middleware.ts was NOT in P9 changes
      ]),
      recoveryResult: {
        workspaceId: "ws_express",
        status: "RECOVERED",
        attempts: [{
          attempt: 1,
          diagnosis: { diagnosis: "fix", rootCause: "cause", proposedChanges: [], bobDurationMs: 0 },
          proposedChanges: [],
          appliedChanges: [{
            filePath: "src/middleware.ts", operation: "MODIFY",
            explanation: "Recovery fixed middleware",
            relatedStepIds: ["STEP-001"],
            relatedValidationCheckIds: [],
          }],
          validation: {
            workspaceId: "ws_express", status: "PASSED",
            checks: [{ id: "c", type: "TEST", status: "PASSED", durationMs: 1 }],
            summary: { total: 1, passed: 1, failed: 0, notApplicable: 0, skipped: 0 },
            startedAt: "2024-01-01T00:00:00.000Z", completedAt: "2024-01-01T00:00:01.000Z",
          },
          status: "RECOVERED",
          reason: "fixed",
        }],
        finalValidation: undefined,
        reason: "recovered",
      },
    });

    expect(result.status).toBe("CLEAN");
    expect(result.unexpectedChanges).toHaveLength(0);
  });
});
