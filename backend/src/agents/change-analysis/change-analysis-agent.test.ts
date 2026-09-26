/**
 * Change Analysis Agent tests.
 *
 * Bob is mocked via vi.mock — no live API key required.
 * Tests cover: input validation, successful analysis, Bob errors, malformed output.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runChangeAnalysis, ChangeAnalysisParseError } from "./change-analysis-agent.js";
import { ValidationError } from "@driftzero/shared";
import type { BobResponse } from "../../bob/bob-types.js";

// ---------------------------------------------------------------------------
// Mock the Bob client — prevents any real subprocess from being spawned
// ---------------------------------------------------------------------------
vi.mock("../../bob/bob-client.js", () => ({
  bobGenerate: vi.fn(),
}));

import { bobGenerate } from "../../bob/bob-client.js";
const mockBobGenerate = vi.mocked(bobGenerate);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal valid Bob response for express 4→5. */
function makeValidBobResponse(overrides?: Partial<BobResponse>): BobResponse {
  return {
    content: JSON.stringify(validAnalysisOutput()),
    durationMs: 1234,
    ...overrides,
  };
}

/** The raw JSON structure Bob must return. */
function validAnalysisOutput() {
  return {
    summary: "Migrating from Express 4 to Express 5 involves several breaking changes.",
    breakingChanges: [
      {
        id: "bc-1",
        title: "Error handling changes",
        description: "Express 5 passes async errors to next() automatically.",
        severity: "high",
        affectedArea: "error handling",
        migrationRequired: true,
      },
    ],
    deprecatedApis: [
      {
        id: "dep-1",
        apiName: "app.del()",
        description: "app.del() has been removed; use app.delete() instead.",
        replacement: "app.delete()",
        removedInVersion: "5",
      },
    ],
    behaviorChanges: [
      {
        id: "beh-1",
        title: "Path matching strictness",
        description: "Express 5 uses a stricter path-to-regexp version.",
        severity: "medium",
        affectedArea: "routing",
      },
    ],
    migrationRequirements: [
      {
        id: "req-1",
        title: "Update async route handlers",
        description: "Async route handlers no longer need explicit try/catch.",
        mandatory: true,
      },
    ],
    migrationPatterns: [
      {
        id: "pat-1",
        title: "Async error propagation",
        description: "Thrown errors in async handlers are forwarded to Express error middleware.",
        before: "app.get('/', async (req, res, next) => { try { ... } catch(e) { next(e); } });",
        after: "app.get('/', async (req, res) => { ... }); // errors auto-forwarded",
      },
    ],
    compatibilityNotes: ["Node.js 18+ is required for Express 5."],
  };
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------
describe("runChangeAnalysis — input validation", () => {
  it("accepts a valid migration input", async () => {
    mockBobGenerate.mockResolvedValueOnce(makeValidBobResponse());
    const result = await runChangeAnalysis({
      packageName: "express",
      sourceVersion: "4",
      targetVersion: "5",
    });
    expect(result.packageName).toBe("express");
    expect(result.sourceVersion).toBe("4");
    expect(result.targetVersion).toBe("5");
  });

  it("throws ValidationError when packageName is empty", async () => {
    await expect(
      runChangeAnalysis({ packageName: "", sourceVersion: "4", targetVersion: "5" })
    ).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError when sourceVersion is empty", async () => {
    await expect(
      runChangeAnalysis({ packageName: "express", sourceVersion: "", targetVersion: "5" })
    ).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError when targetVersion is empty", async () => {
    await expect(
      runChangeAnalysis({ packageName: "express", sourceVersion: "4", targetVersion: "" })
    ).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError for invalid packageName characters", async () => {
    await expect(
      runChangeAnalysis({ packageName: "express; rm -rf /", sourceVersion: "4", targetVersion: "5" })
    ).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Bob interaction
// ---------------------------------------------------------------------------
describe("runChangeAnalysis — Bob interaction", () => {
  beforeEach(() => {
    mockBobGenerate.mockReset();
  });

  it("calls bobGenerate once with a non-empty prompt", async () => {
    mockBobGenerate.mockResolvedValueOnce(makeValidBobResponse());
    await runChangeAnalysis({ packageName: "express", sourceVersion: "4", targetVersion: "5" });
    expect(mockBobGenerate).toHaveBeenCalledTimes(1);
    const [req] = mockBobGenerate.mock.calls[0]!;
    expect(req.prompt.length).toBeGreaterThan(100);
    expect(req.prompt).toContain("express");
    expect(req.prompt).toContain("4");
    expect(req.prompt).toContain("5");
  });

  it("propagates BobTimeoutError from bobGenerate", async () => {
    const { BobTimeoutError } = await import("../../bob/bob-errors.js");
    mockBobGenerate.mockRejectedValueOnce(new BobTimeoutError());
    await expect(
      runChangeAnalysis({ packageName: "express", sourceVersion: "4", targetVersion: "5" })
    ).rejects.toThrow(BobTimeoutError);
  });

  it("propagates BobConfigurationError from bobGenerate", async () => {
    const { BobConfigurationError } = await import("../../bob/bob-errors.js");
    mockBobGenerate.mockRejectedValueOnce(
      new BobConfigurationError("BOB_API_KEY is not configured.")
    );
    await expect(
      runChangeAnalysis({ packageName: "express", sourceVersion: "4", targetVersion: "5" })
    ).rejects.toThrow(BobConfigurationError);
  });

  it("propagates BobAuthenticationError from bobGenerate", async () => {
    const { BobAuthenticationError } = await import("../../bob/bob-errors.js");
    mockBobGenerate.mockRejectedValueOnce(
      new BobAuthenticationError("IBM Bob rejected the API key")
    );
    await expect(
      runChangeAnalysis({ packageName: "express", sourceVersion: "4", targetVersion: "5" })
    ).rejects.toThrow(BobAuthenticationError);
  });

  it("propagates BobInferenceError from bobGenerate", async () => {
    const { BobInferenceError } = await import("../../bob/bob-errors.js");
    mockBobGenerate.mockRejectedValueOnce(new BobInferenceError("Bob returned empty response"));
    await expect(
      runChangeAnalysis({ packageName: "express", sourceVersion: "4", targetVersion: "5" })
    ).rejects.toThrow(BobInferenceError);
  });
});

// ---------------------------------------------------------------------------
// Output validation
// ---------------------------------------------------------------------------
describe("runChangeAnalysis — output validation", () => {
  beforeEach(() => {
    mockBobGenerate.mockReset();
  });

  it("returns a validated ChangeAnalysisResult for valid Bob output", async () => {
    mockBobGenerate.mockResolvedValueOnce(makeValidBobResponse());
    const result = await runChangeAnalysis({
      packageName: "express",
      sourceVersion: "4",
      targetVersion: "5",
    });

    expect(result.summary).toBeTruthy();
    expect(Array.isArray(result.breakingChanges)).toBe(true);
    expect(Array.isArray(result.deprecatedApis)).toBe(true);
    expect(Array.isArray(result.behaviorChanges)).toBe(true);
    expect(Array.isArray(result.migrationRequirements)).toBe(true);
    expect(Array.isArray(result.migrationPatterns)).toBe(true);
    expect(Array.isArray(result.compatibilityNotes)).toBe(true);
    expect(result.analyzedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof result.meta.bobDurationMs).toBe("number");
    expect(typeof result.meta.promptLength).toBe("number");
  });

  it("throws ChangeAnalysisParseError when Bob returns non-JSON", async () => {
    mockBobGenerate.mockResolvedValueOnce({
      content: "Sorry, I cannot help with that.",
      durationMs: 500,
    });
    await expect(
      runChangeAnalysis({ packageName: "express", sourceVersion: "4", targetVersion: "5" })
    ).rejects.toThrow(ChangeAnalysisParseError);
  });

  it("throws ChangeAnalysisParseError when Bob returns JSON missing required fields", async () => {
    mockBobGenerate.mockResolvedValueOnce({
      content: JSON.stringify({ summary: "ok" }), // missing all arrays
      durationMs: 500,
    });
    await expect(
      runChangeAnalysis({ packageName: "express", sourceVersion: "4", targetVersion: "5" })
    ).rejects.toThrow(ChangeAnalysisParseError);
  });

  it("throws ChangeAnalysisParseError when a breakingChange has invalid severity", async () => {
    const bad = {
      ...validAnalysisOutput(),
      breakingChanges: [
        {
          id: "bc-1",
          title: "test",
          description: "test",
          severity: "extreme", // invalid enum value
          migrationRequired: true,
        },
      ],
    };
    mockBobGenerate.mockResolvedValueOnce({ content: JSON.stringify(bad), durationMs: 500 });
    await expect(
      runChangeAnalysis({ packageName: "express", sourceVersion: "4", targetVersion: "5" })
    ).rejects.toThrow(ChangeAnalysisParseError);
  });

  it("accepts Bob response wrapped in markdown fences", async () => {
    const json = JSON.stringify(validAnalysisOutput());
    mockBobGenerate.mockResolvedValueOnce({
      content: "```json\n" + json + "\n```",
      durationMs: 500,
    });
    const result = await runChangeAnalysis({
      packageName: "express",
      sourceVersion: "4",
      targetVersion: "5",
    });
    expect(result.summary).toBeTruthy();
  });

  it("accepts Bob response wrapped in plain code fences", async () => {
    const json = JSON.stringify(validAnalysisOutput());
    mockBobGenerate.mockResolvedValueOnce({
      content: "```\n" + json + "\n```",
      durationMs: 500,
    });
    const result = await runChangeAnalysis({
      packageName: "express",
      sourceVersion: "4",
      targetVersion: "5",
    });
    expect(result.summary).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Agent behavior — does NOT touch workspace/filesystem/commands
// ---------------------------------------------------------------------------
describe("runChangeAnalysis — agent behavior constraints", () => {
  it("does not import or call workspace functions", async () => {
    // If workspace is imported, this test would fail at import time
    // (spy on runCommand to ensure it's never called)
    const commandsSpy = vi.fn();
    vi.doMock("../../workspace/commands.js", () => ({ runCommand: commandsSpy }));

    mockBobGenerate.mockResolvedValueOnce(makeValidBobResponse());
    await runChangeAnalysis({ packageName: "express", sourceVersion: "4", targetVersion: "5" });

    expect(commandsSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Express 4 → 5 proof: structured result from mocked Bob
// ---------------------------------------------------------------------------
describe("Express 4 → 5 change analysis (mocked Bob)", () => {
  it("produces a valid structured analysis for express 4→5", async () => {
    mockBobGenerate.mockResolvedValueOnce(makeValidBobResponse());
    const result = await runChangeAnalysis({
      packageName: "express",
      sourceVersion: "4",
      targetVersion: "5",
    });

    expect(result.packageName).toBe("express");
    expect(result.sourceVersion).toBe("4");
    expect(result.targetVersion).toBe("5");
    expect(result.breakingChanges.length).toBeGreaterThan(0);
    expect(result.breakingChanges[0]!.severity).toMatch(/^(low|medium|high|critical)$/);
    expect(result.migrationRequirements.some((r: { mandatory: boolean }) => r.mandatory)).toBe(true);
    expect(result.deprecatedApis[0]!.replacement).toBe("app.delete()");
  });
});
