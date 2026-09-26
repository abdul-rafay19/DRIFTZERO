/**
 * Impact Analysis Agent tests (P5).
 *
 * Uses a small fixture repository on the real filesystem.
 * No live Bob required — the agent is deterministic for repository scanning.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { runImpactAnalysis, ImpactAnalysisError } from "./impact-analysis-agent.js";
import { express4Fixture } from "./fixtures/express4-fixture.js";
import { ValidationError } from "@driftzero/shared";
import type { ChangeAnalysisResult } from "@driftzero/shared";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal P4 ChangeAnalysisResult for express 4→5. */
function makeChangeAnalysis(): ChangeAnalysisResult {
  return {
    packageName: "express",
    sourceVersion: "4",
    targetVersion: "5",
    summary: "Express 5 introduces several breaking changes.",
    breakingChanges: [
      {
        id: "bc-1",
        title: "Async error propagation",
        description: "Async errors are now forwarded automatically.",
        severity: "high",
        migrationRequired: true,
      },
    ],
    deprecatedApis: [
      {
        id: "dep-1",
        apiName: "app.del",
        description: "app.del() has been removed; use app.delete() instead.",
        replacement: "app.delete",
        removedInVersion: "5",
      },
    ],
    behaviorChanges: [],
    migrationRequirements: [
      {
        id: "req-1",
        title: "Replace app.del() with app.delete()",
        description: "The app.del() method has been removed.",
        mandatory: true,
      },
    ],
    migrationPatterns: [
      {
        id: "pat-1",
        title: "Delete route pattern",
        description: "Replace app.del with app.delete",
        before: "app.del('/path', handler)",
        after: "app.delete('/path', handler)",
      },
    ],
    compatibilityNotes: ["Requires Node.js 18+"],
    analyzedAt: "2024-01-01T00:00:00.000Z",
    meta: { bobDurationMs: 1000, promptLength: 500 },
  };
}

/** Write fixture files into a temp directory, respecting subdirectories but skipping ignored ones. */
async function buildFixtureWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dz-impact-test-"));

  for (const file of express4Fixture) {
    const fullPath = join(root, file.path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, file.content, "utf8");
  }

  return root;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let fixtureRoot: string;

beforeAll(async () => {
  fixtureRoot = await buildFixtureWorkspace();
});

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------
describe("runImpactAnalysis — input validation", () => {
  it("throws ValidationError when workspacePath is empty", async () => {
    await expect(
      runImpactAnalysis({
        workspacePath: "",
        packageName: "express",
        sourceVersion: "4",
        targetVersion: "5",
        changeAnalysis: makeChangeAnalysis(),
      })
    ).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError when packageName is empty", async () => {
    await expect(
      runImpactAnalysis({
        workspacePath: fixtureRoot,
        packageName: "",
        sourceVersion: "4",
        targetVersion: "5",
        changeAnalysis: makeChangeAnalysis(),
      })
    ).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError when sourceVersion is empty", async () => {
    await expect(
      runImpactAnalysis({
        workspacePath: fixtureRoot,
        packageName: "express",
        sourceVersion: "",
        targetVersion: "5",
        changeAnalysis: makeChangeAnalysis(),
      })
    ).rejects.toThrow(ValidationError);
  });

  it("throws ImpactAnalysisError when workspacePath does not exist", async () => {
    await expect(
      runImpactAnalysis({
        workspacePath: "/tmp/dz-nonexistent-workspace-xyz",
        packageName: "express",
        sourceVersion: "4",
        targetVersion: "5",
        changeAnalysis: makeChangeAnalysis(),
      })
    ).rejects.toThrow(ImpactAnalysisError);
  });

  it("throws ValidationError for malformed P4 change analysis (missing fields)", async () => {
    await expect(
      runImpactAnalysis({
        workspacePath: fixtureRoot,
        packageName: "express",
        sourceVersion: "4",
        targetVersion: "5",
        changeAnalysis: { packageName: "express" } as ChangeAnalysisResult,
      })
    ).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Workspace scanning — detection
// ---------------------------------------------------------------------------
describe("runImpactAnalysis — workspace scanning", () => {
  let result: Awaited<ReturnType<typeof runImpactAnalysis>>;

  beforeAll(async () => {
    result = await runImpactAnalysis({
      workspacePath: fixtureRoot,
      packageName: "express",
      sourceVersion: "4",
      targetVersion: "5",
      changeAnalysis: makeChangeAnalysis(),
    });
  });

  it("returns a valid ImpactAnalysisResult shape", () => {
    expect(result.packageName).toBe("express");
    expect(result.sourceVersion).toBe("4");
    expect(result.targetVersion).toBe("5");
    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.analyzedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Array.isArray(result.affectedFiles)).toBe(true);
    expect(Array.isArray(result.affectedApis)).toBe(true);
    expect(Array.isArray(result.affectedDependencies)).toBe(true);
    expect(Array.isArray(result.affectedTests)).toBe(true);
    expect(Array.isArray(result.affectedConfigs)).toBe(true);
    expect(Array.isArray(result.highRiskAreas)).toBe(true);
  });

  it("detects express as an affected dependency from package.json", () => {
    expect(result.affectedDependencies.length).toBeGreaterThan(0);
    const dep = result.affectedDependencies.find((d) => d.name === "express");
    expect(dep).toBeDefined();
    expect(dep!.declaredVersion).toContain("4");
    expect(dep!.dependencyType).toBe("dependencies");
  });

  it("detects pnpm as the package manager from pnpm-lock.yaml", () => {
    const dep = result.affectedDependencies.find((d) => d.name === "express");
    expect(dep?.packageManager).toBe("pnpm");
  });

  it("detects a route file as affected", () => {
    const routeFile = result.affectedFiles.find((f) => f.path.includes("routes/"));
    expect(routeFile).toBeDefined();
    expect(routeFile!.category).toBe("ROUTE");
  });

  it("detects a middleware file as affected", () => {
    const mwFile = result.affectedFiles.find((f) => f.path.includes("middleware/"));
    expect(mwFile).toBeDefined();
    expect(mwFile!.category).toBe("MIDDLEWARE");
  });

  it("detects a controller file as affected", () => {
    const ctrlFile = result.affectedFiles.find((f) => f.path.includes("controller"));
    expect(ctrlFile).toBeDefined();
    expect(ctrlFile!.category).toBe("CONTROLLER");
  });

  it("detects a test file in affectedTests", () => {
    expect(result.affectedTests.length).toBeGreaterThan(0);
    const test = result.affectedTests.find((t) => t.path.includes(".test."));
    expect(test).toBeDefined();
  });

  it("detects deprecated API usage (app.del) as affected API", () => {
    const api = result.affectedApis.find((a) => a.api === "app.del");
    expect(api).toBeDefined();
    expect(api!.migrationRequirementId).toBe("req-1");
  });

  it("detects tsconfig.json as an affected config", () => {
    const cfg = result.affectedConfigs.find((c) => c.path.includes("tsconfig.json"));
    expect(cfg).toBeDefined();
  });

  it("has at least one high-risk area", () => {
    expect(result.highRiskAreas.length).toBeGreaterThan(0);
  });

  it("affected files have evidence", () => {
    for (const file of result.affectedFiles) {
      expect(file.evidence.length).toBeGreaterThan(0);
    }
  });

  it("summary string mentions express", () => {
    expect(result.summary.toLowerCase()).toContain("express");
  });
});

// ---------------------------------------------------------------------------
// Ignored directories
// ---------------------------------------------------------------------------
describe("runImpactAnalysis — ignored directories", () => {
  let result: Awaited<ReturnType<typeof runImpactAnalysis>>;

  beforeAll(async () => {
    result = await runImpactAnalysis({
      workspacePath: fixtureRoot,
      packageName: "express",
      sourceVersion: "4",
      targetVersion: "5",
      changeAnalysis: makeChangeAnalysis(),
    });
  });

  const ignoredPrefixes = ["node_modules/", ".git/", "dist/", "coverage/"];

  for (const prefix of ignoredPrefixes) {
    it(`does not scan files inside ${prefix}`, () => {
      const allPaths = [
        ...result.affectedFiles.map((f) => f.path),
        ...result.affectedTests.map((f) => f.path),
        ...result.affectedApis.map((f) => f.file),
      ];
      const leaked = allPaths.filter((p) => p.startsWith(prefix));
      expect(leaked).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Safety — workspace boundary
// ---------------------------------------------------------------------------
describe("runImpactAnalysis — workspace boundary safety", () => {
  it("all returned file paths are relative (no absolute paths)", async () => {
    const result = await runImpactAnalysis({
      workspacePath: fixtureRoot,
      packageName: "express",
      sourceVersion: "4",
      targetVersion: "5",
      changeAnalysis: makeChangeAnalysis(),
    });

    const allPaths = [
      ...result.affectedFiles.map((f) => f.path),
      ...result.affectedTests.map((f) => f.path),
      ...result.affectedApis.map((f) => f.file),
      ...result.affectedConfigs.map((f) => f.path),
    ];

    for (const p of allPaths) {
      expect(p.startsWith("/")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Output validation
// ---------------------------------------------------------------------------
describe("impactAnalysisResultSchema", () => {
  it("rejects a result with missing required fields", async () => {
    const { impactAnalysisResultSchema } = await import("./impact-analysis-types.js");
    const bad = { packageName: "express", sourceVersion: "4" };
    const result = impactAnalysisResultSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("accepts a well-formed result", async () => {
    const { impactAnalysisResultSchema } = await import("./impact-analysis-types.js");
    const good = {
      packageName: "express",
      sourceVersion: "4",
      targetVersion: "5",
      affectedFiles: [],
      affectedApis: [],
      affectedDependencies: [],
      affectedTests: [],
      affectedConfigs: [],
      highRiskAreas: [],
      summary: "No impact found.",
      analyzedAt: new Date().toISOString(),
    };
    const result = impactAnalysisResultSchema.safeParse(good);
    expect(result.success).toBe(true);
  });
});
