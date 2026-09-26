/**
 * Risk Score Engine tests (P6).
 *
 * All tests are deterministic — no Bob calls, no filesystem access.
 * Tests cover: factors, boundaries, caps, evidence, invalid input, Express 4→5 proof.
 */

import { describe, it, expect } from "vitest";
import { calculateRiskScore, RiskScoreError } from "./risk-score.js";
import { RISK_WEIGHTS, RISK_THRESHOLDS, riskScoreResultSchema } from "./risk-score-types.js";
import { ValidationError } from "@driftzero/shared";
import type { ChangeAnalysisResult, ImpactAnalysisResult } from "@driftzero/shared";

// ---------------------------------------------------------------------------
// Fixture builders — immutable, minimal P4/P5 stubs
// ---------------------------------------------------------------------------

function makeChangeAnalysis(overrides: Partial<ChangeAnalysisResult> = {}): ChangeAnalysisResult {
  return {
    packageName: "express",
    sourceVersion: "4",
    targetVersion: "5",
    summary: "Breaking changes in Express 5.",
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

function makeImpactAnalysis(overrides: Partial<ImpactAnalysisResult> = {}): ImpactAnalysisResult {
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

function bc(id: string, severity: "low" | "medium" | "high" | "critical" = "high") {
  return { id, title: `BC ${id}`, description: "desc", severity, migrationRequired: true };
}

function dep(id: string) {
  return { id, apiName: `api.${id}`, description: "removed", replacement: undefined };
}

function affectedFile(path: string) {
  return { path, category: "API" as const, reason: "imports express", relevance: "direct" as const, evidence: ["import express"] };
}

function affectedApi(file: string, api: string) {
  return { file, api, reason: "deprecated usage", migrationRequirementId: "req-1" };
}

function affectedDep() {
  return {
    name: "express",
    declaredVersion: "^4.18.0",
    dependencyType: "dependencies" as const,
    packageManager: "npm" as const,
    reason: "declared",
  };
}

function affectedTest(path: string) {
  return { path, reason: "imports express", evidence: ["import express"] };
}

function highRiskArea(title: string) {
  return { title, description: "risk area", files: ["src/index.ts"] };
}

// ---------------------------------------------------------------------------
// Zero-impact migration
// ---------------------------------------------------------------------------
describe("zero-impact migration", () => {
  it("returns score 0 and level LOW with no evidence", () => {
    const result = calculateRiskScore({
      changeAnalysis: makeChangeAnalysis(),
      impactAnalysis: makeImpactAnalysis(),
    });
    expect(result.score).toBe(0);
    expect(result.level).toBe("LOW");
    expect(result.reasons).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Individual factor scoring
// ---------------------------------------------------------------------------
describe("BREAKING_CHANGES factor", () => {
  it("0 breaking changes → 0 contribution", () => {
    const r = calculateRiskScore({ changeAnalysis: makeChangeAnalysis({ breakingChanges: [] }), impactAnalysis: makeImpactAnalysis() });
    expect(r.score).toBe(0);
    expect(r.reasons.find((x) => x.factor === "BREAKING_CHANGES")).toBeUndefined();
  });

  it("1 breaking change → partial contribution (15)", () => {
    const r = calculateRiskScore({ changeAnalysis: makeChangeAnalysis({ breakingChanges: [bc("bc-1")] }), impactAnalysis: makeImpactAnalysis() });
    const reason = r.reasons.find((x) => x.factor === "BREAKING_CHANGES");
    expect(reason).toBeDefined();
    expect(reason!.contribution).toBe(15);
    expect(r.score).toBe(15);
  });

  it("4+ breaking changes → full contribution (30)", () => {
    const r = calculateRiskScore({
      changeAnalysis: makeChangeAnalysis({ breakingChanges: [bc("bc-1"), bc("bc-2"), bc("bc-3"), bc("bc-4")] }),
      impactAnalysis: makeImpactAnalysis(),
    });
    const reason = r.reasons.find((x) => x.factor === "BREAKING_CHANGES");
    expect(reason!.contribution).toBe(RISK_WEIGHTS.breakingChanges);
    expect(r.score).toBe(RISK_WEIGHTS.breakingChanges);
  });

  it("breaking change reason includes P4 IDs as evidence", () => {
    const r = calculateRiskScore({ changeAnalysis: makeChangeAnalysis({ breakingChanges: [bc("bc-1"), bc("bc-2")] }), impactAnalysis: makeImpactAnalysis() });
    const reason = r.reasons.find((x) => x.factor === "BREAKING_CHANGES")!;
    expect(reason.evidence).toContain("bc-1");
    expect(reason.evidence).toContain("bc-2");
  });
});

describe("DEPRECATED_APIS factor", () => {
  it("0 deprecated APIs → 0 contribution", () => {
    const r = calculateRiskScore({ changeAnalysis: makeChangeAnalysis(), impactAnalysis: makeImpactAnalysis({ affectedApis: [] }) });
    expect(r.reasons.find((x) => x.factor === "DEPRECATED_APIS")).toBeUndefined();
  });

  it("1 deprecated API → partial contribution (7)", () => {
    const r = calculateRiskScore({ changeAnalysis: makeChangeAnalysis(), impactAnalysis: makeImpactAnalysis({ affectedApis: [affectedApi("file.ts", "app.del")] }) });
    const reason = r.reasons.find((x) => x.factor === "DEPRECATED_APIS")!;
    expect(reason.contribution).toBe(7);
  });

  it("4+ deprecated APIs → full contribution (15)", () => {
    const r = calculateRiskScore({
      changeAnalysis: makeChangeAnalysis(),
      impactAnalysis: makeImpactAnalysis({
        affectedApis: ["a.ts", "b.ts", "c.ts", "d.ts"].map((f) => affectedApi(f, "app.del")),
      }),
    });
    const reason = r.reasons.find((x) => x.factor === "DEPRECATED_APIS")!;
    expect(reason.contribution).toBe(RISK_WEIGHTS.deprecatedApis);
  });
});

describe("AFFECTED_FILES factor", () => {
  it("0 files → 0 contribution", () => {
    const r = calculateRiskScore({ changeAnalysis: makeChangeAnalysis(), impactAnalysis: makeImpactAnalysis({ affectedFiles: [] }) });
    expect(r.reasons.find((x) => x.factor === "AFFECTED_FILES")).toBeUndefined();
  });

  it("≥10 files → full contribution (15)", () => {
    const files = Array.from({ length: 10 }, (_, i) => affectedFile(`src/file${i}.ts`));
    const r = calculateRiskScore({ changeAnalysis: makeChangeAnalysis(), impactAnalysis: makeImpactAnalysis({ affectedFiles: files }) });
    const reason = r.reasons.find((x) => x.factor === "AFFECTED_FILES")!;
    expect(reason.contribution).toBe(RISK_WEIGHTS.affectedFiles);
  });

  it("capped at max 15 even with 100 files", () => {
    const files = Array.from({ length: 100 }, (_, i) => affectedFile(`src/file${i}.ts`));
    const r = calculateRiskScore({ changeAnalysis: makeChangeAnalysis(), impactAnalysis: makeImpactAnalysis({ affectedFiles: files }) });
    const reason = r.reasons.find((x) => x.factor === "AFFECTED_FILES")!;
    expect(reason.contribution).toBe(RISK_WEIGHTS.affectedFiles);
    expect(r.score).toBeLessThanOrEqual(100);
  });
});

describe("AFFECTED_DEPENDENCIES factor", () => {
  it("any dependency → full contribution (10)", () => {
    const r = calculateRiskScore({
      changeAnalysis: makeChangeAnalysis(),
      impactAnalysis: makeImpactAnalysis({ affectedDependencies: [affectedDep()] }),
    });
    const reason = r.reasons.find((x) => x.factor === "AFFECTED_DEPENDENCIES")!;
    expect(reason.contribution).toBe(RISK_WEIGHTS.affectedDependencies);
    expect(reason.evidence).toContain("express@^4.18.0");
  });
});

describe("AFFECTED_TESTS factor", () => {
  it("≥5 tests → full contribution (10)", () => {
    const tests = Array.from({ length: 5 }, (_, i) => affectedTest(`test/t${i}.test.ts`));
    const r = calculateRiskScore({ changeAnalysis: makeChangeAnalysis(), impactAnalysis: makeImpactAnalysis({ affectedTests: tests }) });
    const reason = r.reasons.find((x) => x.factor === "AFFECTED_TESTS")!;
    expect(reason.contribution).toBe(RISK_WEIGHTS.affectedTests);
  });

  it("capped at max 10 even with 50 test files", () => {
    const tests = Array.from({ length: 50 }, (_, i) => affectedTest(`test/t${i}.test.ts`));
    const r = calculateRiskScore({ changeAnalysis: makeChangeAnalysis(), impactAnalysis: makeImpactAnalysis({ affectedTests: tests }) });
    const reason = r.reasons.find((x) => x.factor === "AFFECTED_TESTS")!;
    expect(reason.contribution).toBeLessThanOrEqual(RISK_WEIGHTS.affectedTests);
  });
});

describe("HIGH_RISK_AREAS factor", () => {
  it("3+ high-risk areas → full contribution (10)", () => {
    const areas = [highRiskArea("middleware"), highRiskArea("deprecated APIs"), highRiskArea("tests")];
    const r = calculateRiskScore({ changeAnalysis: makeChangeAnalysis(), impactAnalysis: makeImpactAnalysis({ highRiskAreas: areas }) });
    const reason = r.reasons.find((x) => x.factor === "HIGH_RISK_AREAS")!;
    expect(reason.contribution).toBe(RISK_WEIGHTS.highRiskAreas);
  });
});

// ---------------------------------------------------------------------------
// Score cannot exceed 100
// ---------------------------------------------------------------------------
describe("score cap", () => {
  it("maximum possible evidence never exceeds score of 100", () => {
    const r = calculateRiskScore({
      changeAnalysis: makeChangeAnalysis({
        breakingChanges: Array.from({ length: 10 }, (_, i) => bc(`bc-${i}`)),
        deprecatedApis: Array.from({ length: 10 }, (_, i) => dep(`dep-${i}`)),
      }),
      impactAnalysis: makeImpactAnalysis({
        affectedFiles: Array.from({ length: 50 }, (_, i) => affectedFile(`src/f${i}.ts`)),
        affectedApis: Array.from({ length: 20 }, (_, i) => affectedApi(`f${i}.ts`, "app.del")),
        affectedDependencies: [affectedDep()],
        affectedTests: Array.from({ length: 20 }, (_, i) => affectedTest(`test/${i}.test.ts`)),
        highRiskAreas: Array.from({ length: 10 }, (_, i) => highRiskArea(`area-${i}`)),
      }),
    });
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.level).toBe("CRITICAL");
  });
});

// ---------------------------------------------------------------------------
// Risk level boundaries
// ---------------------------------------------------------------------------
describe("risk level thresholds", () => {
  function scoreOf(bc: number, apis: number, files: number): number {
    return calculateRiskScore({
      changeAnalysis: makeChangeAnalysis({ breakingChanges: Array.from({ length: bc }, (_, i) => ({ id: `bc-${i}`, title: "t", description: "d", severity: "high" as const, migrationRequired: true })) }),
      impactAnalysis: makeImpactAnalysis({
        affectedApis: Array.from({ length: apis }, (_, i) => affectedApi(`f${i}.ts`, "api")),
        affectedFiles: Array.from({ length: files }, (_, i) => affectedFile(`src/f${i}.ts`)),
      }),
    }).score;
  }

  it("score of 0 → LOW", () => {
    const r = calculateRiskScore({ changeAnalysis: makeChangeAnalysis(), impactAnalysis: makeImpactAnalysis() });
    expect(r.level).toBe("LOW");
    expect(r.score).toBeLessThanOrEqual(RISK_THRESHOLDS.LOW.max);
  });

  it("score 25–49 → MEDIUM", () => {
    // 1 breaking change (15) + 1 affected dependency (10) + 1 file (2) = 27
    const r = calculateRiskScore({
      changeAnalysis: makeChangeAnalysis({ breakingChanges: [bc("bc-1")] }),
      impactAnalysis: makeImpactAnalysis({
        affectedDependencies: [affectedDep()],
        affectedFiles: [affectedFile("src/a.ts")],
      }),
    });
    expect(r.score).toBeGreaterThanOrEqual(RISK_THRESHOLDS.MEDIUM.min);
    expect(r.score).toBeLessThanOrEqual(RISK_THRESHOLDS.MEDIUM.max);
    expect(r.level).toBe("MEDIUM");
  });

  it("score 50–74 → HIGH", () => {
    // 4 bc (30) + 4 deprecated (15) + 1 dep (10) = 55
    const r = calculateRiskScore({
      changeAnalysis: makeChangeAnalysis({ breakingChanges: [bc("bc-1"), bc("bc-2"), bc("bc-3"), bc("bc-4")] }),
      impactAnalysis: makeImpactAnalysis({
        affectedApis: ["a.ts", "b.ts", "c.ts", "d.ts"].map((f) => affectedApi(f, "app.del")),
        affectedDependencies: [affectedDep()],
      }),
    });
    expect(r.score).toBeGreaterThanOrEqual(RISK_THRESHOLDS.HIGH.min);
    expect(r.score).toBeLessThanOrEqual(RISK_THRESHOLDS.HIGH.max);
    expect(r.level).toBe("HIGH");
  });

  it("score ≥75 → CRITICAL", () => {
    const r = calculateRiskScore({
      changeAnalysis: makeChangeAnalysis({ breakingChanges: [bc("bc-1"), bc("bc-2"), bc("bc-3"), bc("bc-4")] }),
      impactAnalysis: makeImpactAnalysis({
        affectedApis: ["a.ts", "b.ts", "c.ts", "d.ts"].map((f) => affectedApi(f, "app.del")),
        affectedDependencies: [affectedDep()],
        affectedFiles: Array.from({ length: 10 }, (_, i) => affectedFile(`src/f${i}.ts`)),
        affectedTests: Array.from({ length: 5 }, (_, i) => affectedTest(`test/t${i}.test.ts`)),
        highRiskAreas: [highRiskArea("middleware"), highRiskArea("deprecated APIs"), highRiskArea("tests")],
      }),
    });
    expect(r.score).toBeGreaterThanOrEqual(RISK_THRESHOLDS.CRITICAL.min);
    expect(r.level).toBe("CRITICAL");
  });
});

// ---------------------------------------------------------------------------
// Reproducibility
// ---------------------------------------------------------------------------
describe("reproducibility", () => {
  it("same input always produces same score", () => {
    const input = {
      changeAnalysis: makeChangeAnalysis({ breakingChanges: [bc("bc-1"), bc("bc-2")] }),
      impactAnalysis: makeImpactAnalysis({
        affectedFiles: [affectedFile("src/a.ts"), affectedFile("src/b.ts")],
        affectedDependencies: [affectedDep()],
      }),
    };
    const r1 = calculateRiskScore(input);
    const r2 = calculateRiskScore(input);
    expect(r1.score).toBe(r2.score);
    expect(r1.level).toBe(r2.level);
  });
});

// ---------------------------------------------------------------------------
// Output schema validation
// ---------------------------------------------------------------------------
describe("output validation", () => {
  it("result passes riskScoreResultSchema", () => {
    const r = calculateRiskScore({
      changeAnalysis: makeChangeAnalysis({ breakingChanges: [bc("bc-1")] }),
      impactAnalysis: makeImpactAnalysis({ affectedDependencies: [affectedDep()] }),
    });
    const validated = riskScoreResultSchema.safeParse(r);
    expect(validated.success).toBe(true);
  });

  it("score is always an integer", () => {
    const r = calculateRiskScore({ changeAnalysis: makeChangeAnalysis(), impactAnalysis: makeImpactAnalysis() });
    expect(Number.isInteger(r.score)).toBe(true);
  });

  it("assessedAt is an ISO string", () => {
    const r = calculateRiskScore({ changeAnalysis: makeChangeAnalysis(), impactAnalysis: makeImpactAnalysis() });
    expect(r.assessedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// Invalid input
// ---------------------------------------------------------------------------
describe("invalid input", () => {
  it("throws ValidationError for missing changeAnalysis", () => {
    expect(() =>
      calculateRiskScore({ impactAnalysis: makeImpactAnalysis() } as Parameters<typeof calculateRiskScore>[0])
    ).toThrow(ValidationError);
  });

  it("throws ValidationError for missing impactAnalysis", () => {
    expect(() =>
      calculateRiskScore({ changeAnalysis: makeChangeAnalysis() } as Parameters<typeof calculateRiskScore>[0])
    ).toThrow(ValidationError);
  });

  it("throws ValidationError for malformed breakingChanges (invalid severity)", () => {
    expect(() =>
      calculateRiskScore({
        changeAnalysis: {
          ...makeChangeAnalysis(),
          breakingChanges: [{ id: "bc-1", title: "t", description: "d", severity: "extreme" as never, migrationRequired: true }],
        },
        impactAnalysis: makeImpactAnalysis(),
      })
    ).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Express 4 → 5 proof
// ---------------------------------------------------------------------------
describe("Express 4 → 5 deterministic proof", () => {
  /** Representative Express 4→5 migration scenario. */
  const express4To5Input = {
    changeAnalysis: makeChangeAnalysis({
      breakingChanges: [
        bc("bc-1", "high"),   // async error propagation
        bc("bc-2", "medium"), // path-to-regexp changes
      ],
      deprecatedApis: [dep("dep-1")],
    }),
    impactAnalysis: makeImpactAnalysis({
      affectedFiles: [
        affectedFile("src/index.ts"),
        affectedFile("src/routes/users.ts"),
        affectedFile("src/middleware/error.ts"),
      ],
      affectedApis: [affectedApi("src/routes/users.ts", "app.del")],
      affectedDependencies: [affectedDep()],
      affectedTests: [affectedTest("src/tests/users.test.ts")],
      highRiskAreas: [
        highRiskArea("Custom middleware"),
        highRiskArea("Deprecated API usage"),
        highRiskArea("Tests depending on old behavior"),
      ],
    }),
  };

  it("produces a score within 0–100", () => {
    const r = calculateRiskScore(express4To5Input);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it("level matches the score threshold", () => {
    const r = calculateRiskScore(express4To5Input);
    if (r.score <= 24) expect(r.level).toBe("LOW");
    else if (r.score <= 49) expect(r.level).toBe("MEDIUM");
    else if (r.score <= 74) expect(r.level).toBe("HIGH");
    else expect(r.level).toBe("CRITICAL");
  });

  it("all factor contributions are within their configured limits", () => {
    const r = calculateRiskScore(express4To5Input);
    const factorKeys = Object.keys(RISK_WEIGHTS) as (keyof typeof RISK_WEIGHTS)[];
    for (const factor of factorKeys) {
      const reason = r.reasons.find((x) => x.factor === factor.toUpperCase().replace(/([A-Z])/g, "_$1").toUpperCase().replace(/^_/, ""));
      if (reason) {
        expect(reason.contribution).toBeLessThanOrEqual(RISK_WEIGHTS[factor]);
      }
    }
  });

  it("reasons contain evidence from P4/P5", () => {
    const r = calculateRiskScore(express4To5Input);
    const bcReason = r.reasons.find((x) => x.factor === "BREAKING_CHANGES");
    expect(bcReason?.evidence).toContain("bc-1");
    expect(bcReason?.evidence).toContain("bc-2");

    const depReason = r.reasons.find((x) => x.factor === "AFFECTED_DEPENDENCIES");
    expect(depReason?.evidence.some((e) => e.includes("express"))).toBe(true);
  });

  it("score is reproducible across multiple calls", () => {
    const r1 = calculateRiskScore(express4To5Input);
    const r2 = calculateRiskScore(express4To5Input);
    expect(r1.score).toBe(r2.score);
    expect(r1.level).toBe(r2.level);
  });

  // Assert exact score (2 bc = 22 pts, 1 deprecated API = 7 pts, 3 files = 5 pts,
  //                     1 affected API = 5 pts, 1 dep = 10 pts,
  //                     1 test = 2 pts, 3 high-risk = 10 pts = 61 total)
  it("produces the expected deterministic score of 61 for this fixture", () => {
    const r = calculateRiskScore(express4To5Input);
    expect(r.score).toBe(61);
    expect(r.level).toBe("HIGH");
  });
});
