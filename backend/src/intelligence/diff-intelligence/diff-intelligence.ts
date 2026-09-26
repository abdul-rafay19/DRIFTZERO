/**
 * P17 Diff Intelligence — main orchestrator.
 *
 * Pipeline:
 *   1. Validate input (Zod)
 *   2. Verify workspace READY
 *   3. Retrieve git diff via P3 gitDiff()
 *   4. Parse diff into structured file records
 *   5. Classify each file
 *   6. Correlate with P8/P9/P10/P12/P14/P15 evidence
 *   7. Build DiffChange records
 *   8. Build DiffCorrelation records
 *   9. Build statistics and summary
 *  10. Assign stable DIFF-NNN IDs
 *  11. Return DiffIntelligenceResult
 *
 * Core invariants:
 *  - 0 IBM Bob calls
 *  - 0 direct child_process usage (all git via P3)
 *  - Read-only: no writes, no commits, no recovery
 *  - Deterministic: same workspace state → same result
 *  - Empty diff ≠ diff retrieval failure
 *  - Sensitive content is redacted in change lines
 *  - No P18 (confidence), P19 (explanation), P20+ (git automation) functionality
 */

import { ValidationError } from "@driftzero/shared";
import type {
  DiffIntelligenceInput,
  DiffIntelligenceResult,
  DiffFileAnalysis,
  DiffChange,
  DiffCorrelation,
  DiffStatistics,
  DiffSummary,
  DiffEvidence,
  DiffIntelligenceStatus,
  DiffChangeOrigin,
  DiffChangeCategory,
} from "@driftzero/shared";
import { logger } from "../../utils/logger.js";
import { gitDiff } from "../../workspace/clone.js";
import { diffIntelligenceInputSchema } from "./diff-intelligence-types.js";
import type {
  ParsedDiffIntelligenceInput,
  ParsedMigrationPlan,
} from "./diff-intelligence-types.js";
import {
  parseDiff,
  toDiffFileAnalysis,
  type ParsedDiffFile,
} from "./diff-parser.js";
import {
  classifyFile,
  deriveChangeCategory,
  isPathSafe,
} from "./change-classifier.js";
import {
  correlateFile,
  buildPlanStepCategoryMap,
  type CorrelationContext,
} from "./change-correlation.js";
import { DiffWorkspaceError, DiffRetrievalError } from "./diff-intelligence-errors.js";

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the P17 Diff Intelligence analysis.
 *
 * @throws {ValidationError}     on invalid Zod input
 * @throws {DiffWorkspaceError}  workspace not READY
 * @throws {DiffRetrievalError}  git diff could not be obtained
 */
export async function runDiffIntelligence(
  input: DiffIntelligenceInput
): Promise<DiffIntelligenceResult> {
  // 1. Validate input
  const parsed = diffIntelligenceInputSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    throw new ValidationError(message);
  }

  const {
    workspace,
    migrationPlan,
    migrationResult,
    testGenerationResult,
    recoveryResult,
    unexpectedChanges,
    safetyGate,
    security,
  } = parsed.data;

  // 2. Workspace must be READY
  if (workspace.status !== "READY") {
    throw new DiffWorkspaceError(
      `Workspace ${workspace.id} is not in READY state (current: ${workspace.status})`
    );
  }

  logger.info("Diff intelligence analysis started", { workspaceId: workspace.id });

  const analyzedAt = new Date().toISOString();

  // 3. Retrieve git diff via P3
  let rawDiff: string;
  try {
    rawDiff = await gitDiff(workspace.path);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Unknown git error";
    logger.error("Diff retrieval failed", { workspaceId: workspace.id, reason });
    // Diff retrieval failure is distinct from an empty diff — return FAILED
    throw new DiffRetrievalError(
      `git diff failed for workspace ${workspace.id}: ${reason}`
    );
  }

  // 4. Parse diff
  const parsedFiles = parseDiff(rawDiff);

  // Filter to safe paths only
  const safeFiles = parsedFiles.filter((pf) => isPathSafe(pf.filePath));
  const skippedUnsafe = parsedFiles.length - safeFiles.length;
  if (skippedUnsafe > 0) {
    logger.warn("Skipped unsafe paths in diff", { skippedUnsafe });
  }

  // 5. Build correlation context
  const ctx: CorrelationContext = {
    plan: migrationPlan,
    migrationResult,
    testGenerationResult,
    recoveryResult,
    unexpectedChanges,
    security,
  };

  const planCategoryMap = buildPlanStepCategoryMap(migrationPlan);

  // Build P14 unexpected-file set for O(1) lookup
  const unexpectedFileSet = new Set(
    unexpectedChanges?.unexpectedChanges.map((u) => u.filePath) ?? []
  );

  // Build P9 migration file set
  const migrationFileSet = new Set(
    migrationResult?.changes.map((c) => c.filePath) ?? []
  );

  // Build P10 test file set
  const testFileSet = new Set(
    testGenerationResult?.changes.map((c) => c.filePath) ?? []
  );

  // Build P12 recovery file set
  const recoveryFileSet = new Set<string>();
  for (const attempt of recoveryResult?.attempts ?? []) {
    for (const applied of attempt.appliedChanges) {
      recoveryFileSet.add(applied.filePath);
    }
  }

  // 6. Process each file
  const fileAnalyses: DiffFileAnalysis[] = [];
  const correlations: DiffCorrelation[] = [];
  const rawChanges: Array<{
    filePath: string;
    type: "ADDITION" | "DELETION" | "MODIFICATION";
    category: DiffChangeCategory;
    line?: number;
    content?: string;
    origin: DiffChangeOrigin;
    relatedPlanSteps: string[];
    evidence: string[];
  }> = [];

  const evidenceList: DiffEvidence[] = [];
  let anyTruncated = false;

  for (const pf of safeFiles) {
    const correlation = correlateFile(pf.filePath, ctx);
    correlations.push(correlation);

    const fileCategory = classifyFile(pf.filePath);

    const planStepCategories = planCategoryMap.get(pf.filePath) ?? [];

    const changeCategory = deriveChangeCategory(
      pf.filePath,
      fileCategory,
      planStepCategories
    );

    const isMigrationRelated =
      migrationFileSet.has(pf.filePath) ||
      testFileSet.has(pf.filePath) ||
      recoveryFileSet.has(pf.filePath) ||
      correlation.planStepIds.length > 0;

    const isUnexpected = unexpectedFileSet.has(pf.filePath);

    // Build related evidence strings for this file
    const relatedEvidence: string[] = [];
    if (correlation.planStepIds.length > 0) {
      relatedEvidence.push(`P8 steps: ${correlation.planStepIds.join(", ")}`);
    }
    if (correlation.migrationEvidenceIds.length > 0) {
      relatedEvidence.push(`P9 changes: ${correlation.migrationEvidenceIds.join(", ")}`);
    }
    if (correlation.testEvidenceIds.length > 0) {
      relatedEvidence.push(`P10 test changes: ${correlation.testEvidenceIds.join(", ")}`);
    }
    if (correlation.recoveryEvidenceIds.length > 0) {
      relatedEvidence.push(`P12 recovery: ${correlation.recoveryEvidenceIds.join(", ")}`);
    }
    if (correlation.securityFindingIds.length > 0) {
      relatedEvidence.push(`P15 findings: ${correlation.securityFindingIds.join(", ")}`);
    }
    if (isUnexpected) {
      relatedEvidence.push(`P14: unexpected change`);
    }

    fileAnalyses.push(
      toDiffFileAnalysis(
        pf,
        fileCategory,
        isMigrationRelated,
        isUnexpected,
        correlation.planStepIds,
        relatedEvidence
      )
    );

    if (pf.truncated) anyTruncated = true;

    // 7. Build DiffChange records from hunk lines
    if (!pf.binary) {
      for (const hunk of pf.hunks) {
        for (let i = 0; i < hunk.lines.length; i++) {
          const hunkLine = hunk.lines[i]!;
          const isAddition = hunkLine.startsWith("+");
          const isDeletion = hunkLine.startsWith("-");

          if (!isAddition && !isDeletion) continue;

          const lineNum = isAddition
            ? hunk.newStart + i
            : hunk.oldStart + i;

          rawChanges.push({
            filePath: pf.filePath,
            type: isAddition ? "ADDITION" : "DELETION",
            category: changeCategory,
            line: lineNum,
            content: hunkLine.slice(1).trim() || undefined, // strip +/- prefix
            origin: correlation.origin,
            relatedPlanSteps: correlation.planStepIds,
            evidence: relatedEvidence.slice(0, 3),
          });
        }
      }
    }

    // Collect DiffEvidence entries
    if (correlation.planStepIds.length > 0) {
      evidenceList.push({
        source: "P8",
        id: correlation.planStepIds.join(","),
        description: `Plan steps covering ${pf.filePath}`,
      });
    }
    if (correlation.migrationEvidenceIds.length > 0) {
      evidenceList.push({
        source: "P9",
        id: correlation.migrationEvidenceIds[0]!,
        description: `P9 migration change: ${pf.filePath}`,
      });
    }
    if (correlation.testEvidenceIds.length > 0) {
      evidenceList.push({
        source: "P10",
        id: correlation.testEvidenceIds[0]!,
        description: `P10 test change: ${pf.filePath}`,
      });
    }
    if (correlation.recoveryEvidenceIds.length > 0) {
      evidenceList.push({
        source: "P12",
        id: correlation.recoveryEvidenceIds[0]!,
        description: `P12 recovery change: ${pf.filePath}`,
      });
    }
    if (isUnexpected) {
      evidenceList.push({
        source: "P14",
        id: `P14:${pf.filePath}`,
        description: `P14 unexpected change: ${pf.filePath}`,
      });
    }
    if (correlation.securityFindingIds.length > 0) {
      evidenceList.push({
        source: "P15",
        id: correlation.securityFindingIds.join(","),
        description: `P15 security findings: ${pf.filePath}`,
      });
    }
    evidenceList.push({
      source: "GIT",
      id: `git:${pf.filePath}`,
      description: `Git diff: ${pf.changeType} ${pf.filePath} (+${pf.additions}/-${pf.deletions})`,
    });
  }

  // 8. Also add MODIFICATION entries for files with both additions and deletions
  const modificationFiles = fileAnalyses.filter(
    (f) => f.additions > 0 && f.deletions > 0 && f.changeType === "MODIFIED"
  );
  for (const fa of modificationFiles) {
    // We already have ADDITION and DELETION lines in rawChanges.
    // If there are no hunk lines (binary or limits), add a summary modification entry
    const hasLines = rawChanges.some((c) => c.filePath === fa.filePath);
    if (!hasLines) {
      rawChanges.push({
        filePath: fa.filePath,
        type: "MODIFICATION",
        category: deriveChangeCategory(
          fa.filePath,
          fa.category,
          planCategoryMap.get(fa.filePath) ?? []
        ),
        origin: correlations.find((c) => c.filePath === fa.filePath)?.origin ?? "UNKNOWN",
        relatedPlanSteps: fa.relatedPlanSteps,
        evidence: fa.relatedEvidence.slice(0, 3),
      });
    }
  }

  // 9. Sort rawChanges deterministically: filePath, line, type
  rawChanges.sort((a, b) => {
    const pathDiff = a.filePath.localeCompare(b.filePath);
    if (pathDiff !== 0) return pathDiff;
    const lineDiff = (a.line ?? 0) - (b.line ?? 0);
    if (lineDiff !== 0) return lineDiff;
    return a.type.localeCompare(b.type);
  });

  // 10. Assign stable DIFF-NNN IDs
  const changes: DiffChange[] = rawChanges.map((rc, idx) => ({
    id: `DIFF-${String(idx + 1).padStart(3, "0")}`,
    filePath: rc.filePath,
    type: rc.type,
    category: rc.category,
    ...(rc.line !== undefined ? { line: rc.line } : {}),
    ...(rc.content ? { content: rc.content } : {}),
    origin: rc.origin,
    relatedPlanSteps: rc.relatedPlanSteps,
    evidence: rc.evidence,
  }));

  // 11. Sort files deterministically
  fileAnalyses.sort((a, b) => a.filePath.localeCompare(b.filePath));
  correlations.sort((a, b) => a.filePath.localeCompare(b.filePath));

  // 12. Build statistics
  const statistics = buildStatistics(fileAnalyses, correlations);

  // 13. Build summary
  const summary = buildSummary(
    statistics,
    anyTruncated,
    safetyGate?.decision
  );

  // 14. Add P16 evidence if supplied
  if (safetyGate) {
    evidenceList.push({
      source: "P16",
      id: `P16:${safetyGate.workspaceId}`,
      description: `P16 safety decision: ${safetyGate.decision}`,
    });
  }

  // Deduplicate evidence by source+id
  const seenEvidence = new Set<string>();
  const dedupedEvidence = evidenceList.filter((e) => {
    const key = `${e.source}:${e.id}`;
    if (seenEvidence.has(key)) return false;
    seenEvidence.add(key);
    return true;
  });

  // 15. Determine status
  const status: DiffIntelligenceStatus = determineStatus(anyTruncated, safeFiles.length);

  logger.info("Diff intelligence analysis completed", {
    workspaceId: workspace.id,
    status,
    filesChanged: fileAnalyses.length,
    totalChanges: changes.length,
    truncated: anyTruncated,
  });

  return {
    workspaceId: workspace.id,
    status,
    summary,
    files: fileAnalyses,
    changes,
    correlations,
    statistics,
    evidence: dedupedEvidence,
    analyzedAt,
  };
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function buildStatistics(
  files: DiffFileAnalysis[],
  correlations: DiffCorrelation[]
): DiffStatistics {
  const uncorrelatedFiles = correlations.filter(
    (c) => c.correlationType === "UNCORRELATED"
  ).length;

  return {
    filesChanged: files.length,
    filesAdded: files.filter((f) => f.changeType === "ADDED").length,
    filesModified: files.filter((f) => f.changeType === "MODIFIED").length,
    filesDeleted: files.filter((f) => f.changeType === "DELETED").length,
    filesRenamed: files.filter((f) => f.changeType === "RENAMED").length,
    totalAdditions: files.reduce((s, f) => s + f.additions, 0),
    totalDeletions: files.reduce((s, f) => s + f.deletions, 0),
    sourceFilesChanged: files.filter((f) => f.category === "SOURCE").length,
    testFilesChanged: files.filter((f) => f.category === "TEST").length,
    configFilesChanged: files.filter((f) => f.category === "CONFIG").length,
    dependencyFilesChanged: files.filter((f) => f.category === "DEPENDENCY").length,
    unexpectedFiles: files.filter((f) => f.unexpected).length,
    migrationRelatedFiles: files.filter((f) => f.migrationRelated).length,
    uncorrelatedFiles,
  };
}

function buildSummary(
  stats: DiffStatistics,
  truncated: boolean,
  safetyDecision?: string
): DiffSummary {
  const summary: DiffSummary = {
    filesChanged: stats.filesChanged,
    totalAdditions: stats.totalAdditions,
    totalDeletions: stats.totalDeletions,
    migrationRelatedFiles: stats.migrationRelatedFiles,
    testFilesChanged: stats.testFilesChanged,
    dependencyFilesChanged: stats.dependencyFilesChanged,
    uncorrelatedFiles: stats.uncorrelatedFiles,
    unexpectedFiles: stats.unexpectedFiles,
    truncated,
  };

  if (safetyDecision === "SAFE_TO_PROCEED" || safetyDecision === "STOP_SAFELY") {
    summary.safetyDecision = safetyDecision as "SAFE_TO_PROCEED" | "STOP_SAFELY";
  }

  return summary;
}

function determineStatus(
  truncated: boolean,
  fileCount: number
): DiffIntelligenceStatus {
  if (truncated) return "PARTIAL";
  // Empty diff is valid ANALYZED
  return "ANALYZED";
}
