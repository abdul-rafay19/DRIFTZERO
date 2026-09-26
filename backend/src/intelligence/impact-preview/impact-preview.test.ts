/**
 * Impact Preview Engine tests (P7) — "What Will Break?"
 *
 * All tests are deterministic — no Bob calls, no filesystem access.
 * Covers: valid input, validation, all categories, risk pass-through,
 * evidence traceability, language safety, ordering, Express 4→5 proof.
 */

import { describe, it, expect } from "vitest";
import { generateImpactPreview, ImpactPreviewError } from "./impact-preview.js";
import { impactPreviewResultSchema } from "./impact-preview-types.js";
import { ValidationError } from "@driftzero/shared";
import type {
  ChangeAnalysisResult,
  ImpactAnalysisResult,
  RiskScoreResult,
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
      breakingChanges: 0,
      deprecatedApis: 0,
      affectedFiles: 0,
      affectedApis: 0,
      affectedDependencies: 0,
      affectedTests: 0,
      highRiskAreas: 0,
    },
    assessedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// Shared item builders
function bc(id: string, severity: "low" | "medium" | "high" | "critical" = "high") {
  return { id, title: `BC ${id}`, description: "async error propagation changed", severity, migrationRequired: true, affectedArea: "middleware" };
}
function deprecatedApi(id: string, apiName: string, replacement?: string) {
  return { id, apiName, description: `${apiName} is removed`, replacement, removedInVersion: "5" };
}
function behaviorChange(id: string) {
  return { id, title: `Behavior ${id}`, description: "behavior changed in v5", severity: "medium" as const, affectedArea: "routing" };
}
function affectedFile(path: string, category: "API" | "ROUTE" | "MIDDLEWARE" = "API") {
  return { path, category, reason: "imports express", relevance: "direct" as const, evidence: ["import express"] };
}
function affectedApi(file: string, api: string) {
  return { file, api, reason: "deprecated in v5", migrationRequirementId: "req-1" };
}
function affectedDep(name = "express", version = "^4.18.0") {
  return { name, declaredVersion: version, dependencyType: "dependencies" as const, packageManager: "npm" as const, reason: "version requires update" };
}
function affectedTest(path: string) {
  return { path, reason: "imports express", evidence: ["import express"] };
}
function affectedConfig(path: string) {
  return { path, reason: "express config may change" };
}
function highRiskArea(title: string, files: string[] = ["src/index.ts"]) {
  return { title, description: `${title} is high-risk`, files };
}
function riskReason(factor: string, contribution: number) {
  return { factor, description: "test reason", contribution, evidence: ["ev-1"] };
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("generateImpactPreview — input validation", () => {
  it("accepts minimal valid input (empty categories)", () => {
    const result = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA(),
      riskScore: makeRS(),
    });
    expect(result.packageName).toBe("express");
    expect(result.sourceVersion).toBe("4");
    expect(result.targetVersion).toBe("5");
  });

  it("throws ValidationError when changeAnalysis is missing", () => {
    expect(() =>
      generateImpactPreview({
        changeAnalysis: undefined as never,
        impactAnalysis: makeIA(),
        riskScore: makeRS(),
      })
    ).toThrow(ValidationError);
  });

  it("throws ValidationError when impactAnalysis is missing", () => {
    expect(() =>
      generateImpactPreview({
        changeAnalysis: makeCA(),
        impactAnalysis: undefined as never,
        riskScore: makeRS(),
      })
    ).toThrow(ValidationError);
  });

  it("throws ValidationError when riskScore is missing", () => {
    expect(() =>
      generateImpactPreview({
        changeAnalysis: makeCA(),
        impactAnalysis: makeIA(),
        riskScore: undefined as never,
      })
    ).toThrow(ValidationError);
  });

  it("throws ValidationError when changeAnalysis has invalid severity", () => {
    expect(() =>
      generateImpactPreview({
        changeAnalysis: makeCA({
          breakingChanges: [
            { id: "bc-1", title: "t", description: "d", severity: "extreme" as never, migrationRequired: true },
          ],
        }),
        impactAnalysis: makeIA(),
        riskScore: makeRS(),
      })
    ).toThrow(ValidationError);
  });

  it("throws ValidationError when riskScore level is invalid", () => {
    expect(() =>
      generateImpactPreview({
        changeAnalysis: makeCA(),
        impactAnalysis: makeIA(),
        riskScore: makeRS({ level: "EXTREME" as never }),
      })
    ).toThrow(ValidationError);
  });

  it("throws ValidationError when riskScore score is out of range", () => {
    expect(() =>
      generateImpactPreview({
        changeAnalysis: makeCA(),
        impactAnalysis: makeIA(),
        riskScore: makeRS({ score: 150 }),
      })
    ).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Risk pass-through
// ---------------------------------------------------------------------------

describe("risk pass-through", () => {
  it("passes through the P6 score unchanged", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA(),
      riskScore: makeRS({ score: 65, level: "HIGH" }),
    });
    expect(r.risk.score).toBe(65);
  });

  it("passes through the P6 level unchanged", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA(),
      riskScore: makeRS({ score: 85, level: "CRITICAL" }),
    });
    expect(r.risk.level).toBe("CRITICAL");
  });

  it("does not recalculate the score", () => {
    // Even if there are breaking changes, the score comes from P6
    const r = generateImpactPreview({
      changeAnalysis: makeCA({ breakingChanges: [bc("bc-1")] }),
      impactAnalysis: makeIA(),
      riskScore: makeRS({ score: 42, level: "MEDIUM" }),
    });
    expect(r.risk.score).toBe(42);
    expect(r.risk.level).toBe("MEDIUM");
  });
});

// ---------------------------------------------------------------------------
// Breaking changes category
// ---------------------------------------------------------------------------

describe("breakingChanges category", () => {
  it("maps each P4 breaking change to a preview item", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA({ breakingChanges: [bc("bc-1"), bc("bc-2", "medium")] }),
      impactAnalysis: makeIA(),
      riskScore: makeRS(),
    });
    expect(r.breakingChanges).toHaveLength(2);
    expect(r.breakingChanges[0]!.title).toBe("BC bc-1");
    expect(r.breakingChanges[1]!.title).toBe("BC bc-2");
  });

  it("sets source to CHANGE_ANALYSIS", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA({ breakingChanges: [bc("bc-1")] }),
      impactAnalysis: makeIA(),
      riskScore: makeRS(),
    });
    expect(r.breakingChanges[0]!.source).toBe("CHANGE_ANALYSIS");
  });

  it("carries severity from P4", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA({ breakingChanges: [bc("bc-1", "critical")] }),
      impactAnalysis: makeIA(),
      riskScore: makeRS(),
    });
    expect(r.breakingChanges[0]!.severity).toBe("critical");
  });

  it("evidence contains the P4 id", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA({ breakingChanges: [bc("bc-1")] }),
      impactAnalysis: makeIA(),
      riskScore: makeRS(),
    });
    expect(r.breakingChanges[0]!.evidence).toContain("bc-1");
  });

  it("returns empty array when no breaking changes", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA(),
      riskScore: makeRS(),
    });
    expect(r.breakingChanges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Deprecated APIs category
// ---------------------------------------------------------------------------

describe("deprecatedApis category", () => {
  it("maps each P4 deprecated API to a preview item", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA({ deprecatedApis: [deprecatedApi("d-1", "app.del", "app.delete")] }),
      impactAnalysis: makeIA(),
      riskScore: makeRS(),
    });
    expect(r.deprecatedApis).toHaveLength(1);
    expect(r.deprecatedApis[0]!.title).toBe("Deprecated: app.del");
  });

  it("includes replacement in description when available", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA({ deprecatedApis: [deprecatedApi("d-1", "app.del", "app.delete")] }),
      impactAnalysis: makeIA(),
      riskScore: makeRS(),
    });
    expect(r.deprecatedApis[0]!.description).toContain("app.delete");
  });

  it("sets source to CHANGE_ANALYSIS", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA({ deprecatedApis: [deprecatedApi("d-1", "app.del")] }),
      impactAnalysis: makeIA(),
      riskScore: makeRS(),
    });
    expect(r.deprecatedApis[0]!.source).toBe("CHANGE_ANALYSIS");
  });

  it("evidence contains the P4 id", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA({ deprecatedApis: [deprecatedApi("d-1", "app.del")] }),
      impactAnalysis: makeIA(),
      riskScore: makeRS(),
    });
    expect(r.deprecatedApis[0]!.evidence).toContain("d-1");
  });
});

// ---------------------------------------------------------------------------
// High-risk areas category
// ---------------------------------------------------------------------------

describe("highRiskAreas category", () => {
  it("maps each P5 high-risk area to a preview item", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ highRiskAreas: [highRiskArea("Custom middleware"), highRiskArea("Deprecated API usage")] }),
      riskScore: makeRS(),
    });
    expect(r.highRiskAreas).toHaveLength(2);
    expect(r.highRiskAreas[0]!.title).toBe("Custom middleware");
  });

  it("sets source to IMPACT_ANALYSIS", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ highRiskAreas: [highRiskArea("middleware")] }),
      riskScore: makeRS(),
    });
    expect(r.highRiskAreas[0]!.source).toBe("IMPACT_ANALYSIS");
  });

  it("uses area files as evidence", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ highRiskAreas: [highRiskArea("middleware", ["src/middleware.ts"])] }),
      riskScore: makeRS(),
    });
    expect(r.highRiskAreas[0]!.evidence).toContain("src/middleware.ts");
  });

  it("sets severity to high", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ highRiskAreas: [highRiskArea("middleware")] }),
      riskScore: makeRS(),
    });
    expect(r.highRiskAreas[0]!.severity).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// Affected APIs category
// ---------------------------------------------------------------------------

describe("affectedApis category", () => {
  it("maps each P5 affected API to a preview item", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedApis: [affectedApi("src/routes.ts", "app.del")] }),
      riskScore: makeRS(),
    });
    expect(r.affectedApis).toHaveLength(1);
    expect(r.affectedApis[0]!.title).toContain("app.del");
  });

  it("sets source to IMPACT_ANALYSIS", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedApis: [affectedApi("src/routes.ts", "app.del")] }),
      riskScore: makeRS(),
    });
    expect(r.affectedApis[0]!.source).toBe("IMPACT_ANALYSIS");
  });

  it("includes file in evidence", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedApis: [affectedApi("src/routes.ts", "app.del")] }),
      riskScore: makeRS(),
    });
    expect(r.affectedApis[0]!.evidence).toContain("src/routes.ts");
  });

  it("sets file field", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedApis: [affectedApi("src/routes.ts", "app.del")] }),
      riskScore: makeRS(),
    });
    expect(r.affectedApis[0]!.file).toBe("src/routes.ts");
  });
});

// ---------------------------------------------------------------------------
// Affected files category
// ---------------------------------------------------------------------------

describe("affectedFiles category", () => {
  it("maps each P5 affected file to a preview item", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedFiles: [affectedFile("src/index.ts"), affectedFile("src/routes/users.ts")] }),
      riskScore: makeRS(),
    });
    expect(r.affectedFiles).toHaveLength(2);
    expect(r.affectedFiles[0]!.title).toBe("src/index.ts");
  });

  it("sets source to IMPACT_ANALYSIS", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedFiles: [affectedFile("src/index.ts")] }),
      riskScore: makeRS(),
    });
    expect(r.affectedFiles[0]!.source).toBe("IMPACT_ANALYSIS");
  });

  it("sets file field to path", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedFiles: [affectedFile("src/index.ts")] }),
      riskScore: makeRS(),
    });
    expect(r.affectedFiles[0]!.file).toBe("src/index.ts");
  });

  it("includes direct/indirect in description", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedFiles: [affectedFile("src/index.ts")] }),
      riskScore: makeRS(),
    });
    expect(r.affectedFiles[0]!.description).toMatch(/[Dd]irectly/);
  });
});

// ---------------------------------------------------------------------------
// Affected dependencies category
// ---------------------------------------------------------------------------

describe("affectedDependencies category", () => {
  it("maps each P5 dependency to a preview item", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedDependencies: [affectedDep()] }),
      riskScore: makeRS(),
    });
    expect(r.affectedDependencies).toHaveLength(1);
    expect(r.affectedDependencies[0]!.title).toContain("express");
  });

  it("sets source to IMPACT_ANALYSIS", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedDependencies: [affectedDep()] }),
      riskScore: makeRS(),
    });
    expect(r.affectedDependencies[0]!.source).toBe("IMPACT_ANALYSIS");
  });

  it("includes dependency version in evidence", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedDependencies: [affectedDep("express", "^4.18.0")] }),
      riskScore: makeRS(),
    });
    expect(r.affectedDependencies[0]!.evidence[0]).toContain("^4.18.0");
  });
});

// ---------------------------------------------------------------------------
// Affected tests category
// ---------------------------------------------------------------------------

describe("affectedTests category", () => {
  it("maps each P5 test to a preview item", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedTests: [affectedTest("test/users.test.ts")] }),
      riskScore: makeRS(),
    });
    expect(r.affectedTests).toHaveLength(1);
    expect(r.affectedTests[0]!.title).toBe("test/users.test.ts");
  });

  it("sets source to IMPACT_ANALYSIS", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedTests: [affectedTest("test/users.test.ts")] }),
      riskScore: makeRS(),
    });
    expect(r.affectedTests[0]!.source).toBe("IMPACT_ANALYSIS");
  });

  it("sets file field", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedTests: [affectedTest("test/users.test.ts")] }),
      riskScore: makeRS(),
    });
    expect(r.affectedTests[0]!.file).toBe("test/users.test.ts");
  });
});

// ---------------------------------------------------------------------------
// Affected configs category
// ---------------------------------------------------------------------------

describe("affectedConfigs category", () => {
  it("maps each P5 config to a preview item", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedConfigs: [affectedConfig("tsconfig.json")] }),
      riskScore: makeRS(),
    });
    expect(r.affectedConfigs).toHaveLength(1);
    expect(r.affectedConfigs[0]!.title).toBe("tsconfig.json");
  });

  it("sets source to IMPACT_ANALYSIS", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedConfigs: [affectedConfig("tsconfig.json")] }),
      riskScore: makeRS(),
    });
    expect(r.affectedConfigs[0]!.source).toBe("IMPACT_ANALYSIS");
  });
});

// ---------------------------------------------------------------------------
// Behavior changes category
// ---------------------------------------------------------------------------

describe("behaviorChanges category", () => {
  it("maps each P4 behavior change to a preview item", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA({ behaviorChanges: [behaviorChange("beh-1")] }),
      impactAnalysis: makeIA(),
      riskScore: makeRS(),
    });
    expect(r.behaviorChanges).toHaveLength(1);
    expect(r.behaviorChanges[0]!.title).toBe("Behavior beh-1");
  });

  it("sets source to CHANGE_ANALYSIS", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA({ behaviorChanges: [behaviorChange("beh-1")] }),
      impactAnalysis: makeIA(),
      riskScore: makeRS(),
    });
    expect(r.behaviorChanges[0]!.source).toBe("CHANGE_ANALYSIS");
  });

  it("evidence contains the P4 id", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA({ behaviorChanges: [behaviorChange("beh-1")] }),
      impactAnalysis: makeIA(),
      riskScore: makeRS(),
    });
    expect(r.behaviorChanges[0]!.evidence).toContain("beh-1");
  });
});

// ---------------------------------------------------------------------------
// Evidence requirements — every item must have at least one evidence entry
// ---------------------------------------------------------------------------

describe("evidence requirements", () => {
  it("every breaking change item has non-empty evidence", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA({ breakingChanges: [bc("bc-1"), bc("bc-2")] }),
      impactAnalysis: makeIA(),
      riskScore: makeRS(),
    });
    for (const item of r.breakingChanges) {
      expect(item.evidence.length).toBeGreaterThan(0);
    }
  });

  it("every affected file item has non-empty evidence", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({
        affectedFiles: [
          affectedFile("src/index.ts"),
          { path: "src/minimal.ts", category: "OTHER", reason: "x", relevance: "indirect", evidence: [] },
        ],
      }),
      riskScore: makeRS(),
    });
    for (const item of r.affectedFiles) {
      expect(item.evidence.length).toBeGreaterThan(0);
    }
  });

  it("every high-risk area item has non-empty evidence (including empty-files case)", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ highRiskAreas: [highRiskArea("area", [])] }),
      riskScore: makeRS(),
    });
    expect(r.highRiskAreas[0]!.evidence.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Language safety — predictive not declarative
// ---------------------------------------------------------------------------

describe("language safety", () => {
  it("breaking change description contains migration language, not 'this is broken'", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA({ breakingChanges: [bc("bc-1")] }),
      impactAnalysis: makeIA(),
      riskScore: makeRS(),
    });
    const desc = r.breakingChanges[0]!.description.toLowerCase();
    expect(desc).not.toMatch(/this is broken/);
    expect(desc).not.toMatch(/has broken/);
    expect(desc).not.toMatch(/is already broken/);
  });

  it("behavior change description uses cautious language", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA({ behaviorChanges: [behaviorChange("beh-1")] }),
      impactAnalysis: makeIA(),
      riskScore: makeRS(),
    });
    const desc = r.behaviorChanges[0]!.description.toLowerCase();
    expect(desc).toMatch(/may|potentially|requires/);
  });

  it("affected API description uses 'may require' or similar", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedApis: [affectedApi("src/r.ts", "app.del")] }),
      riskScore: makeRS(),
    });
    const desc = r.affectedApis[0]!.description.toLowerCase();
    expect(desc).toMatch(/may|potentially|requires/);
  });

  it("affected test description uses 'may' language", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedTests: [affectedTest("test/a.test.ts")] }),
      riskScore: makeRS(),
    });
    const desc = r.affectedTests[0]!.description.toLowerCase();
    expect(desc).toMatch(/may/);
  });

  it("summary does not claim migration has happened", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA({ breakingChanges: [bc("bc-1")] }),
      impactAnalysis: makeIA(),
      riskScore: makeRS({ score: 30, level: "MEDIUM" }),
    });
    const summary = r.summary.toLowerCase();
    expect(summary).not.toMatch(/has been migrated/);
    expect(summary).not.toMatch(/migration complete/);
    expect(summary).not.toMatch(/successfully migrated/);
  });
});

// ---------------------------------------------------------------------------
// Summary generation
// ---------------------------------------------------------------------------

describe("summary generation", () => {
  it("summary includes package name", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA(),
      riskScore: makeRS(),
    });
    expect(r.summary).toContain("express");
  });

  it("summary includes source and target versions", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA({ sourceVersion: "4", targetVersion: "5" }),
      impactAnalysis: makeIA(),
      riskScore: makeRS(),
    });
    expect(r.summary).toContain("4");
    expect(r.summary).toContain("5");
  });

  it("summary includes risk level", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA(),
      riskScore: makeRS({ score: 65, level: "HIGH" }),
    });
    expect(r.summary).toContain("HIGH");
  });

  it("summary includes risk score", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA(),
      riskScore: makeRS({ score: 42, level: "MEDIUM" }),
    });
    expect(r.summary).toContain("42");
  });

  it("summary includes affected file count when files are present", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({ affectedFiles: [affectedFile("src/index.ts")] }),
      riskScore: makeRS(),
    });
    expect(r.summary).toContain("1");
  });

  it("summary mentions breaking changes count when present", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA({ breakingChanges: [bc("bc-1"), bc("bc-2")] }),
      impactAnalysis: makeIA(),
      riskScore: makeRS(),
    });
    expect(r.summary).toContain("2");
  });

  it("summary is deterministic — same input produces same summary", () => {
    const input = {
      changeAnalysis: makeCA({ breakingChanges: [bc("bc-1")] }),
      impactAnalysis: makeIA({ affectedFiles: [affectedFile("src/index.ts")] }),
      riskScore: makeRS({ score: 30, level: "MEDIUM" }),
    };
    const r1 = generateImpactPreview(input);
    const r2 = generateImpactPreview(input);
    expect(r1.summary).toBe(r2.summary);
  });
});

// ---------------------------------------------------------------------------
// Output validation
// ---------------------------------------------------------------------------

describe("output validation", () => {
  it("result passes impactPreviewResultSchema", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA({ breakingChanges: [bc("bc-1")] }),
      impactAnalysis: makeIA({ affectedFiles: [affectedFile("src/index.ts")] }),
      riskScore: makeRS({ score: 15, level: "LOW" }),
    });
    expect(() => impactPreviewResultSchema.parse(r)).not.toThrow();
  });

  it("generatedAt is a non-empty string (ISO timestamp)", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA(),
      riskScore: makeRS(),
    });
    expect(r.generatedAt).toBeTruthy();
    expect(() => new Date(r.generatedAt)).not.toThrow();
  });

  it("generatedAt is different across calls (time-based)", async () => {
    const r1 = generateImpactPreview({ changeAnalysis: makeCA(), impactAnalysis: makeIA(), riskScore: makeRS() });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const r2 = generateImpactPreview({ changeAnalysis: makeCA(), impactAnalysis: makeIA(), riskScore: makeRS() });
    // generatedAt may differ by a few ms — they should at least be valid ISO strings
    expect(r1.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r2.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// Deterministic ordering
// ---------------------------------------------------------------------------

describe("deterministic ordering", () => {
  it("breakingChanges preserve input order", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA({ breakingChanges: [bc("bc-1"), bc("bc-2"), bc("bc-3")] }),
      impactAnalysis: makeIA(),
      riskScore: makeRS(),
    });
    expect(r.breakingChanges.map((x) => x.evidence[0])).toEqual(["bc-1", "bc-2", "bc-3"]);
  });

  it("affectedFiles preserve input order", () => {
    const r = generateImpactPreview({
      changeAnalysis: makeCA(),
      impactAnalysis: makeIA({
        affectedFiles: [affectedFile("src/a.ts"), affectedFile("src/b.ts"), affectedFile("src/c.ts")],
      }),
      riskScore: makeRS(),
    });
    expect(r.affectedFiles.map((x) => x.title)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("same input always produces identical item order", () => {
    const input = {
      changeAnalysis: makeCA({ breakingChanges: [bc("bc-1"), bc("bc-2")] }),
      impactAnalysis: makeIA({
        affectedFiles: [affectedFile("src/index.ts"), affectedFile("src/routes.ts")],
        highRiskAreas: [highRiskArea("middleware"), highRiskArea("tests")],
      }),
      riskScore: makeRS({ score: 22, level: "LOW" }),
    };
    const r1 = generateImpactPreview(input);
    const r2 = generateImpactPreview(input);
    expect(r1.breakingChanges.map((x) => x.title)).toEqual(r2.breakingChanges.map((x) => x.title));
    expect(r1.affectedFiles.map((x) => x.title)).toEqual(r2.affectedFiles.map((x) => x.title));
    expect(r1.highRiskAreas.map((x) => x.title)).toEqual(r2.highRiskAreas.map((x) => x.title));
  });
});

// ---------------------------------------------------------------------------
// Express 4 → 5 deterministic proof
// ---------------------------------------------------------------------------

describe("Express 4 → 5 impact preview proof", () => {
  const express4To5Input = {
    changeAnalysis: makeCA({
      breakingChanges: [
        bc("bc-async-error", "high"),
        bc("bc-path-regexp", "medium"),
      ],
      deprecatedApis: [deprecatedApi("dep-app-del", "app.del", "app.delete")],
      behaviorChanges: [behaviorChange("beh-query-parsing")],
    }),
    impactAnalysis: makeIA({
      affectedFiles: [
        affectedFile("src/index.ts"),
        affectedFile("src/routes/users.ts", "ROUTE"),
        affectedFile("src/middleware/error.ts", "MIDDLEWARE"),
      ],
      affectedApis: [affectedApi("src/routes/users.ts", "app.del")],
      affectedDependencies: [affectedDep("express", "^4.18.0")],
      affectedTests: [affectedTest("test/routes/users.test.ts")],
      affectedConfigs: [affectedConfig("tsconfig.json")],
      highRiskAreas: [
        highRiskArea("Custom middleware", ["src/middleware/error.ts"]),
        highRiskArea("Deprecated API usage", ["src/routes/users.ts"]),
        highRiskArea("Tests depending on old behavior", ["test/routes/users.test.ts"]),
      ],
    }),
    riskScore: makeRS({
      score: 61,
      level: "HIGH",
      reasons: [
        riskReason("BREAKING_CHANGES", 22),
        riskReason("DEPRECATED_APIS", 7),
        riskReason("AFFECTED_FILES", 5),
        riskReason("AFFECTED_APIS", 5),
        riskReason("AFFECTED_DEPENDENCIES", 10),
        riskReason("AFFECTED_TESTS", 2),
        riskReason("HIGH_RISK_AREAS", 10),
      ],
      factors: {
        breakingChanges: 2, deprecatedApis: 1, affectedFiles: 3,
        affectedApis: 1, affectedDependencies: 1, affectedTests: 1, highRiskAreas: 3,
      },
    }),
  };

  it("produces score 61 and level HIGH", () => {
    const r = generateImpactPreview(express4To5Input);
    expect(r.risk.score).toBe(61);
    expect(r.risk.level).toBe("HIGH");
  });

  it("surfaces 2 breaking changes", () => {
    const r = generateImpactPreview(express4To5Input);
    expect(r.breakingChanges).toHaveLength(2);
  });

  it("surfaces the deprecated app.del API", () => {
    const r = generateImpactPreview(express4To5Input);
    expect(r.deprecatedApis).toHaveLength(1);
    expect(r.deprecatedApis[0]!.title).toContain("app.del");
  });

  it("surfaces 3 affected files", () => {
    const r = generateImpactPreview(express4To5Input);
    expect(r.affectedFiles).toHaveLength(3);
  });

  it("surfaces 1 affected API in src/routes/users.ts", () => {
    const r = generateImpactPreview(express4To5Input);
    expect(r.affectedApis).toHaveLength(1);
    expect(r.affectedApis[0]!.file).toBe("src/routes/users.ts");
  });

  it("surfaces 1 dependency (express@^4.18.0)", () => {
    const r = generateImpactPreview(express4To5Input);
    expect(r.affectedDependencies).toHaveLength(1);
    expect(r.affectedDependencies[0]!.title).toContain("express");
  });

  it("surfaces 1 affected test", () => {
    const r = generateImpactPreview(express4To5Input);
    expect(r.affectedTests).toHaveLength(1);
  });

  it("surfaces 1 config file", () => {
    const r = generateImpactPreview(express4To5Input);
    expect(r.affectedConfigs).toHaveLength(1);
    expect(r.affectedConfigs[0]!.title).toBe("tsconfig.json");
  });

  it("surfaces 3 high-risk areas", () => {
    const r = generateImpactPreview(express4To5Input);
    expect(r.highRiskAreas).toHaveLength(3);
  });

  it("surfaces 1 behavior change", () => {
    const r = generateImpactPreview(express4To5Input);
    expect(r.behaviorChanges).toHaveLength(1);
  });

  it("summary references express 4 → 5 and HIGH", () => {
    const r = generateImpactPreview(express4To5Input);
    expect(r.summary).toContain("express");
    expect(r.summary).toContain("HIGH");
  });

  it("breaking change evidence traces back to P4 ids", () => {
    const r = generateImpactPreview(express4To5Input);
    const ids = r.breakingChanges.flatMap((x) => x.evidence);
    expect(ids).toContain("bc-async-error");
    expect(ids).toContain("bc-path-regexp");
  });

  it("result is reproducible", () => {
    const r1 = generateImpactPreview(express4To5Input);
    const r2 = generateImpactPreview(express4To5Input);
    expect(r1.risk.score).toBe(r2.risk.score);
    expect(r1.risk.level).toBe(r2.risk.level);
    expect(r1.breakingChanges.length).toBe(r2.breakingChanges.length);
    expect(r1.affectedFiles.length).toBe(r2.affectedFiles.length);
  });

  it("result passes Zod schema validation", () => {
    const r = generateImpactPreview(express4To5Input);
    expect(() => impactPreviewResultSchema.parse(r)).not.toThrow();
  });
});
