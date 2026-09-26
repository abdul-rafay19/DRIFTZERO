/**
 * P17 Diff Intelligence — comprehensive test suite.
 *
 * Covers:
 *  - Diff parser (empty, modified, added, deleted, renamed, binary, malformed, CRLF, limits)
 *  - File classifier (all categories, nested paths)
 *  - Change correlation (P8/P9/P10/P12/P14/P15)
 *  - Statistics / summary
 *  - Determinism
 *  - Secret safety (redaction)
 *  - Limits (truncation → PARTIAL)
 *  - Empty diff proof
 *  - P16 boundary
 *  - Express 4→5 proof fixture
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Mock P3 git functions
// ---------------------------------------------------------------------------

vi.mock("../../workspace/clone.js", () => ({
  gitDiff: vi.fn(),
  gitStatus: vi.fn(),
}));

import { gitDiff } from "../../workspace/clone.js";

// ---------------------------------------------------------------------------
// Import modules under test
// ---------------------------------------------------------------------------

import {
  parseDiff,
  safeLineContent,
  MAX_HUNKS_PER_FILE,
  MAX_CHANGED_LINES_PER_FILE,
  type ParsedDiffFile,
} from "./diff-parser.js";
import { classifyFile, deriveChangeCategory, isPathSafe } from "./change-classifier.js";
import { correlateFile, buildPlanStepCategoryMap } from "./change-correlation.js";
import { runDiffIntelligence } from "./diff-intelligence.js";
import type {
  DiffIntelligenceInput,
  Workspace,
  MigrationPlan,
  CodeMigrationResult,
} from "@driftzero/shared";

// ---------------------------------------------------------------------------
// Diff fixtures
// ---------------------------------------------------------------------------

const EMPTY_DIFF = "";

const MODIFIED_FILE_DIFF = `diff --git a/src/app.ts b/src/app.ts
index abc1234..def5678 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,5 +1,5 @@
 import express from 'express';
-const app = express();
+const app = express({ strict: true });
 app.use(express.json());
 app.listen(3000);
`;

const ADDED_FILE_DIFF = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+export const x = 1;
+export const y = 2;
+export const z = 3;
`;

const DELETED_FILE_DIFF = `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index abc1234..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export const a = 1;
-export const b = 2;
-export const c = 3;
`;

const RENAMED_FILE_DIFF = `diff --git a/src/utils.ts b/src/helpers.ts
similarity index 95%
rename from src/utils.ts
rename to src/helpers.ts
index abc1234..def5678 100644
--- a/src/utils.ts
+++ b/src/helpers.ts
@@ -1,3 +1,3 @@
-export function helper() {}
+export function utilHelper() {}
 export const x = 1;
`;

const BINARY_FILE_DIFF = `diff --git a/assets/logo.png b/assets/logo.png
index abc1234..def5678 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
`;

const MULTI_FILE_DIFF = `diff --git a/src/app.ts b/src/app.ts
index abc1234..def5678 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
-const app = express();
+const app = express({ strict: true });
 export default app;
diff --git a/package.json b/package.json
index abc1234..def5678 100644
--- a/package.json
+++ b/package.json
@@ -1,5 +1,5 @@
 {
-  "express": "^4.18.0"
+  "express": "^5.0.0"
 }
`;

const MULTI_HUNK_DIFF = `diff --git a/src/router.ts b/src/router.ts
index abc1234..def5678 100644
--- a/src/router.ts
+++ b/src/router.ts
@@ -1,5 +1,5 @@
-import { Router } from 'express';
+import { Router, Request, Response } from 'express';
 
 const router = Router();
@@ -20,3 +20,4 @@
 router.get('/ping', (_req, res) => {
-  res.send('pong');
+  res.json({ pong: true });
+  // Express 5 uses res.json
 });
`;

const CRLF_DIFF = `diff --git a/src/app.ts b/src/app.ts\r\nindex abc1234..def5678 100644\r\n--- a/src/app.ts\r\n+++ b/src/app.ts\r\n@@ -1,3 +1,3 @@\r\n-const x = 1;\r\n+const x = 2;\r\n`;

const MALFORMED_HUNK_DIFF = `diff --git a/src/app.ts b/src/app.ts
index abc1234..def5678 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ THIS_IS_NOT_A_VALID_HUNK_HEADER @@
+some content
`;

// ---------------------------------------------------------------------------
// Helper builders
// ---------------------------------------------------------------------------

function makeWorkspace(path: string): Workspace {
  return {
    id: "ws_test_p17",
    repoUrl: "https://github.com/example/repo",
    path,
    branch: "main",
    createdAt: new Date().toISOString(),
    status: "READY",
  };
}

function makePlan(): MigrationPlan {
  return {
    packageName: "express",
    sourceVersion: "express@4",
    targetVersion: "express@5",
    objective: "Migrate Express 4 to Express 5",
    prerequisites: [],
    steps: [
      {
        id: "STEP-001",
        order: 1,
        title: "Update dependency",
        description: "Bump express version",
        category: "DEPENDENCY",
        affectedFiles: ["package.json"],
        relatedChangeIds: [],
        relatedRequirementIds: [],
        reason: "Version upgrade",
        risk: "LOW",
        dependencies: [],
      },
      {
        id: "STEP-002",
        order: 2,
        title: "Update app middleware",
        description: "Update app.ts for Express 5",
        category: "MIDDLEWARE",
        affectedFiles: ["src/app.ts"],
        relatedChangeIds: [],
        relatedRequirementIds: [],
        reason: "API changed",
        risk: "MEDIUM",
        dependencies: ["STEP-001"],
      },
    ],
    validationRequirements: [],
    affectedAreas: [],
    risk: { score: 30, level: "LOW" },
    generatedAt: new Date().toISOString(),
  };
}

function makeMigrationResult(workspaceId = "ws_test_p17"): CodeMigrationResult {
  return {
    workspaceId,
    planSteps: 2,
    completedSteps: 2,
    failedSteps: 0,
    status: "COMPLETED",
    changes: [
      { stepId: "STEP-001", filePath: "package.json", operation: "MODIFY", explanation: "Bumped express" },
      { stepId: "STEP-002", filePath: "src/app.ts", operation: "MODIFY", explanation: "Updated middleware" },
    ],
    evidence: [],
  };
}

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dz-p17-test-"));
}

function makeMinimalInput(workspacePath: string): DiffIntelligenceInput {
  return {
    workspace: makeWorkspace(workspacePath),
  };
}

// ---------------------------------------------------------------------------
// ============================================================
// DIFF PARSER TESTS
// ============================================================
// ---------------------------------------------------------------------------

describe("parseDiff", () => {
  it("returns empty array for empty string", () => {
    expect(parseDiff("")).toHaveLength(0);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(parseDiff("   \n  ")).toHaveLength(0);
  });

  it("parses a modified file", () => {
    const result = parseDiff(MODIFIED_FILE_DIFF);
    expect(result).toHaveLength(1);
    expect(result[0]!.filePath).toBe("src/app.ts");
    expect(result[0]!.changeType).toBe("MODIFIED");
    expect(result[0]!.binary).toBe(false);
  });

  it("counts additions and deletions for modified file", () => {
    const result = parseDiff(MODIFIED_FILE_DIFF);
    expect(result[0]!.additions).toBe(1);
    expect(result[0]!.deletions).toBe(1);
  });

  it("parses an added file", () => {
    const result = parseDiff(ADDED_FILE_DIFF);
    expect(result[0]!.changeType).toBe("ADDED");
    expect(result[0]!.additions).toBe(3);
    expect(result[0]!.deletions).toBe(0);
  });

  it("parses a deleted file", () => {
    const result = parseDiff(DELETED_FILE_DIFF);
    expect(result[0]!.changeType).toBe("DELETED");
    expect(result[0]!.additions).toBe(0);
    expect(result[0]!.deletions).toBe(3);
  });

  it("parses a renamed file", () => {
    const result = parseDiff(RENAMED_FILE_DIFF);
    expect(result[0]!.changeType).toBe("RENAMED");
    expect(result[0]!.filePath).toBe("src/helpers.ts");
    expect(result[0]!.oldPath).toBe("src/utils.ts");
  });

  it("parses binary file without crashing", () => {
    const result = parseDiff(BINARY_FILE_DIFF);
    expect(result[0]!.binary).toBe(true);
    expect(result[0]!.additions).toBe(0);
    expect(result[0]!.deletions).toBe(0);
    expect(result[0]!.filePath).toBe("assets/logo.png");
  });

  it("parses multiple files", () => {
    const result = parseDiff(MULTI_FILE_DIFF);
    expect(result).toHaveLength(2);
    const paths = result.map((r) => r.filePath);
    expect(paths).toContain("src/app.ts");
    expect(paths).toContain("package.json");
  });

  it("parses multiple hunks", () => {
    const result = parseDiff(MULTI_HUNK_DIFF);
    expect(result[0]!.hunks.length).toBe(2);
  });

  it("normalizes CRLF line endings", () => {
    const result = parseDiff(CRLF_DIFF);
    expect(result).toHaveLength(1);
    expect(result[0]!.filePath).toBe("src/app.ts");
    expect(result[0]!.additions).toBe(1);
    expect(result[0]!.deletions).toBe(1);
  });

  it("skips malformed hunk header gracefully (does not crash)", () => {
    const result = parseDiff(MALFORMED_HUNK_DIFF);
    // Should parse the file block but find no valid hunks
    expect(result).toHaveLength(1);
    expect(result[0]!.hunks.length).toBe(0);
  });

  it("returns empty array for diff with no recognizable file blocks", () => {
    const result = parseDiff("This is not a git diff at all\nJust some text\n");
    expect(result).toHaveLength(0);
  });

  it("hunk lines include +/- prefix character", () => {
    const result = parseDiff(MODIFIED_FILE_DIFF);
    const hunkLines = result[0]!.hunks[0]!.lines;
    expect(hunkLines.some((l) => l.startsWith("+") || l.startsWith("-"))).toBe(true);
  });

  it("truncates when hunks exceed MAX_HUNKS_PER_FILE", () => {
    // Build a diff with more than MAX_HUNKS_PER_FILE hunks
    let diffStr = `diff --git a/big.ts b/big.ts\nindex abc..def 100644\n--- a/big.ts\n+++ b/big.ts\n`;
    for (let i = 0; i < MAX_HUNKS_PER_FILE + 5; i++) {
      diffStr += `@@ -${i * 10 + 1},3 +${i * 10 + 1},3 @@\n-old line ${i}\n+new line ${i}\n`;
    }
    const result = parseDiff(diffStr);
    expect(result[0]!.truncated).toBe(true);
    expect(result[0]!.hunks.length).toBeLessThanOrEqual(MAX_HUNKS_PER_FILE);
  });

  it("truncates when changed lines exceed MAX_CHANGED_LINES_PER_FILE", () => {
    let diffStr = `diff --git a/big.ts b/big.ts\nindex abc..def 100644\n--- a/big.ts\n+++ b/big.ts\n@@ -1,${MAX_CHANGED_LINES_PER_FILE + 10} +1,${MAX_CHANGED_LINES_PER_FILE + 10} @@\n`;
    for (let i = 0; i < MAX_CHANGED_LINES_PER_FILE + 10; i++) {
      diffStr += `+new line ${i}\n`;
    }
    const result = parseDiff(diffStr);
    expect(result[0]!.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// safeLineContent tests
// ---------------------------------------------------------------------------

describe("safeLineContent", () => {
  it("returns content unchanged for normal lines", () => {
    const line = "+const x = 1;";
    expect(safeLineContent(line)).toBe("+const x = 1;");
  });

  it("truncates very long lines", () => {
    const longLine = "+" + "a".repeat(250);
    const result = safeLineContent(longLine);
    expect(result.length).toBeLessThanOrEqual(205); // 200 + ellipsis
    expect(result.endsWith("…")).toBe(true);
  });

  it("redacts API key assignment", () => {
    const line = `+const API_KEY = "sk_live_abcdefgh1234567890abcd";`;
    const result = safeLineContent(line);
    expect(result).not.toContain("sk_live_abcdefgh1234567890abcd");
    expect(result).toContain("****");
  });

  it("redacts token assignment", () => {
    const line = `+const token = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abc.def";`;
    // token field should be redacted
    expect(safeLineContent(line)).toContain("****");
  });

  it("redacts GitHub PAT", () => {
    const line = `+const TOKEN = "ghp_A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7";`;
    const result = safeLineContent(line);
    expect(result).not.toContain("ghp_A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7");
  });

  it("redacts PEM private key header", () => {
    const line = "+-----BEGIN RSA PRIVATE KEY-----";
    const result = safeLineContent(line);
    expect(result).not.toContain("RSA PRIVATE KEY");
  });

  it("does not redact normal code", () => {
    const line = `+const x = require('express');`;
    expect(safeLineContent(line)).toBe(`+const x = require('express');`);
  });
});

// ---------------------------------------------------------------------------
// ============================================================
// FILE CLASSIFIER TESTS
// ============================================================
// ---------------------------------------------------------------------------

describe("classifyFile", () => {
  it("src/app.ts → SOURCE", () => expect(classifyFile("src/app.ts")).toBe("SOURCE"));
  it("src/index.js → SOURCE", () => expect(classifyFile("src/index.js")).toBe("SOURCE"));
  it("src/app.tsx → SOURCE", () => expect(classifyFile("src/app.tsx")).toBe("SOURCE"));
  it("src/app.test.ts → TEST", () => expect(classifyFile("src/app.test.ts")).toBe("TEST"));
  it("src/app.spec.ts → TEST", () => expect(classifyFile("src/app.spec.ts")).toBe("TEST"));
  it("src/__tests__/app.ts → TEST", () => expect(classifyFile("src/__tests__/app.ts")).toBe("TEST"));
  it("test/integration.ts → TEST", () => expect(classifyFile("test/integration.ts")).toBe("TEST"));
  it("package.json → DEPENDENCY", () => expect(classifyFile("package.json")).toBe("DEPENDENCY"));
  it("pnpm-lock.yaml → DEPENDENCY", () => expect(classifyFile("pnpm-lock.yaml")).toBe("DEPENDENCY"));
  it("package-lock.json → DEPENDENCY", () => expect(classifyFile("package-lock.json")).toBe("DEPENDENCY"));
  it("yarn.lock → DEPENDENCY", () => expect(classifyFile("yarn.lock")).toBe("DEPENDENCY"));
  it("tsconfig.json → CONFIG", () => expect(classifyFile("tsconfig.json")).toBe("CONFIG"));
  it("tsconfig.base.json → CONFIG", () => expect(classifyFile("tsconfig.base.json")).toBe("CONFIG"));
  it(".eslintrc.js → CONFIG", () => expect(classifyFile(".eslintrc.js")).toBe("CONFIG"));
  it("vitest.config.ts → CONFIG", () => expect(classifyFile("vitest.config.ts")).toBe("CONFIG"));
  it("README.md → DOCUMENTATION", () => expect(classifyFile("README.md")).toBe("DOCUMENTATION"));
  it("CHANGELOG.md → DOCUMENTATION", () => expect(classifyFile("CHANGELOG.md")).toBe("DOCUMENTATION"));
  it("LICENSE → DOCUMENTATION", () => expect(classifyFile("LICENSE")).toBe("DOCUMENTATION"));
  it("something.xyz → OTHER", () => expect(classifyFile("something.xyz")).toBe("OTHER"));

  it("nested test file → TEST", () => {
    expect(classifyFile("packages/core/src/__tests__/utils.test.ts")).toBe("TEST");
  });

  it("nested source file → SOURCE", () => {
    expect(classifyFile("packages/core/src/utils.ts")).toBe("SOURCE");
  });
});

// ---------------------------------------------------------------------------
// isPathSafe tests
// ---------------------------------------------------------------------------

describe("isPathSafe", () => {
  it("relative path → safe", () => expect(isPathSafe("src/app.ts")).toBe(true));
  it("absolute path → unsafe", () => expect(isPathSafe("/etc/passwd")).toBe(false));
  it("traversal → unsafe", () => expect(isPathSafe("../foo/bar")).toBe(false));
  it(".git/ → unsafe", () => expect(isPathSafe(".git/config")).toBe(false));
  it("empty string → unsafe", () => expect(isPathSafe("")).toBe(false));
});

// ---------------------------------------------------------------------------
// ============================================================
// CHANGE CORRELATION TESTS
// ============================================================
// ---------------------------------------------------------------------------

describe("correlateFile", () => {
  const plan = makePlan();

  it("exact P8 affected file → correct step ID", () => {
    const corr = correlateFile("package.json", { plan });
    expect(corr.correlationType).toBe("CORRELATED");
    expect(corr.planStepIds).toContain("STEP-001");
  });

  it("file in multiple steps → all step IDs returned", () => {
    const multiPlan = {
      ...plan,
      steps: [
        ...plan.steps,
        { ...plan.steps[1]!, id: "STEP-003", affectedFiles: ["src/app.ts"] },
      ],
    };
    const corr = correlateFile("src/app.ts", { plan: multiPlan as typeof plan });
    expect(corr.planStepIds).toContain("STEP-002");
    expect(corr.planStepIds).toContain("STEP-003");
  });

  it("no matching step → UNCORRELATED", () => {
    const corr = correlateFile("src/unrelated.ts", { plan });
    expect(corr.correlationType).toBe("UNCORRELATED");
    expect(corr.planStepIds).toHaveLength(0);
  });

  it("P9 migration evidence correlation", () => {
    const mr = makeMigrationResult();
    const corr = correlateFile("src/app.ts", { plan, migrationResult: mr });
    expect(corr.migrationEvidenceIds.length).toBeGreaterThan(0);
    expect(corr.migrationEvidenceIds[0]).toContain("src/app.ts");
    expect(corr.origin).toBe("MIGRATION");
  });

  it("P10 test evidence correlation", () => {
    const tgr = {
      workspaceId: "ws_test",
      plannedTestChanges: 1, appliedTestChanges: 1, failedTestChanges: 0,
      status: "COMPLETED" as const,
      changes: [{ stepId: "STEP-002", filePath: "src/app.test.ts", operation: "MODIFY" as const, explanation: "Updated test", relatedChangeIds: [] }],
      evidence: [],
    };
    const corr = correlateFile("src/app.test.ts", { testGenerationResult: tgr });
    expect(corr.testEvidenceIds.length).toBeGreaterThan(0);
    expect(corr.origin).toBe("TEST_GENERATION");
  });

  it("P12 recovery evidence correlation", () => {
    const rr = {
      workspaceId: "ws_test", status: "RECOVERED" as const, reason: "Fixed",
      attempts: [{
        attempt: 1, status: "RECOVERED" as const,
        appliedChanges: [{ filePath: "src/app.ts", operation: "MODIFY" as const, explanation: "Fixed", relatedStepIds: [], relatedValidationCheckIds: [] }],
        proposedChanges: [],
        diagnosis: { diagnosis: "d", rootCause: "r", proposedChanges: [], bobDurationMs: 100 },
        validation: { workspaceId: "ws_test", status: "PASSED" as const, checks: [], summary: { total: 0, passed: 0, failed: 0, notApplicable: 0, skipped: 0 }, startedAt: "", completedAt: "" },
        reason: "ok",
      }],
    };
    const corr = correlateFile("src/app.ts", { recoveryResult: rr });
    expect(corr.recoveryEvidenceIds.length).toBeGreaterThan(0);
    expect(corr.origin).toBe("RECOVERY");
  });

  it("P14 unexpected change correlation", () => {
    const uc = {
      workspaceId: "ws_test",
      status: "UNEXPECTED_CHANGES" as const,
      actualChanges: [{ filePath: "src/evil.ts", changeType: "MODIFIED" as const }],
      expectedChanges: [],
      unexpectedChanges: [{ filePath: "src/evil.ts", changeType: "MODIFIED" as const, reason: "NOT_IN_MIGRATION_SCOPE" as const, evidence: ["Unauthorized"] }],
      summary: { totalActualChanges: 1, totalExpectedChanges: 0, totalUnexpectedChanges: 1, added: 0, modified: 1, deleted: 0, renamed: 0 },
    };
    const corr = correlateFile("src/evil.ts", { unexpectedChanges: uc });
    expect(corr.unexpectedChange).toBe(true);
  });

  it("P15 security finding correlation by filePath", () => {
    const sec = {
      workspaceId: "ws_test", status: "FINDINGS" as const,
      findings: [{ id: "SEC-001", category: "SECRET" as const, severity: "HIGH" as const, title: "Token", description: "desc", filePath: "src/auth.ts", evidence: [], source: "DETERMINISTIC" as const }],
      summary: { totalFindings: 1, critical: 0, high: 1, medium: 0, low: 0, secretsDetected: 1, dependencyFindings: 0, codeFindings: 0, configurationFindings: 0, aiReviewFindings: 0 },
      checks: [],
      startedAt: "", completedAt: "",
    };
    const corr = correlateFile("src/auth.ts", { security: sec });
    expect(corr.securityFindingIds).toContain("SEC-001");
  });

  it("P15 finding NOT correlated to different file", () => {
    const sec = {
      workspaceId: "ws_test", status: "FINDINGS" as const,
      findings: [{ id: "SEC-001", category: "SECRET" as const, severity: "HIGH" as const, title: "Token", description: "desc", filePath: "src/auth.ts", evidence: [], source: "DETERMINISTIC" as const }],
      summary: { totalFindings: 1, critical: 0, high: 1, medium: 0, low: 0, secretsDetected: 1, dependencyFindings: 0, codeFindings: 0, configurationFindings: 0, aiReviewFindings: 0 },
      checks: [], startedAt: "", completedAt: "",
    };
    const corr = correlateFile("src/other.ts", { security: sec });
    expect(corr.securityFindingIds).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildPlanStepCategoryMap tests
// ---------------------------------------------------------------------------

describe("buildPlanStepCategoryMap", () => {
  it("returns empty map for undefined plan", () => {
    const map = buildPlanStepCategoryMap(undefined);
    expect(map.size).toBe(0);
  });

  it("maps file → step categories", () => {
    const map = buildPlanStepCategoryMap(makePlan());
    expect(map.get("package.json")).toContain("DEPENDENCY");
    expect(map.get("src/app.ts")).toContain("MIDDLEWARE");
  });
});

// ---------------------------------------------------------------------------
// ============================================================
// FULL ENGINE TESTS (with mocked gitDiff)
// ============================================================
// ---------------------------------------------------------------------------

describe("runDiffIntelligence", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    vi.resetAllMocks();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ---- Empty diff proof ----

  it("empty diff → ANALYZED with zero counts", async () => {
    vi.mocked(gitDiff).mockResolvedValueOnce(EMPTY_DIFF);
    const result = await runDiffIntelligence(makeMinimalInput(tmpDir));
    expect(result.status).toBe("ANALYZED");
    expect(result.files).toHaveLength(0);
    expect(result.statistics.filesChanged).toBe(0);
    expect(result.statistics.totalAdditions).toBe(0);
    expect(result.summary.filesChanged).toBe(0);
  });

  // ---- Basic file analysis ----

  it("modified file → correct file analysis", async () => {
    vi.mocked(gitDiff).mockResolvedValueOnce(MODIFIED_FILE_DIFF);
    const result = await runDiffIntelligence(makeMinimalInput(tmpDir));
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.filePath).toBe("src/app.ts");
    expect(result.files[0]!.changeType).toBe("MODIFIED");
    expect(result.files[0]!.additions).toBe(1);
    expect(result.files[0]!.deletions).toBe(1);
    expect(result.files[0]!.category).toBe("SOURCE");
  });

  it("added file → changeType ADDED", async () => {
    vi.mocked(gitDiff).mockResolvedValueOnce(ADDED_FILE_DIFF);
    const result = await runDiffIntelligence(makeMinimalInput(tmpDir));
    expect(result.files[0]!.changeType).toBe("ADDED");
    expect(result.statistics.filesAdded).toBe(1);
  });

  it("deleted file → changeType DELETED", async () => {
    vi.mocked(gitDiff).mockResolvedValueOnce(DELETED_FILE_DIFF);
    const result = await runDiffIntelligence(makeMinimalInput(tmpDir));
    expect(result.files[0]!.changeType).toBe("DELETED");
    expect(result.statistics.filesDeleted).toBe(1);
  });

  it("renamed file → preserves oldPath", async () => {
    vi.mocked(gitDiff).mockResolvedValueOnce(RENAMED_FILE_DIFF);
    const result = await runDiffIntelligence(makeMinimalInput(tmpDir));
    expect(result.files[0]!.changeType).toBe("RENAMED");
    expect(result.files[0]!.oldPath).toBe("src/utils.ts");
    expect(result.statistics.filesRenamed).toBe(1);
  });

  it("binary file → binary = true, no content crash", async () => {
    vi.mocked(gitDiff).mockResolvedValueOnce(BINARY_FILE_DIFF);
    const result = await runDiffIntelligence(makeMinimalInput(tmpDir));
    expect(result.files[0]!.binary).toBe(true);
    expect(result.files[0]!.filePath).toBe("assets/logo.png");
  });

  // ---- Migration plan correlation ----

  it("correlates file to P8 plan step", async () => {
    vi.mocked(gitDiff).mockResolvedValueOnce(MULTI_FILE_DIFF);
    const input: DiffIntelligenceInput = {
      workspace: makeWorkspace(tmpDir),
      migrationPlan: makePlan(),
      migrationResult: makeMigrationResult(),
    };
    const result = await runDiffIntelligence(input);
    const appFile = result.files.find((f) => f.filePath === "src/app.ts");
    expect(appFile?.relatedPlanSteps).toContain("STEP-002");
    expect(appFile?.migrationRelated).toBe(true);
  });

  it("marks file as CORRELATED when P8 plan covers it", async () => {
    vi.mocked(gitDiff).mockResolvedValueOnce(MULTI_FILE_DIFF);
    const input: DiffIntelligenceInput = {
      workspace: makeWorkspace(tmpDir),
      migrationPlan: makePlan(),
    };
    const result = await runDiffIntelligence(input);
    const pkgCorr = result.correlations.find((c) => c.filePath === "package.json");
    expect(pkgCorr?.correlationType).toBe("CORRELATED");
  });

  it("marks uncorrelated file explicitly", async () => {
    vi.mocked(gitDiff).mockResolvedValueOnce(ADDED_FILE_DIFF); // src/new.ts not in plan
    const input: DiffIntelligenceInput = {
      workspace: makeWorkspace(tmpDir),
      migrationPlan: makePlan(),
    };
    const result = await runDiffIntelligence(input);
    expect(result.correlations[0]?.correlationType).toBe("UNCORRELATED");
    expect(result.statistics.uncorrelatedFiles).toBe(1);
  });

  // ---- P14 integration ----

  it("marks unexpected file from P14", async () => {
    vi.mocked(gitDiff).mockResolvedValueOnce(ADDED_FILE_DIFF);
    const input: DiffIntelligenceInput = {
      workspace: makeWorkspace(tmpDir),
      unexpectedChanges: {
        workspaceId: "ws_test_p17",
        status: "UNEXPECTED_CHANGES",
        actualChanges: [{ filePath: "src/new.ts", changeType: "ADDED" }],
        expectedChanges: [],
        unexpectedChanges: [{ filePath: "src/new.ts", changeType: "ADDED", reason: "UNEXPECTED_CREATE", evidence: ["Unauthorized"] }],
        summary: { totalActualChanges: 1, totalExpectedChanges: 0, totalUnexpectedChanges: 1, added: 1, modified: 0, deleted: 0, renamed: 0 },
      },
    };
    const result = await runDiffIntelligence(input);
    const file = result.files.find((f) => f.filePath === "src/new.ts");
    expect(file?.unexpected).toBe(true);
    expect(result.statistics.unexpectedFiles).toBe(1);
  });

  // ---- P15 integration ----

  it("correlates P15 security finding to changed file", async () => {
    vi.mocked(gitDiff).mockResolvedValueOnce(MODIFIED_FILE_DIFF);
    const input: DiffIntelligenceInput = {
      workspace: makeWorkspace(tmpDir),
      security: {
        workspaceId: "ws_test_p17", status: "FINDINGS",
        findings: [{ id: "SEC-001", category: "SECRET", severity: "HIGH", title: "Token", description: "desc", filePath: "src/app.ts", evidence: [], source: "DETERMINISTIC" }],
        summary: { totalFindings: 1, critical: 0, high: 1, medium: 0, low: 0, secretsDetected: 1, dependencyFindings: 0, codeFindings: 0, configurationFindings: 0, aiReviewFindings: 0 },
        checks: [], startedAt: "", completedAt: "",
      },
    };
    const result = await runDiffIntelligence(input);
    const corr = result.correlations.find((c) => c.filePath === "src/app.ts");
    expect(corr?.securityFindingIds).toContain("SEC-001");
  });

  // ---- P16 boundary ----

  it("does NOT produce canProceed/approved/rejected in result", async () => {
    vi.mocked(gitDiff).mockResolvedValueOnce(EMPTY_DIFF);
    const result = await runDiffIntelligence(makeMinimalInput(tmpDir));
    expect(result).not.toHaveProperty("canProceed");
    expect(result).not.toHaveProperty("approved");
    expect(result).not.toHaveProperty("rejected");
    expect(result).not.toHaveProperty("blocked");
    expect(result).not.toHaveProperty("safetyScore");
  });

  it("records P16 safety decision as contextual metadata", async () => {
    vi.mocked(gitDiff).mockResolvedValueOnce(EMPTY_DIFF);
    const input: DiffIntelligenceInput = {
      workspace: makeWorkspace(tmpDir),
      safetyGate: {
        workspaceId: "ws_test_p17",
        decision: "SAFE_TO_PROCEED",
        checks: [], blockingReasons: [], warnings: [],
        summary: { totalChecks: 5, passed: 5, failed: 0, notVerified: 0, blockingReasonCount: 0, warningCount: 0 },
      },
    };
    const result = await runDiffIntelligence(input);
    expect(result.summary.safetyDecision).toBe("SAFE_TO_PROCEED");
  });

  // ---- Statistics ----

  it("statistics match file array counts", async () => {
    vi.mocked(gitDiff).mockResolvedValueOnce(MULTI_FILE_DIFF);
    const result = await runDiffIntelligence(makeMinimalInput(tmpDir));
    const { statistics, files } = result;
    expect(statistics.filesChanged).toBe(files.length);
    expect(statistics.totalAdditions).toBe(files.reduce((s, f) => s + f.additions, 0));
    expect(statistics.totalDeletions).toBe(files.reduce((s, f) => s + f.deletions, 0));
  });

  it("package.json counted as dependencyFilesChanged", async () => {
    vi.mocked(gitDiff).mockResolvedValueOnce(MULTI_FILE_DIFF);
    const result = await runDiffIntelligence(makeMinimalInput(tmpDir));
    expect(result.statistics.dependencyFilesChanged).toBe(1);
  });

  it("src/*.ts counted as sourceFilesChanged", async () => {
    vi.mocked(gitDiff).mockResolvedValueOnce(MULTI_FILE_DIFF);
    const result = await runDiffIntelligence(makeMinimalInput(tmpDir));
    expect(result.statistics.sourceFilesChanged).toBeGreaterThanOrEqual(1);
  });

  // ---- Summary ----

  it("summary.truncated = false for normal diff", async () => {
    vi.mocked(gitDiff).mockResolvedValueOnce(MULTI_FILE_DIFF);
    const result = await runDiffIntelligence(makeMinimalInput(tmpDir));
    expect(result.summary.truncated).toBe(false);
  });

  // ---- Determinism ----

  it("same diff → same file order, same IDs (twice)", async () => {
    vi.mocked(gitDiff)
      .mockResolvedValueOnce(MULTI_FILE_DIFF)
      .mockResolvedValueOnce(MULTI_FILE_DIFF);
    const input = makeMinimalInput(tmpDir);
    const r1 = await runDiffIntelligence(input);
    const r2 = await runDiffIntelligence(input);
    expect(r1.files.map((f) => f.filePath)).toEqual(r2.files.map((f) => f.filePath));
    expect(r1.changes.map((c) => c.id)).toEqual(r2.changes.map((c) => c.id));
    expect(r1.statistics).toEqual(r2.statistics);
  });

  it("DIFF-NNN IDs are sequential", async () => {
    vi.mocked(gitDiff).mockResolvedValueOnce(MODIFIED_FILE_DIFF);
    const result = await runDiffIntelligence(makeMinimalInput(tmpDir));
    for (let i = 0; i < result.changes.length; i++) {
      expect(result.changes[i]!.id).toBe(`DIFF-${String(i + 1).padStart(3, "0")}`);
    }
  });

  // ---- Secret safety ----

  it("change content does not include raw secret values", async () => {
    const rawSecret = "sk_live_abcdefgh1234567890abcd";
    const secretDiff = `diff --git a/config.ts b/config.ts\nindex abc..def 100644\n--- a/config.ts\n+++ b/config.ts\n@@ -1,1 +1,1 @@\n-const key = "old";\n+const api_key = "${rawSecret}";\n`;
    vi.mocked(gitDiff).mockResolvedValueOnce(secretDiff);
    const result = await runDiffIntelligence(makeMinimalInput(tmpDir));
    const allText = JSON.stringify(result);
    expect(allText).not.toContain(rawSecret);
  });

  // ---- Error handling ----

  it("throws DiffWorkspaceError when workspace not READY", async () => {
    const input: DiffIntelligenceInput = {
      workspace: { ...makeWorkspace(tmpDir), status: "CLEANING" },
    };
    await expect(runDiffIntelligence(input)).rejects.toThrow("not in READY state");
  });

  it("throws DiffRetrievalError when gitDiff fails", async () => {
    vi.mocked(gitDiff).mockRejectedValueOnce(new Error("git not found"));
    await expect(runDiffIntelligence(makeMinimalInput(tmpDir))).rejects.toThrow(
      "git diff failed"
    );
  });

  it("empty diff is not confused with git failure", async () => {
    vi.mocked(gitDiff).mockResolvedValueOnce(""); // empty = no changes, not failure
    const result = await runDiffIntelligence(makeMinimalInput(tmpDir));
    expect(result.status).toBe("ANALYZED");
    expect(result.files).toHaveLength(0);
  });

  it("throws ValidationError on invalid input", async () => {
    await expect(runDiffIntelligence({} as DiffIntelligenceInput)).rejects.toThrow();
  });

  // ---- PARTIAL on truncation ----

  it("returns PARTIAL when a file's diff was truncated", async () => {
    // Build diff with too many changed lines
    let bigDiff = `diff --git a/big.ts b/big.ts\nindex abc..def 100644\n--- a/big.ts\n+++ b/big.ts\n@@ -1,${MAX_CHANGED_LINES_PER_FILE + 10} +1,${MAX_CHANGED_LINES_PER_FILE + 10} @@\n`;
    for (let i = 0; i < MAX_CHANGED_LINES_PER_FILE + 10; i++) {
      bigDiff += `+new line ${i}\n`;
    }
    vi.mocked(gitDiff).mockResolvedValueOnce(bigDiff);
    const result = await runDiffIntelligence(makeMinimalInput(tmpDir));
    expect(result.status).toBe("PARTIAL");
    expect(result.summary.truncated).toBe(true);
  });

  // ---- Multiple hunks ----

  it("file with multiple hunks → correct hunk count", async () => {
    vi.mocked(gitDiff).mockResolvedValueOnce(MULTI_HUNK_DIFF);
    const result = await runDiffIntelligence(makeMinimalInput(tmpDir));
    expect(result.files[0]!.hunks).toBe(2);
  });

  // ---- Evidence ----

  it("evidence array is populated for correlated files", async () => {
    vi.mocked(gitDiff).mockResolvedValueOnce(MULTI_FILE_DIFF);
    const input: DiffIntelligenceInput = {
      workspace: makeWorkspace(tmpDir),
      migrationPlan: makePlan(),
      migrationResult: makeMigrationResult(),
    };
    const result = await runDiffIntelligence(input);
    const gitEvidence = result.evidence.filter((e) => e.source === "GIT");
    expect(gitEvidence.length).toBeGreaterThan(0);
    const p8Evidence = result.evidence.filter((e) => e.source === "P8");
    expect(p8Evidence.length).toBeGreaterThan(0);
  });

  it("analyzedAt is an ISO timestamp", async () => {
    vi.mocked(gitDiff).mockResolvedValueOnce(EMPTY_DIFF);
    const result = await runDiffIntelligence(makeMinimalInput(tmpDir));
    expect(new Date(result.analyzedAt).toISOString()).toBe(result.analyzedAt);
  });

  it("workspaceId matches input", async () => {
    vi.mocked(gitDiff).mockResolvedValueOnce(EMPTY_DIFF);
    const result = await runDiffIntelligence(makeMinimalInput(tmpDir));
    expect(result.workspaceId).toBe("ws_test_p17");
  });
});

// ---------------------------------------------------------------------------
// ============================================================
// EXPRESS 4→5 PROOF FIXTURE
// ============================================================
// ---------------------------------------------------------------------------

describe("Express 4→5 — end-to-end proof", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    vi.resetAllMocks();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("Express 4→5 migration diff → identifies package.json, app.ts, test file", async () => {
    const express4to5Diff = `diff --git a/package.json b/package.json
index abc1234..def5678 100644
--- a/package.json
+++ b/package.json
@@ -5,7 +5,7 @@
   "dependencies": {
-    "express": "^4.18.2"
+    "express": "^5.0.0"
   }
diff --git a/src/app.ts b/src/app.ts
index abc1234..def5678 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,5 +1,5 @@
 import express from 'express';
-const app = express();
+const app = express({ strict: true });
 app.use(express.json());
diff --git a/src/app.test.ts b/src/app.test.ts
index abc1234..def5678 100644
--- a/src/app.test.ts
+++ b/src/app.test.ts
@@ -1,3 +1,3 @@
-it('runs', () => expect(app).toBeDefined());
+it('runs with Express 5', () => expect(app).toBeDefined());
`;

    vi.mocked(gitDiff).mockResolvedValueOnce(express4to5Diff);

    const input: DiffIntelligenceInput = {
      workspace: makeWorkspace(tmpDir),
      migrationPlan: makePlan(),
      migrationResult: makeMigrationResult(),
    };

    const result = await runDiffIntelligence(input);

    expect(result.status).toBe("ANALYZED");
    expect(result.statistics.filesChanged).toBe(3);

    const paths = result.files.map((f) => f.filePath);
    expect(paths).toContain("package.json");
    expect(paths).toContain("src/app.ts");
    expect(paths).toContain("src/app.test.ts");

    // Categories
    const pkg = result.files.find((f) => f.filePath === "package.json");
    expect(pkg?.category).toBe("DEPENDENCY");
    const app = result.files.find((f) => f.filePath === "src/app.ts");
    expect(app?.category).toBe("SOURCE");
    const test = result.files.find((f) => f.filePath === "src/app.test.ts");
    expect(test?.category).toBe("TEST");

    // Plan correlations
    expect(pkg?.relatedPlanSteps).toContain("STEP-001");
    expect(app?.relatedPlanSteps).toContain("STEP-002");

    // Statistics
    expect(result.statistics.dependencyFilesChanged).toBe(1);
    expect(result.statistics.testFilesChanged).toBe(1);
    expect(result.statistics.sourceFilesChanged).toBeGreaterThanOrEqual(1);

    // Migration related
    expect(app?.migrationRelated).toBe(true);
    expect(pkg?.migrationRelated).toBe(true);

    // No P18/P19/P20+ fields
    expect(result).not.toHaveProperty("confidence");
    expect(result).not.toHaveProperty("explanation");
  });

  it("Express 4→5 deterministic: two runs → identical result", async () => {
    const diff = MODIFIED_FILE_DIFF;
    vi.mocked(gitDiff).mockResolvedValue(diff);
    const input: DiffIntelligenceInput = {
      workspace: makeWorkspace(tmpDir),
      migrationPlan: makePlan(),
    };
    const r1 = await runDiffIntelligence(input);
    const r2 = await runDiffIntelligence(input);
    expect(r1.files.map((f) => f.filePath)).toEqual(r2.files.map((f) => f.filePath));
    expect(r1.changes.map((c) => c.id)).toEqual(r2.changes.map((c) => c.id));
    expect(r1.statistics).toEqual(r2.statistics);
  });
});
