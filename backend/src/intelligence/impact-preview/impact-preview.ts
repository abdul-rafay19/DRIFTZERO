/**
 * Impact Preview Engine (P7) — "What Will Break?"
 *
 * Consumes P4 ChangeAnalysisResult + P5 ImpactAnalysisResult + P6 RiskScoreResult.
 * Produces a structured, evidence-backed preview of what requires migration work.
 *
 * Architecture:
 *   P4 Change Analysis
 *         +
 *   P5 Impact Analysis
 *         +
 *   P6 Risk Score
 *         ↓
 *   P7 Impact Preview
 *
 * DETERMINISTIC. NO IBM Bob calls. NO filesystem access. NO command execution.
 */

import { DriftZeroError, ValidationError } from "@driftzero/shared";
import type {
  ImpactPreviewInput,
  ImpactPreviewResult,
  PreviewItem,
} from "@driftzero/shared";
import { logger } from "../../utils/logger.js";
import {
  impactPreviewInputSchema,
  impactPreviewResultSchema,
} from "./impact-preview-types.js";

// ---------------------------------------------------------------------------
// Module error
// ---------------------------------------------------------------------------

export class ImpactPreviewError extends DriftZeroError {
  constructor(message: string) {
    super(message, 500, "IMPACT_PREVIEW_ERROR");
    this.name = "ImpactPreviewError";
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic "What Will Break?" preview from validated P4/P5/P6 evidence.
 *
 * The risk score/level from P6 is passed through unchanged — never recalculated.
 * All preview items trace back to concrete P4/P5 findings.
 *
 * @throws {ValidationError}      invalid P4/P5/P6 input
 * @throws {ImpactPreviewError}   output fails schema validation (internal bug)
 */
export function generateImpactPreview(input: ImpactPreviewInput): ImpactPreviewResult {
  // 1. Validate the full nested input — all three upstream results are untrusted
  const parsed = impactPreviewInputSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
    throw new ValidationError(message);
  }

  const { changeAnalysis, impactAnalysis, riskScore } = parsed.data;

  logger.info("Impact preview generation started", {
    packageName: changeAnalysis.packageName,
    sourceVersion: changeAnalysis.sourceVersion,
    targetVersion: changeAnalysis.targetVersion,
    riskLevel: riskScore.level,
    riskScore: riskScore.score,
  });

  // 2. Build ordered preview categories from validated evidence
  const breakingChanges = buildBreakingChanges(changeAnalysis);
  const deprecatedApis = buildDeprecatedApis(changeAnalysis);
  const highRiskAreas = buildHighRiskAreas(impactAnalysis);
  const affectedApis = buildAffectedApis(impactAnalysis);
  const affectedFiles = buildAffectedFiles(impactAnalysis);
  const affectedDependencies = buildAffectedDependencies(impactAnalysis);
  const affectedTests = buildAffectedTests(impactAnalysis);
  const affectedConfigs = buildAffectedConfigs(impactAnalysis);
  const behaviorChanges = buildBehaviorChanges(changeAnalysis);

  // 3. Build deterministic summary
  const summary = buildSummary(changeAnalysis, impactAnalysis, riskScore);

  // 4. Assemble result — P6 risk is passed through, never recalculated
  const rawResult: ImpactPreviewResult = {
    packageName: changeAnalysis.packageName,
    sourceVersion: changeAnalysis.sourceVersion,
    targetVersion: changeAnalysis.targetVersion,
    risk: {
      score: riskScore.score,
      level: riskScore.level,
    },
    summary,
    breakingChanges,
    deprecatedApis,
    highRiskAreas,
    affectedApis,
    affectedFiles,
    affectedDependencies,
    affectedTests,
    affectedConfigs,
    behaviorChanges,
    generatedAt: new Date().toISOString(),
  };

  // 5. Schema-validate the output (defence-in-depth)
  const validated = impactPreviewResultSchema.safeParse(rawResult);
  if (!validated.success) {
    const issues = validated.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
    logger.error("Impact preview output failed schema validation", { issues });
    throw new ImpactPreviewError(`Impact preview output failed validation: ${issues}`);
  }

  logger.info("Impact preview generation completed", {
    packageName: changeAnalysis.packageName,
    breakingChanges: breakingChanges.length,
    affectedFiles: affectedFiles.length,
    affectedApis: affectedApis.length,
    affectedDependencies: affectedDependencies.length,
    affectedTests: affectedTests.length,
    riskLevel: riskScore.level,
  });

  return validated.data;
}

// ---------------------------------------------------------------------------
// Summary builder (deterministic, code-generated — no AI)
// ---------------------------------------------------------------------------

type ParsedChangeAnalysis = ReturnType<typeof impactPreviewInputSchema.parse>["changeAnalysis"];
type ParsedImpactAnalysis = ReturnType<typeof impactPreviewInputSchema.parse>["impactAnalysis"];
type ParsedRiskScore = ReturnType<typeof impactPreviewInputSchema.parse>["riskScore"];

function buildSummary(
  ca: ParsedChangeAnalysis,
  ia: ParsedImpactAnalysis,
  rs: ParsedRiskScore
): string {
  const migration = `${ca.packageName} ${ca.sourceVersion} → ${ca.targetVersion}`;

  const parts: string[] = [];

  // Affected area counts
  const counts: string[] = [];
  if (ia.affectedFiles.length > 0)
    counts.push(`${ia.affectedFiles.length} affected file${ia.affectedFiles.length !== 1 ? "s" : ""}`);
  if (ia.affectedApis.length > 0)
    counts.push(`${ia.affectedApis.length} affected API${ia.affectedApis.length !== 1 ? "s" : ""}`);
  if (ia.affectedDependencies.length > 0)
    counts.push(`${ia.affectedDependencies.length} dependenc${ia.affectedDependencies.length !== 1 ? "ies" : "y"}`);
  if (ia.affectedTests.length > 0)
    counts.push(`${ia.affectedTests.length} affected test${ia.affectedTests.length !== 1 ? "s" : ""}`);
  if (ia.affectedConfigs.length > 0)
    counts.push(`${ia.affectedConfigs.length} config file${ia.affectedConfigs.length !== 1 ? "s" : ""}`);

  const countsClause = counts.length > 0 ? ` with ${joinList(counts)}` : "";

  parts.push(
    `${migration} has ${rs.level} migration risk (score: ${rs.score}/100)${countsClause}.`
  );

  // Most important findings
  if (ca.breakingChanges.length > 0) {
    parts.push(
      `${ca.breakingChanges.length} breaking change${ca.breakingChanges.length !== 1 ? "s" : ""} require${ca.breakingChanges.length === 1 ? "s" : ""} migration work.`
    );
  }
  if (ca.deprecatedApis.length > 0) {
    parts.push(
      `${ca.deprecatedApis.length} deprecated API${ca.deprecatedApis.length !== 1 ? "s" : ""} detected.`
    );
  }
  if (ia.highRiskAreas.length > 0) {
    parts.push(
      `${ia.highRiskAreas.length} high-risk area${ia.highRiskAreas.length !== 1 ? "s" : ""} identified.`
    );
  }

  return parts.join(" ");
}

/** Format an array of strings as a natural-language list: "a, b, and c". */
function joinList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  const last = items[items.length - 1];
  return `${items.slice(0, -1).join(", ")}, and ${last}`;
}

// ---------------------------------------------------------------------------
// Category builders — one function per category
// ---------------------------------------------------------------------------

function buildBreakingChanges(ca: ParsedChangeAnalysis): PreviewItem[] {
  return ca.breakingChanges.map((bc) => ({
    title: bc.title,
    description: `Migration required: ${bc.description}`,
    severity: bc.severity,
    source: "CHANGE_ANALYSIS" as const,
    evidence: [bc.id, ...(bc.affectedArea ? [bc.affectedArea] : [])],
    file: bc.affectedArea,
  }));
}

function buildDeprecatedApis(ca: ParsedChangeAnalysis): PreviewItem[] {
  return ca.deprecatedApis.map((api) => ({
    title: `Deprecated: ${api.apiName}`,
    description: api.replacement
      ? `${api.description} Use ${api.replacement} instead.`
      : api.description,
    severity: "medium" as const,
    source: "CHANGE_ANALYSIS" as const,
    evidence: [
      api.id,
      ...(api.replacement ? [`replacement: ${api.replacement}`] : []),
      ...(api.removedInVersion ? [`removed in ${api.removedInVersion}`] : []),
    ],
  }));
}

function buildHighRiskAreas(ia: ParsedImpactAnalysis): PreviewItem[] {
  return ia.highRiskAreas.map((area) => ({
    title: area.title,
    description: `High-risk area: ${area.description}`,
    severity: "high" as const,
    source: "IMPACT_ANALYSIS" as const,
    evidence: area.files.length > 0 ? area.files : [area.title],
  }));
}

function buildAffectedApis(ia: ParsedImpactAnalysis): PreviewItem[] {
  return ia.affectedApis.map((api) => ({
    title: `Potentially affected API: ${api.api}`,
    description: `API usage may require migration: ${api.reason}`,
    source: "IMPACT_ANALYSIS" as const,
    evidence: [
      api.file,
      ...(api.symbol ? [api.symbol] : []),
      ...(api.migrationRequirementId ? [api.migrationRequirementId] : []),
    ],
    file: api.file,
  }));
}

function buildAffectedFiles(ia: ParsedImpactAnalysis): PreviewItem[] {
  return ia.affectedFiles.map((f) => ({
    title: f.path,
    description: `${f.relevance === "direct" ? "Directly" : "Indirectly"} affected: ${f.reason}`,
    source: "IMPACT_ANALYSIS" as const,
    evidence: f.evidence.length > 0 ? f.evidence : [f.path],
    file: f.path,
  }));
}

function buildAffectedDependencies(ia: ParsedImpactAnalysis): PreviewItem[] {
  return ia.affectedDependencies.map((dep) => ({
    title: `${dep.name}@${dep.declaredVersion}`,
    description: `Dependency version requires updating: ${dep.reason}`,
    source: "IMPACT_ANALYSIS" as const,
    evidence: [`${dep.name}@${dep.declaredVersion}`, dep.dependencyType],
  }));
}

function buildAffectedTests(ia: ParsedImpactAnalysis): PreviewItem[] {
  return ia.affectedTests.map((t) => ({
    title: t.path,
    description: `Test may require updating for new behavior: ${t.reason}`,
    source: "IMPACT_ANALYSIS" as const,
    evidence: t.evidence.length > 0 ? t.evidence : [t.path],
    file: t.path,
  }));
}

function buildAffectedConfigs(ia: ParsedImpactAnalysis): PreviewItem[] {
  return ia.affectedConfigs.map((cfg) => ({
    title: cfg.path,
    description: `Configuration may require changes: ${cfg.reason}`,
    source: "IMPACT_ANALYSIS" as const,
    evidence: [cfg.path],
    file: cfg.path,
  }));
}

function buildBehaviorChanges(ca: ParsedChangeAnalysis): PreviewItem[] {
  return ca.behaviorChanges.map((bc) => ({
    title: bc.title,
    description: `Behavior change may affect this area: ${bc.description}`,
    severity: bc.severity,
    source: "CHANGE_ANALYSIS" as const,
    evidence: [bc.id, ...(bc.affectedArea ? [bc.affectedArea] : [])],
    file: bc.affectedArea,
  }));
}
