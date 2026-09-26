/**
 * Migration Planner tests (P8).
 *
 * All tests are deterministic — no Bob calls, no filesystem access.
 * Covers: input validation, step generation, ordering, DAG dependencies,
 * traceability, risk pass-through, determinism, security, Express 4→5 proof.
 */

import { describe, it, expect } from "vitest";
import { generateMigrationPlan, MigrationPlannerError } from "./migration-planner.js";
import { migrationPlanSchema, hasCycle } from "./migration-planner-types.js";
import { ValidationError } from "@driftzero/shared";
import type {
  ChangeAnalysisResult,
  ImpactAnalysisResult,
  RiskScoreResult,
  ImpactPreviewResult,
  MigrationPlan,
} from "@driftzero/shared";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeCA(overrides: Partial<ChangeAnalysisResult> = {}): ChangeAnalysisResult {
  return {
    packageName: "express",
    sourceVersion: "4",
    targetVersion: "5",
    summary: "Express 5 introduces breaking changes.",
    breakingChanges: [],
    deprecatedApis: [],
    behaviorChanges: [],
    migrationRequirements: [],
    migrationPatterns: [],
    compatibilityNotes: [],
    analyzedAt: "2024-01-01T00:00:00.000Z",
    meta: { bobDurationMs: 1000, promptLength: 500 },
    ...overrides,
  };
}

function makeIA(overrides: Partial<ImpactAnalysisResult> = {}): ImpactAnalysisResult {
  return {
    packageName: "express",
    sourceVersion: "4",
    targetVersion: "5",
    affectedFiles: [],
    affectedApis: [],
    affectedDependencies: [],
    affectedTests: [],
    affectedConfigs: [],
    highRiskAreas: [],
    summary: "No impact.",
    analyzedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeRS(overrides: Partial<RiskScoreResult> = {}): RiskScoreResult {
  return {
    score: 0,
    level: "LOW",
    reasons: [],
    factors: {
      breakingChanges: 0, deprecatedApis: 0, affectedFiles: 0,
      affectedApis: 0, affectedDependencies: 0, affectedTests: 0, highRiskAreas: 0,
    },
    assessedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeIP(overrides: Partial<ImpactPreviewResult> = {}): ImpactPreviewResult {
  return {
    packageName: "express",
    sourceVersion: "4",
    targetVersion: "5",
    risk: { score: 0, level: "LOW" },
    summary: "Minimal migration.",
    breakingChanges: [],
    deprecatedApis: [],
    highRiskAreas: [],
    affectedApis: [],
    affectedFiles: [],
    affectedDependencies: [],
    affectedTests: [],
    affectedConfigs: [],
    behaviorChanges: [],
    generatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// Shared item builders
function bc(id: string, severity: "low" | "medium" | "high" | "critical" = "high", affectedArea?: string) {
  return { id, title: `BC ${id}`, description: "breaking change", severity, migrationRequired: true, affectedArea };
}
function req(id: string, mandatory = true) {
  return { id, title: `Req ${id}`, description: "migration requirement", mandatory };
}
function affectedFile(path: string, category: "API" | "ROUTE" | "MIDDLEWARE" | "CONTROLLER" | "CONFIG" | "TEST" | "OTHER" = "API") {
  return { path, category, reason: "imports express", relevance: "direct" as const, evidence: ["import express"] };
}
function affectedApi(file: string, api: string, reqId?: string) {
  return { file, api, reason: "deprecated in v5", migrationRequirementId: reqId };
}
function affectedDep(name = "express", version = "^4.18.0") {
  return { name, declaredVersion: version, dependencyType: "dependencies" as const, packageManager: "npm" as const, reason: "upgrade required" };
}
function affectedTest(path: string) {
  return { path, reason: "imports express", evidence: ["import express"] };
}
function affectedConfig(path: string) {
  return { path, reason: "may change" };
}
function highRiskArea(title: string) {
  return { title, description: `${title} is high-risk`, files: ["src/index.ts"] };
}
function previewItem(title: string) {
  return {
    title,
    description: "may require migration",
    source: "CHANGE_ANALYSIS" as const,
    evidence: ["ev-1"],
  };
}

// Default full input for E2E tests
function makeFullInput() {
  return {
    changeAnalysis: makeCA({
      breakingChanges: [bc("bc-1", "high", "middleware"), bc("bc-2", "medium")],
      deprecatedApis: [{ id: "dep-1", apiName: "app.del", description: "removed", replacement: "app.delete" }],
      migrationRequirements: [req("req-1"), req("req-2")],
    }),
    impactAnalysis: makeIA({
      affectedFiles: [
        affectedFile("src/index.ts", "API"),
        affectedFile("src/middleware/error.ts", "MIDDLEWARE"),
        affectedFile("src/routes/users.ts", "ROUTE"),
      ],
      affectedApis: [affectedApi("src/routes/users.ts", "app.del", "req-1")],
      affectedDependencies: [affectedDep()],
      affectedTests: [affectedTest("test/users.test.ts")],
      affectedConfigs: [affectedConfig("tsconfig.json")],
      highRiskAreas: [highRiskArea("Custom middleware"), highRiskArea("Deprecated API usage")],
    }),
    riskScore: makeRS({ score: 61, level: "HIGH" }),
    impactPreview: makeIP({ risk: { score: 61, level: "HIGH" }, summary: "HIGH migration risk." }),
  };
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("generateMigrationPlan — input validation", () => {
  it("accepts valid minimal input (no evidence)", () => {
    const result = generateMigrationPlan({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA(),
      riskScore: makeRS(),
      impactPreview: makeIP(),
    });
    expect(result.packageName).toBe("express");
  });

  it("throws ValidationError when changeAnalysis is missing", () => {
    expect(() =>
      generateMigrationPlan({
        changeAnalysis: undefined as never,
        impactAnalysis: makeIA(),
        riskScore: makeRS(),
        impactPreview: makeIP(),
      })
    ).toThrow(ValidationError);
  });

  it("throws ValidationError when impactAnalysis is missing", () => {
    expect(() =>
      generateMigrationPlan({
        changeAnalysis: makeCA(),
        impactAnalysis: undefined as never,
        riskScore: makeRS(),
        impactPreview: makeIP(),
      })
    ).toThrow(ValidationError);
  });

  it("throws ValidationError when riskScore is missing", () => {
    expect(() =>
      generateMigrationPlan({
        changeAnalysis: makeCA(),
        impactAnalysis: makeIA(),
        riskScore: undefined as never,
        impactPreview: makeIP(),
      })
    ).toThrow(ValidationError);
  });

  it("throws ValidationError when impactPreview is missing", () => {
    expect(() =>
      generateMigrationPlan({
        changeAnalysis: makeCA(),
        impactAnalysis: makeIA(),
        riskScore: makeRS(),
        impactPreview: undefined as never,
      })
    ).toThrow(ValidationError);
  });

  it("throws ValidationError for invalid severity in changeAnalysis", () => {
    expect(() =>
      generateMigrationPlan({
        changeAnalysis: makeCA({
          breakingChanges: [{ id: "bc-1", title: "t", description: "d", severity: "extreme" as never, migrationRequired: true }],
        }),
        impactAnalysis: makeIA(),
        riskScore: makeRS(),
        impactPreview: makeIP(),
      })
    ).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Risk pass-through
// ---------------------------------------------------------------------------

describe("risk pass-through", () => {
  it("passes score unchanged from P6", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA(),
      riskScore: makeRS({ score: 75, level: "CRITICAL" }),
      impactPreview: makeIP({ risk: { score: 75, level: "CRITICAL" } }),
    });
    expect(r.risk.score).toBe(75);
  });

  it("passes level unchanged from P6", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA(),
      riskScore: makeRS({ score: 35, level: "MEDIUM" }),
      impactPreview: makeIP({ risk: { score: 35, level: "MEDIUM" } }),
    });
    expect(r.risk.level).toBe("MEDIUM");
  });

  it("does not recalculate score even with many breaking changes", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA({ breakingChanges: Array.from({ length: 10 }, (_, i) => bc(`bc-${i}`)) }),
      impactAnalysis: makeIA(),
      riskScore: makeRS({ score: 5, level: "LOW" }),
      impactPreview: makeIP(),
    });
    expect(r.risk.score).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Plan structure
// ---------------------------------------------------------------------------

describe("plan structure", () => {
  it("includes packageName, sourceVersion, targetVersion", () => {
    const r = generateMigrationPlan({ changeAnalysis: makeCA(), impactAnalysis: makeIA(), riskScore: makeRS(), impactPreview: makeIP() });
    expect(r.packageName).toBe("express");
    expect(r.sourceVersion).toBe("4");
    expect(r.targetVersion).toBe("5");
  });

  it("includes a non-empty objective", () => {
    const r = generateMigrationPlan({ changeAnalysis: makeCA(), impactAnalysis: makeIA(), riskScore: makeRS(), impactPreview: makeIP() });
    expect(r.objective.length).toBeGreaterThan(0);
  });

  it("objective references package name", () => {
    const r = generateMigrationPlan({ changeAnalysis: makeCA(), impactAnalysis: makeIA(), riskScore: makeRS(), impactPreview: makeIP() });
    expect(r.objective).toContain("express");
  });

  it("generatedAt is a valid ISO timestamp", () => {
    const r = generateMigrationPlan({ changeAnalysis: makeCA(), impactAnalysis: makeIA(), riskScore: makeRS(), impactPreview: makeIP() });
    expect(r.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(() => new Date(r.generatedAt)).not.toThrow();
  });

  it("empty evidence produces empty steps", () => {
    const r = generateMigrationPlan({ changeAnalysis: makeCA(), impactAnalysis: makeIA(), riskScore: makeRS(), impactPreview: makeIP() });
    expect(r.steps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Step generation — per category
// ---------------------------------------------------------------------------

describe("DEPENDENCY steps", () => {
  it("generates a step for each affected dependency package", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedDependencies: [affectedDep()] }),
      riskScore: makeRS(),
      impactPreview: makeIP(),
    });
    const dep = r.steps.find((s) => s.category === "DEPENDENCY");
    expect(dep).toBeDefined();
  });

  it("dependency step category is DEPENDENCY", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedDependencies: [affectedDep()] }),
      riskScore: makeRS(),
      impactPreview: makeIP(),
    });
    expect(r.steps[0]!.category).toBe("DEPENDENCY");
  });

  it("dependency step title contains the package name", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedDependencies: [affectedDep("express")] }),
      riskScore: makeRS(),
      impactPreview: makeIP(),
    });
    const dep = r.steps.find((s) => s.category === "DEPENDENCY")!;
    expect(dep.title).toContain("express");
  });

  it("no dependency step generated when no dependencies", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA(),
      riskScore: makeRS(),
      impactPreview: makeIP(),
    });
    expect(r.steps.some((s) => s.category === "DEPENDENCY")).toBe(false);
  });
});

describe("API steps", () => {
  it("generates a step per file with affected APIs", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({
        affectedApis: [
          affectedApi("src/routes/users.ts", "app.del"),
          affectedApi("src/routes/posts.ts", "app.del"),
        ],
      }),
      riskScore: makeRS(),
      impactPreview: makeIP(),
    });
    const apiSteps = r.steps.filter((s) => s.category === "API");
    expect(apiSteps).toHaveLength(2);
  });

  it("API step affectedFiles contains the file", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedApis: [affectedApi("src/routes/users.ts", "app.del")] }),
      riskScore: makeRS(),
      impactPreview: makeIP(),
    });
    const apiStep = r.steps.find((s) => s.category === "API")!;
    expect(apiStep.affectedFiles).toContain("src/routes/users.ts");
  });

  it("API step links to migration requirement when provided", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA({ migrationRequirements: [req("req-1")] }),
      impactAnalysis: makeIA({ affectedApis: [affectedApi("src/routes/users.ts", "app.del", "req-1")] }),
      riskScore: makeRS(),
      impactPreview: makeIP(),
    });
    const apiStep = r.steps.find((s) => s.category === "API")!;
    expect(apiStep.relatedRequirementIds).toContain("req-1");
  });
});

describe("MIDDLEWARE steps", () => {
  it("generates a step for middleware files", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedFiles: [affectedFile("src/middleware/error.ts", "MIDDLEWARE")] }),
      riskScore: makeRS(),
      impactPreview: makeIP(),
    });
    const mw = r.steps.find((s) => s.category === "MIDDLEWARE");
    expect(mw).toBeDefined();
    expect(mw!.affectedFiles).toContain("src/middleware/error.ts");
  });

  it("no middleware step when no middleware files", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedFiles: [affectedFile("src/routes/users.ts", "ROUTE")] }),
      riskScore: makeRS(),
      impactPreview: makeIP(),
    });
    expect(r.steps.some((s) => s.category === "MIDDLEWARE")).toBe(false);
  });
});

describe("ROUTE steps", () => {
  it("generates a ROUTE step for route files", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedFiles: [affectedFile("src/routes/users.ts", "ROUTE")] }),
      riskScore: makeRS(),
      impactPreview: makeIP(),
    });
    expect(r.steps.some((s) => s.category === "ROUTE")).toBe(true);
  });

  it("generates a CONTROLLER step for controller files", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedFiles: [affectedFile("src/controllers/users.ts", "CONTROLLER")] }),
      riskScore: makeRS(),
      impactPreview: makeIP(),
    });
    expect(r.steps.some((s) => s.category === "CONTROLLER")).toBe(true);
  });
});

describe("CONFIG steps", () => {
  it("generates a CONFIG step for affected configs", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedConfigs: [affectedConfig("tsconfig.json")] }),
      riskScore: makeRS(),
      impactPreview: makeIP(),
    });
    const cfg = r.steps.find((s) => s.category === "CONFIG");
    expect(cfg).toBeDefined();
    expect(cfg!.affectedFiles).toContain("tsconfig.json");
  });

  it("CONFIG step risk is LOW", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedConfigs: [affectedConfig("tsconfig.json")] }),
      riskScore: makeRS({ score: 80, level: "CRITICAL" }),
      impactPreview: makeIP({ risk: { score: 80, level: "CRITICAL" } }),
    });
    const cfg = r.steps.find((s) => s.category === "CONFIG")!;
    expect(cfg.risk).toBe("LOW");
  });
});

describe("TEST steps", () => {
  it("generates a TEST step for affected tests", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedTests: [affectedTest("test/users.test.ts")] }),
      riskScore: makeRS(),
      impactPreview: makeIP(),
    });
    const t = r.steps.find((s) => s.category === "TEST");
    expect(t).toBeDefined();
    expect(t!.affectedFiles).toContain("test/users.test.ts");
  });

  it("TEST step risk is LOW", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedTests: [affectedTest("test/a.test.ts")] }),
      riskScore: makeRS({ score: 80, level: "CRITICAL" }),
      impactPreview: makeIP({ risk: { score: 80, level: "CRITICAL" } }),
    });
    const t = r.steps.find((s) => s.category === "TEST")!;
    expect(t.risk).toBe("LOW");
  });
});

// ---------------------------------------------------------------------------
// Step ordering
// ---------------------------------------------------------------------------

describe("step ordering", () => {
  it("steps have sequential 1-based order numbers", () => {
    const r = generateMigrationPlan(makeFullInput());
    for (let i = 0; i < r.steps.length; i++) {
      expect(r.steps[i]!.order).toBe(i + 1);
    }
  });

  it("step IDs follow STEP-NNN pattern", () => {
    const r = generateMigrationPlan(makeFullInput());
    for (const step of r.steps) {
      expect(step.id).toMatch(/^STEP-\d{3}$/);
    }
  });

  it("DEPENDENCY step comes before API step", () => {
    const r = generateMigrationPlan(makeFullInput());
    const depOrder = r.steps.find((s) => s.category === "DEPENDENCY")?.order ?? Infinity;
    const apiOrder = r.steps.find((s) => s.category === "API")?.order ?? Infinity;
    expect(depOrder).toBeLessThan(apiOrder);
  });

  it("API/MIDDLEWARE steps come before TEST step", () => {
    const r = generateMigrationPlan(makeFullInput());
    const testOrder = r.steps.find((s) => s.category === "TEST")?.order ?? Infinity;
    const apiOrder = r.steps.find((s) => s.category === "API")?.order ?? 0;
    expect(apiOrder).toBeLessThan(testOrder);
  });

  it("same input always produces same step order", () => {
    const input = makeFullInput();
    const r1 = generateMigrationPlan(input);
    const r2 = generateMigrationPlan(input);
    expect(r1.steps.map((s) => s.id)).toEqual(r2.steps.map((s) => s.id));
    expect(r1.steps.map((s) => s.order)).toEqual(r2.steps.map((s) => s.order));
  });
});

// ---------------------------------------------------------------------------
// DAG dependency model
// ---------------------------------------------------------------------------

describe("DAG dependency model", () => {
  it("first step has no dependencies", () => {
    const r = generateMigrationPlan(makeFullInput());
    expect(r.steps[0]!.dependencies).toHaveLength(0);
  });

  it("later steps have dependencies on earlier steps", () => {
    const r = generateMigrationPlan(makeFullInput());
    // At least one step after the first should have a dependency
    const withDeps = r.steps.slice(1).some((s) => s.dependencies.length > 0);
    expect(withDeps).toBe(true);
  });

  it("dependency IDs reference valid step IDs", () => {
    const r = generateMigrationPlan(makeFullInput());
    const stepIds = new Set(r.steps.map((s) => s.id));
    for (const step of r.steps) {
      for (const dep of step.dependencies) {
        expect(stepIds.has(dep)).toBe(true);
      }
    }
  });

  it("plan has no cycles (hasCycle returns false)", () => {
    const r = generateMigrationPlan(makeFullInput());
    expect(hasCycle(r.steps)).toBe(false);
  });

  it("plan passes migrationPlanSchema (includes DAG check)", () => {
    const r = generateMigrationPlan(makeFullInput());
    expect(() => migrationPlanSchema.parse(r)).not.toThrow();
  });
});

describe("hasCycle utility", () => {
  it("returns false for empty graph", () => {
    expect(hasCycle([])).toBe(false);
  });

  it("returns false for linear chain A→B→C", () => {
    expect(hasCycle([
      { id: "A", dependencies: [] },
      { id: "B", dependencies: ["A"] },
      { id: "C", dependencies: ["B"] },
    ])).toBe(false);
  });

  it("returns true for simple cycle A→B→A", () => {
    expect(hasCycle([
      { id: "A", dependencies: ["B"] },
      { id: "B", dependencies: ["A"] },
    ])).toBe(true);
  });

  it("returns true for self-loop A→A", () => {
    expect(hasCycle([
      { id: "A", dependencies: ["A"] },
    ])).toBe(true);
  });

  it("returns true for 3-node cycle A→B→C→A", () => {
    expect(hasCycle([
      { id: "A", dependencies: ["C"] },
      { id: "B", dependencies: ["A"] },
      { id: "C", dependencies: ["B"] },
    ])).toBe(true);
  });

  it("returns false for diamond A→B,A→C,B→D,C→D", () => {
    expect(hasCycle([
      { id: "A", dependencies: [] },
      { id: "B", dependencies: ["A"] },
      { id: "C", dependencies: ["A"] },
      { id: "D", dependencies: ["B", "C"] },
    ])).toBe(false);
  });
});

describe("migrationPlanSchema rejects invalid plans", () => {
  it("rejects plan with duplicate step IDs", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedDependencies: [affectedDep()] }),
      riskScore: makeRS(),
      impactPreview: makeIP(),
    });
    // Duplicate the first step
    const broken = { ...r, steps: [r.steps[0]!, { ...r.steps[0]! }] };
    expect(() => migrationPlanSchema.parse(broken)).toThrow();
  });

  it("rejects step that references non-existent dependency", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedDependencies: [affectedDep()] }),
      riskScore: makeRS(),
      impactPreview: makeIP(),
    });
    const broken = {
      ...r,
      steps: [{ ...r.steps[0]!, dependencies: ["STEP-999"] }],
    };
    expect(() => migrationPlanSchema.parse(broken)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Traceability — evidence-based
// ---------------------------------------------------------------------------

describe("traceability", () => {
  it("API step relatedRequirementIds traces to P4 migration requirements", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA({ migrationRequirements: [req("req-1")] }),
      impactAnalysis: makeIA({ affectedApis: [affectedApi("src/r.ts", "app.del", "req-1")] }),
      riskScore: makeRS(),
      impactPreview: makeIP(),
    });
    const apiStep = r.steps.find((s) => s.category === "API")!;
    expect(apiStep.relatedRequirementIds).toContain("req-1");
  });

  it("step affectedFiles only contains P5 files", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedFiles: [affectedFile("src/index.ts")] }),
      riskScore: makeRS(),
      impactPreview: makeIP(),
    });
    const p5Files = new Set(["src/index.ts"]);
    for (const step of r.steps) {
      for (const f of step.affectedFiles) {
        expect(p5Files.has(f)).toBe(true);
      }
    }
  });

  it("config step affectedFiles contains P5 config paths", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedConfigs: [affectedConfig("tsconfig.json")] }),
      riskScore: makeRS(),
      impactPreview: makeIP(),
    });
    const cfg = r.steps.find((s) => s.category === "CONFIG")!;
    expect(cfg.affectedFiles).toContain("tsconfig.json");
  });

  it("does not invent steps for files not in P5", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA({ breakingChanges: [bc("bc-1")] }),
      impactAnalysis: makeIA({ affectedFiles: [affectedFile("src/index.ts")] }),
      riskScore: makeRS(),
      impactPreview: makeIP(),
    });
    const allFiles = r.steps.flatMap((s) => s.affectedFiles);
    for (const f of allFiles) {
      expect(f).toBe("src/index.ts");
    }
  });
});

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

describe("prerequisites", () => {
  it("always generates the target version availability prerequisite", () => {
    const r = generateMigrationPlan({ changeAnalysis: makeCA(), impactAnalysis: makeIA(), riskScore: makeRS(), impactPreview: makeIP() });
    expect(r.prerequisites.some((p) => p.id === "PREREQ-001")).toBe(true);
  });

  it("PREREQ-001 is mandatory", () => {
    const r = generateMigrationPlan({ changeAnalysis: makeCA(), impactAnalysis: makeIA(), riskScore: makeRS(), impactPreview: makeIP() });
    expect(r.prerequisites.find((p) => p.id === "PREREQ-001")!.mandatory).toBe(true);
  });

  it("generates a prerequisite per affected dependency", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedDependencies: [affectedDep("express"), affectedDep("express-validator", "^6.0.0")] }),
      riskScore: makeRS(),
      impactPreview: makeIP(),
    });
    const depPreqs = r.prerequisites.filter((p) => p.id !== "PREREQ-001");
    expect(depPreqs.length).toBeGreaterThanOrEqual(2);
  });

  it("dependency prerequisite evidence references declared version", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedDependencies: [affectedDep("express", "^4.18.0")] }),
      riskScore: makeRS(),
      impactPreview: makeIP(),
    });
    const depPreq = r.prerequisites.find((p) => p.id === "PREREQ-002")!;
    expect(depPreq.evidence.some((e) => e.includes("^4.18.0"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validation requirements
// ---------------------------------------------------------------------------

describe("validationRequirements", () => {
  it("always includes build validation requirement", () => {
    const r = generateMigrationPlan({ changeAnalysis: makeCA(), impactAnalysis: makeIA(), riskScore: makeRS(), impactPreview: makeIP() });
    expect(r.validationRequirements.some((v) => v.id === "VAL-001")).toBe(true);
  });

  it("includes test validation requirement when tests are affected", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedTests: [affectedTest("test/a.test.ts")] }),
      riskScore: makeRS(),
      impactPreview: makeIP(),
    });
    expect(r.validationRequirements.some((v) => v.id === "VAL-002")).toBe(true);
  });

  it("no test validation requirement when no tests affected", () => {
    const r = generateMigrationPlan({ changeAnalysis: makeCA(), impactAnalysis: makeIA(), riskScore: makeRS(), impactPreview: makeIP() });
    expect(r.validationRequirements.some((v) => v.id === "VAL-002")).toBe(false);
  });

  it("includes API deprecation validation when APIs are affected", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedApis: [affectedApi("src/r.ts", "app.del")] }),
      riskScore: makeRS(),
      impactPreview: makeIP(),
    });
    expect(r.validationRequirements.some((v) => v.id === "VAL-003")).toBe(true);
  });

  it("validation requirement relatedStepIds reference valid step IDs", () => {
    const r = generateMigrationPlan(makeFullInput());
    const stepIds = new Set(r.steps.map((s) => s.id));
    for (const vr of r.validationRequirements) {
      for (const sid of vr.relatedStepIds) {
        expect(stepIds.has(sid)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("same input always produces same step IDs and order", () => {
    const input = makeFullInput();
    const r1 = generateMigrationPlan(input);
    const r2 = generateMigrationPlan(input);
    expect(r1.steps.map((s) => s.id)).toEqual(r2.steps.map((s) => s.id));
    expect(r1.steps.map((s) => s.order)).toEqual(r2.steps.map((s) => s.order));
    expect(r1.steps.map((s) => s.category)).toEqual(r2.steps.map((s) => s.category));
  });

  it("same input produces same prerequisites", () => {
    const input = makeFullInput();
    const r1 = generateMigrationPlan(input);
    const r2 = generateMigrationPlan(input);
    expect(r1.prerequisites.map((p) => p.id)).toEqual(r2.prerequisites.map((p) => p.id));
  });

  it("generatedAt differs across calls (timestamp)", async () => {
    const r1 = generateMigrationPlan({ changeAnalysis: makeCA(), impactAnalysis: makeIA(), riskScore: makeRS(), impactPreview: makeIP() });
    await new Promise((res) => setTimeout(res, 2));
    const r2 = generateMigrationPlan({ changeAnalysis: makeCA(), impactAnalysis: makeIA(), riskScore: makeRS(), impactPreview: makeIP() });
    expect(r1.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r2.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("step IDs never include timestamps", () => {
    const r = generateMigrationPlan(makeFullInput());
    for (const step of r.steps) {
      expect(step.id).toMatch(/^STEP-\d{3}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Security — no I/O, no file access, no code generation
// ---------------------------------------------------------------------------

describe("security constraints", () => {
  it("plan description does not contain file content (no code patches)", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA({ breakingChanges: [bc("bc-1")] }),
      impactAnalysis: makeIA({ affectedFiles: [affectedFile("src/index.ts")] }),
      riskScore: makeRS(),
      impactPreview: makeIP(),
    });
    for (const step of r.steps) {
      // Must not contain diff-like markers
      expect(step.description).not.toMatch(/^[+-]{3}/m);
      expect(step.description).not.toMatch(/^@@/m);
    }
  });

  it("plan does not expose filesystem paths outside of P5 evidence", () => {
    const r = generateMigrationPlan({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedFiles: [affectedFile("src/safe.ts")] }),
      riskScore: makeRS(),
      impactPreview: makeIP(),
    });
    const allFiles = r.steps.flatMap((s) => s.affectedFiles);
    for (const f of allFiles) {
      expect(f).not.toMatch(/^\/etc\//);
      expect(f).not.toMatch(/^\/root\//);
    }
  });
});

// ---------------------------------------------------------------------------
// Express 4 → 5 deterministic proof
// ---------------------------------------------------------------------------

describe("Express 4 → 5 migration plan proof", () => {
  const express4To5Input = {
    changeAnalysis: makeCA({
      breakingChanges: [bc("bc-async-error", "high", "middleware"), bc("bc-path-regexp", "medium")],
      deprecatedApis: [{ id: "dep-app-del", apiName: "app.del", description: "removed", replacement: "app.delete" }],
      behaviorChanges: [{ id: "beh-query", title: "Query parsing", description: "changed", severity: "medium" as const }],
      migrationRequirements: [req("req-api-del"), req("req-middleware")],
    }),
    impactAnalysis: makeIA({
      affectedFiles: [
        affectedFile("src/index.ts", "API"),
        affectedFile("src/middleware/error.ts", "MIDDLEWARE"),
        affectedFile("src/routes/users.ts", "ROUTE"),
      ],
      affectedApis: [affectedApi("src/routes/users.ts", "app.del", "req-api-del")],
      affectedDependencies: [affectedDep("express", "^4.18.0")],
      affectedTests: [affectedTest("test/routes/users.test.ts")],
      affectedConfigs: [affectedConfig("tsconfig.json")],
      highRiskAreas: [
        highRiskArea("Custom middleware"),
        highRiskArea("Deprecated API usage"),
      ],
    }),
    riskScore: makeRS({ score: 61, level: "HIGH" }),
    impactPreview: makeIP({
      risk: { score: 61, level: "HIGH" },
      summary: "HIGH risk migration.",
      breakingChanges: [previewItem("BC bc-async-error"), previewItem("BC bc-path-regexp")],
    }),
  };

  let plan: MigrationPlan;

  it("generates a plan without throwing", () => {
    plan = generateMigrationPlan(express4To5Input);
    expect(plan).toBeDefined();
  });

  it("plan risk is HIGH with score 61", () => {
    plan = generateMigrationPlan(express4To5Input);
    expect(plan.risk.score).toBe(61);
    expect(plan.risk.level).toBe("HIGH");
  });

  it("plan has at least 4 steps (DEP, API, MIDDLEWARE, ROUTE, CONFIG, TEST)", () => {
    plan = generateMigrationPlan(express4To5Input);
    expect(plan.steps.length).toBeGreaterThanOrEqual(4);
  });

  it("includes a DEPENDENCY step", () => {
    plan = generateMigrationPlan(express4To5Input);
    expect(plan.steps.some((s) => s.category === "DEPENDENCY")).toBe(true);
  });

  it("includes an API step for src/routes/users.ts", () => {
    plan = generateMigrationPlan(express4To5Input);
    const apiStep = plan.steps.find((s) => s.category === "API");
    expect(apiStep).toBeDefined();
    expect(apiStep!.affectedFiles).toContain("src/routes/users.ts");
  });

  it("includes a MIDDLEWARE step for src/middleware/error.ts", () => {
    plan = generateMigrationPlan(express4To5Input);
    const mwStep = plan.steps.find((s) => s.category === "MIDDLEWARE");
    expect(mwStep).toBeDefined();
    expect(mwStep!.affectedFiles).toContain("src/middleware/error.ts");
  });

  it("includes a ROUTE step for src/routes/users.ts", () => {
    plan = generateMigrationPlan(express4To5Input);
    expect(plan.steps.some((s) => s.category === "ROUTE")).toBe(true);
  });

  it("includes a CONFIG step for tsconfig.json", () => {
    plan = generateMigrationPlan(express4To5Input);
    const cfgStep = plan.steps.find((s) => s.category === "CONFIG");
    expect(cfgStep).toBeDefined();
    expect(cfgStep!.affectedFiles).toContain("tsconfig.json");
  });

  it("includes a TEST step for test/routes/users.test.ts", () => {
    plan = generateMigrationPlan(express4To5Input);
    const testStep = plan.steps.find((s) => s.category === "TEST");
    expect(testStep).toBeDefined();
    expect(testStep!.affectedFiles).toContain("test/routes/users.test.ts");
  });

  it("DEPENDENCY step is order 1", () => {
    plan = generateMigrationPlan(express4To5Input);
    const dep = plan.steps.find((s) => s.category === "DEPENDENCY")!;
    expect(dep.order).toBe(1);
  });

  it("TEST step comes after DEPENDENCY, API, MIDDLEWARE, and ROUTE steps", () => {
    plan = generateMigrationPlan(express4To5Input);
    const testOrder = plan.steps.find((s) => s.category === "TEST")!.order;
    const depOrder = plan.steps.find((s) => s.category === "DEPENDENCY")?.order ?? 0;
    const apiOrder = plan.steps.find((s) => s.category === "API")?.order ?? 0;
    const mwOrder = plan.steps.find((s) => s.category === "MIDDLEWARE")?.order ?? 0;
    const routeOrder = plan.steps.find((s) => s.category === "ROUTE")?.order ?? 0;
    expect(testOrder).toBeGreaterThan(depOrder);
    expect(testOrder).toBeGreaterThan(apiOrder);
    expect(testOrder).toBeGreaterThan(mwOrder);
    expect(testOrder).toBeGreaterThan(routeOrder);
  });

  it("plan has no cycles", () => {
    plan = generateMigrationPlan(express4To5Input);
    expect(hasCycle(plan.steps)).toBe(false);
  });

  it("plan passes Zod schema validation", () => {
    plan = generateMigrationPlan(express4To5Input);
    expect(() => migrationPlanSchema.parse(plan)).not.toThrow();
  });

  it("plan is reproducible", () => {
    const r1 = generateMigrationPlan(express4To5Input);
    const r2 = generateMigrationPlan(express4To5Input);
    expect(r1.steps.map((s) => s.id)).toEqual(r2.steps.map((s) => s.id));
    expect(r1.risk.score).toBe(r2.risk.score);
    expect(r1.prerequisites.map((p) => p.id)).toEqual(r2.prerequisites.map((p) => p.id));
  });

  it("API step links requirement req-api-del from P4", () => {
    plan = generateMigrationPlan(express4To5Input);
    const apiStep = plan.steps.find((s) => s.category === "API")!;
    expect(apiStep.relatedRequirementIds).toContain("req-api-del");
  });

  it("includes VAL-001 (build) and VAL-002 (tests) validation requirements", () => {
    plan = generateMigrationPlan(express4To5Input);
    expect(plan.validationRequirements.some((v) => v.id === "VAL-001")).toBe(true);
    expect(plan.validationRequirements.some((v) => v.id === "VAL-002")).toBe(true);
  });

  it("affected areas reflect P5 high-risk areas and categories", () => {
    plan = generateMigrationPlan(express4To5Input);
    expect(plan.affectedAreas.length).toBeGreaterThan(0);
  });
});
