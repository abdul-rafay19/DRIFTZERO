/**
 * Migration Planner (P8) — "How Should We Migrate?"
 *
 * Consumes P4 ChangeAnalysisResult + P5 ImpactAnalysisResult +
 *          P6 RiskScoreResult + P7 ImpactPreviewResult.
 * Produces an ordered, traceable, evidence-based MigrationPlan.
 *
 * Architecture:
 *   P4 Change Analysis
 *         +
 *   P5 Impact Analysis
 *         +
 *   P6 Risk Score
 *         +
 *   P7 Impact Preview
 *         ↓
 *   P8 Migration Planner
 *         ↓
 *   MigrationPlan (steps with DAG dependencies)
 *
 * DETERMINISTIC. NO IBM Bob calls. NO filesystem access. NO command execution.
 * P9 will perform the actual code migration from this plan.
 */

import { DriftZeroError, ValidationError } from "@driftzero/shared";
import type {
  MigrationPlan,
  MigrationStep,
  MigrationPrerequisite,
  ValidationRequirement,
  MigrationPlannerInput,
  RiskLevel,
} from "@driftzero/shared";
import { logger } from "../../utils/logger.js";
import {
  migrationPlannerInputSchema,
  migrationPlanSchema,
  hasCycle,
} from "./migration-planner-types.js";

// ---------------------------------------------------------------------------
// Module error
// ---------------------------------------------------------------------------

export class MigrationPlannerError extends DriftZeroError {
  constructor(message: string) {
    super(message, 500, "MIGRATION_PLANNER_ERROR");
    this.name = "MigrationPlannerError";
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic, evidence-based migration plan from P4/P5/P6/P7 data.
 *
 * The plan defines ordered steps that P9 will execute.
 * No IBM Bob calls, no filesystem access, no code generation.
 *
 * @throws {ValidationError}         invalid P4/P5/P6/P7 input
 * @throws {MigrationPlannerError}   cycle detected or output schema invalid
 */
export function generateMigrationPlan(input: MigrationPlannerInput): MigrationPlan {
  // 1. Validate the full nested input — all four upstream results are untrusted
  const parsed = migrationPlannerInputSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    throw new ValidationError(message);
  }

  const { changeAnalysis, impactAnalysis, riskScore, impactPreview } = parsed.data;

  logger.info("Migration plan generation started", {
    packageName: changeAnalysis.packageName,
    sourceVersion: changeAnalysis.sourceVersion,
    targetVersion: changeAnalysis.targetVersion,
    riskLevel: riskScore.level,
  });

  // 2. Build step counter (stateful within this call, deterministic)
  let stepCounter = 0;
  const nextId = () => `STEP-${String(++stepCounter).padStart(3, "0")}`;

  // 3. Generate steps per category in spec order §7
  //    Each category group depends on the last step of the previous group.
  const steps: MigrationStep[] = [];

  // Last step ID of the most recently completed category group
  let prevGroupLastId: string | null = null;

  // Helper: append a group, linking its first step to prevGroupLastId
  function addGroup(group: MigrationStep[]): void {
    if (group.length === 0) return;
    // First step of this group depends on the last step of the previous group
    if (prevGroupLastId !== null) {
      group[0]!.dependencies = [prevGroupLastId];
    }
    steps.push(...group);
    prevGroupLastId = group[group.length - 1]!.id;
  }

  // 3a. DEPENDENCY steps — one per affected dependency from P5
  addGroup(buildDependencySteps(nextId, impactAnalysis, changeAnalysis, riskScore));

  // 3b. API steps — one per affected API from P5, linked to P4 requirements
  addGroup(buildApiSteps(nextId, impactAnalysis, changeAnalysis, riskScore));

  // 3c. MIDDLEWARE steps — affected files categorized as MIDDLEWARE
  addGroup(buildMiddlewareSteps(nextId, impactAnalysis, changeAnalysis, riskScore));

  // 3d. ROUTE / CONTROLLER steps
  addGroup(buildRouteSteps(nextId, impactAnalysis, changeAnalysis, riskScore));

  // 3e. CONFIG steps — affected config files from P5
  addGroup(buildConfigSteps(nextId, impactAnalysis, changeAnalysis, riskScore));

  // 3f. TEST steps — affected test files from P5
  addGroup(buildTestSteps(nextId, impactAnalysis, changeAnalysis, riskScore));

  // 3g. OTHER — remaining affected files not covered above
  addGroup(buildOtherSteps(nextId, impactAnalysis, changeAnalysis, riskScore, steps));

  // Assign sequential orders (1-based, matches generation order)
  for (let i = 0; i < steps.length; i++) {
    steps[i]!.order = i + 1;
  }

  // 4. Guard: detect cycles before schema validation (should never happen with the
  //    linear dependency chain we build, but protects against future logic changes)
  if (hasCycle(steps)) {
    throw new MigrationPlannerError("Internal error: generated plan contains a dependency cycle");
  }

  // 5. Build prerequisites and validation requirements
  const prerequisites = buildPrerequisites(impactAnalysis, changeAnalysis);
  const validationRequirements = buildValidationRequirements(impactAnalysis, changeAnalysis, steps);

  // 6. Affected areas summary from P7
  const affectedAreas = [
    ...new Set([
      ...impactAnalysis.highRiskAreas.map((a) => a.title),
      ...(impactAnalysis.affectedFiles.length > 0 ? ["Source files"] : []),
      ...(impactAnalysis.affectedDependencies.length > 0 ? ["Dependencies"] : []),
      ...(impactAnalysis.affectedTests.length > 0 ? ["Tests"] : []),
      ...(impactAnalysis.affectedConfigs.length > 0 ? ["Configuration"] : []),
    ]),
  ];

  // 7. Objective
  const objective = buildObjective(changeAnalysis);

  // 8. Assemble plan — P6 risk is passed through unchanged
  const rawPlan: MigrationPlan = {
    packageName: changeAnalysis.packageName,
    sourceVersion: changeAnalysis.sourceVersion,
    targetVersion: changeAnalysis.targetVersion,
    objective,
    prerequisites,
    steps,
    validationRequirements,
    affectedAreas,
    risk: {
      score: riskScore.score,
      level: riskScore.level,
    },
    generatedAt: new Date().toISOString(),
  };

  // 9. Schema-validate the output (defence-in-depth, includes DAG + uniqueness checks)
  const validated = migrationPlanSchema.safeParse(rawPlan);
  if (!validated.success) {
    const issues = validated.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    logger.error("Migration plan output failed schema validation", { issues });
    throw new MigrationPlannerError(`Migration plan output failed validation: ${issues}`);
  }

  logger.info("Migration plan generation completed", {
    packageName: changeAnalysis.packageName,
    steps: steps.length,
    prerequisites: prerequisites.length,
    validationRequirements: validationRequirements.length,
    riskLevel: riskScore.level,
  });

  return validated.data;
}

// ---------------------------------------------------------------------------
// Objective builder
// ---------------------------------------------------------------------------

type ParsedCA = ReturnType<typeof migrationPlannerInputSchema.parse>["changeAnalysis"];
type ParsedIA = ReturnType<typeof migrationPlannerInputSchema.parse>["impactAnalysis"];
type ParsedRS = ReturnType<typeof migrationPlannerInputSchema.parse>["riskScore"];

function buildObjective(ca: ParsedCA): string {
  return `Migrate ${ca.packageName} from ${ca.sourceVersion} to ${ca.targetVersion}, addressing all breaking changes and deprecated API usages identified during pre-migration analysis.`;
}

// ---------------------------------------------------------------------------
// Step builders — one function per category
// ---------------------------------------------------------------------------

function buildDependencySteps(
  nextId: () => string,
  ia: ParsedIA,
  ca: ParsedCA,
  rs: ParsedRS
): MigrationStep[] {
  if (ia.affectedDependencies.length === 0) return [];
  const stepId = nextId();
  const reqIds = ca.migrationRequirements
    .filter((r) => r.title.toLowerCase().includes("depend") || r.description.toLowerCase().includes("depend"))
    .map((r) => r.id);
  return [
    {
      id: stepId,
      order: 0, // assigned later
      title: `Update ${ia.affectedDependencies.map((d) => d.name).join(", ")} to target version`,
      description: `Update package manifest(s) to declare ${ca.packageName}@${ca.targetVersion}. This is required before any API-level migration work can begin.`,
      category: "DEPENDENCY",
      affectedFiles: [],
      relatedChangeIds: ca.breakingChanges.map((bc) => bc.id),
      relatedRequirementIds: reqIds,
      reason: `${ia.affectedDependencies.length} dependency manifest(s) declare ${ca.packageName}@${ca.sourceVersion} and must be upgraded.`,
      risk: rs.level,
      dependencies: [],
    },
  ];
}

function buildApiSteps(
  nextId: () => string,
  ia: ParsedIA,
  ca: ParsedCA,
  rs: ParsedRS
): MigrationStep[] {
  if (ia.affectedApis.length === 0) return [];
  // Group by file for coherent steps
  const byFile = new Map<string, typeof ia.affectedApis[number][]>();
  for (const api of ia.affectedApis) {
    if (!byFile.has(api.file)) byFile.set(api.file, []);
    byFile.get(api.file)!.push(api);
  }

  const steps: MigrationStep[] = [];
  for (const [file, apis] of byFile) {
    const stepId = nextId();
    const reqIds = [
      ...new Set(apis.map((a) => a.migrationRequirementId).filter((id): id is string => !!id)),
    ];
    const changeIds = ca.breakingChanges
      .filter((bc) => bc.affectedArea && apis.some((a) => a.api.includes(bc.affectedArea ?? "")))
      .map((bc) => bc.id);
    steps.push({
      id: stepId,
      order: 0,
      title: `Update deprecated API usage in ${file}`,
      description: `Replace deprecated or removed API call(s) (${apis.map((a) => a.api).join(", ")}) in ${file} with the new ${ca.targetVersion} equivalents as identified during change analysis.`,
      category: "API",
      affectedFiles: [file],
      relatedChangeIds: changeIds,
      relatedRequirementIds: reqIds,
      reason: `${apis.length} deprecated/removed API call(s) detected in this file during P5 impact analysis.`,
      risk: stepRisk(rs.level, "high"),
      dependencies: [],
    });
  }
  return steps;
}

function buildMiddlewareSteps(
  nextId: () => string,
  ia: ParsedIA,
  ca: ParsedCA,
  rs: ParsedRS
): MigrationStep[] {
  const files = ia.affectedFiles.filter((f) => f.category === "MIDDLEWARE");
  if (files.length === 0) return [];
  const stepId = nextId();
  const changeIds = ca.breakingChanges
    .filter((bc) => bc.affectedArea?.toLowerCase().includes("middleware"))
    .map((bc) => bc.id);
  return [
    {
      id: stepId,
      order: 0,
      title: `Update middleware files for ${ca.targetVersion} compatibility`,
      description: `Review and update ${files.length} middleware file(s) to be compatible with ${ca.packageName}@${ca.targetVersion}. Middleware behavior may have changed — verify error handling and request flow.`,
      category: "MIDDLEWARE",
      affectedFiles: files.map((f) => f.path),
      relatedChangeIds: changeIds,
      relatedRequirementIds: ca.migrationRequirements.map((r) => r.id),
      reason: `${files.length} middleware file(s) were identified as directly affected by P5 impact analysis.`,
      risk: stepRisk(rs.level, "high"),
      dependencies: [],
    },
  ];
}

function buildRouteSteps(
  nextId: () => string,
  ia: ParsedIA,
  ca: ParsedCA,
  rs: ParsedRS
): MigrationStep[] {
  const files = ia.affectedFiles.filter((f) => f.category === "ROUTE" || f.category === "CONTROLLER");
  if (files.length === 0) return [];
  const routes = files.filter((f) => f.category === "ROUTE");
  const controllers = files.filter((f) => f.category === "CONTROLLER");
  const steps: MigrationStep[] = [];
  if (routes.length > 0) {
    const stepId = nextId();
    const changeIds = ca.breakingChanges
      .filter((bc) => bc.affectedArea?.toLowerCase().includes("route") || bc.affectedArea?.toLowerCase().includes("path"))
      .map((bc) => bc.id);
    steps.push({
      id: stepId,
      order: 0,
      title: `Update route handlers for ${ca.targetVersion} compatibility`,
      description: `Review and update ${routes.length} route file(s) to be compatible with ${ca.packageName}@${ca.targetVersion}. Path-to-regexp changes and async error propagation may affect route behavior.`,
      category: "ROUTE",
      affectedFiles: routes.map((f) => f.path),
      relatedChangeIds: changeIds,
      relatedRequirementIds: ca.migrationRequirements.map((r) => r.id),
      reason: `${routes.length} route file(s) were identified as directly affected by P5 impact analysis.`,
      risk: stepRisk(rs.level, "medium"),
      dependencies: [],
    });
  }
  if (controllers.length > 0) {
    const stepId = nextId();
    steps.push({
      id: stepId,
      order: 0,
      title: `Update controller files for ${ca.targetVersion} compatibility`,
      description: `Review and update ${controllers.length} controller file(s) to be compatible with ${ca.packageName}@${ca.targetVersion}.`,
      category: "CONTROLLER",
      affectedFiles: controllers.map((f) => f.path),
      relatedChangeIds: [],
      relatedRequirementIds: ca.migrationRequirements.map((r) => r.id),
      reason: `${controllers.length} controller file(s) were identified as affected by P5 impact analysis.`,
      risk: stepRisk(rs.level, "medium"),
      dependencies: [],
    });
  }
  return steps;
}

function buildConfigSteps(
  nextId: () => string,
  ia: ParsedIA,
  ca: ParsedCA,
  rs: ParsedRS
): MigrationStep[] {
  const configFilePaths = [
    ...ia.affectedConfigs.map((c) => c.path),
    ...ia.affectedFiles.filter((f) => f.category === "CONFIG").map((f) => f.path),
  ];
  const paths = [...new Set(configFilePaths)];
  if (paths.length === 0) return [];
  const stepId = nextId();
  return [
    {
      id: stepId,
      order: 0,
      title: `Update configuration files for ${ca.targetVersion}`,
      description: `Review and update ${paths.length} configuration file(s) that may require changes when migrating to ${ca.packageName}@${ca.targetVersion}.`,
      category: "CONFIG",
      affectedFiles: paths,
      relatedChangeIds: [],
      relatedRequirementIds: ca.migrationRequirements
        .filter((r) => r.description.toLowerCase().includes("config"))
        .map((r) => r.id),
      reason: `${paths.length} configuration file(s) were identified as potentially affected.`,
      risk: "LOW",
      dependencies: [],
    },
  ];
}

function buildTestSteps(
  nextId: () => string,
  ia: ParsedIA,
  ca: ParsedCA,
  rs: ParsedRS
): MigrationStep[] {
  if (ia.affectedTests.length === 0) return [];
  const stepId = nextId();
  return [
    {
      id: stepId,
      order: 0,
      title: `Update test files for ${ca.targetVersion} compatibility`,
      description: `Review and update ${ia.affectedTests.length} test file(s) identified during P5 impact analysis. Tests that import or depend on ${ca.packageName} behavior may require updates to reflect ${ca.targetVersion} semantics.`,
      category: "TEST",
      affectedFiles: ia.affectedTests.map((t) => t.path),
      relatedChangeIds: ca.breakingChanges.map((bc) => bc.id),
      relatedRequirementIds: ca.migrationRequirements.map((r) => r.id),
      reason: `${ia.affectedTests.length} test file(s) were identified as affected by P5 impact analysis.`,
      risk: "LOW",
      dependencies: [],
    },
  ];
}

function buildOtherSteps(
  nextId: () => string,
  ia: ParsedIA,
  ca: ParsedCA,
  rs: ParsedRS,
  alreadyPlanned: MigrationStep[]
): MigrationStep[] {
  // Collect files already covered by previous steps
  const plannedFiles = new Set(alreadyPlanned.flatMap((s) => s.affectedFiles));
  // Remaining affected files not yet assigned to a category
  const remaining = ia.affectedFiles.filter(
    (f) =>
      f.category === "API" ||
      f.category === "OTHER" ||
      (f.category !== "TEST" &&
        f.category !== "CONFIG" &&
        f.category !== "MIDDLEWARE" &&
        f.category !== "ROUTE" &&
        f.category !== "CONTROLLER" &&
        !plannedFiles.has(f.path))
  );
  const unplanned = remaining.filter((f) => !plannedFiles.has(f.path));
  if (unplanned.length === 0) return [];

  const stepId = nextId();
  return [
    {
      id: stepId,
      order: 0,
      title: `Update remaining affected files for ${ca.targetVersion} compatibility`,
      description: `Review and update ${unplanned.length} additional file(s) identified by P5 impact analysis that require attention during migration.`,
      category: "OTHER",
      affectedFiles: unplanned.map((f) => f.path),
      relatedChangeIds: ca.breakingChanges.map((bc) => bc.id),
      relatedRequirementIds: ca.migrationRequirements.map((r) => r.id),
      reason: `${unplanned.length} file(s) were identified as affected but do not fall into a specific migration category.`,
      risk: stepRisk(rs.level, "low"),
      dependencies: [],
    },
  ];
}

// ---------------------------------------------------------------------------
// Prerequisite builder
// ---------------------------------------------------------------------------

function buildPrerequisites(ia: ParsedIA, ca: ParsedCA): MigrationPrerequisite[] {
  const prereqs: MigrationPrerequisite[] = [];

  // Always: target version availability
  prereqs.push({
    id: "PREREQ-001",
    title: `${ca.packageName}@${ca.targetVersion} is available`,
    description: `The target package version ${ca.packageName}@${ca.targetVersion} must be published and available in the package registry before migration begins.`,
    evidence: [`${ca.packageName}@${ca.targetVersion}`],
    mandatory: true,
  });

  // Per dependency: upgrade required first
  for (let i = 0; i < ia.affectedDependencies.length; i++) {
    const dep = ia.affectedDependencies[i]!;
    prereqs.push({
      id: `PREREQ-${String(i + 2).padStart(3, "0")}`,
      title: `Upgrade ${dep.name} in ${dep.dependencyType}`,
      description: `The dependency ${dep.name} (currently declared as ${dep.declaredVersion}) must be upgraded to a version compatible with ${ca.packageName}@${ca.targetVersion} before API-level migration work begins.`,
      evidence: [`${dep.name}@${dep.declaredVersion}`, dep.dependencyType],
      mandatory: true,
    });
  }

  // If there are high-risk areas involving middleware, note it
  const middlewareAreas = ia.highRiskAreas.filter((a) =>
    a.title.toLowerCase().includes("middleware")
  );
  if (middlewareAreas.length > 0) {
    prereqs.push({
      id: `PREREQ-${String(prereqs.length + 1).padStart(3, "0")}`,
      title: "Review middleware compatibility before migration",
      description: `Middleware identified as high-risk during P5 analysis (${middlewareAreas.map((a) => a.title).join(", ")}) should be reviewed for ${ca.targetVersion} compatibility before the migration proceeds.`,
      evidence: middlewareAreas.flatMap((a) => a.files),
      mandatory: false,
    });
  }

  return prereqs;
}

// ---------------------------------------------------------------------------
// Validation requirement builder
// ---------------------------------------------------------------------------

function buildValidationRequirements(
  ia: ParsedIA,
  ca: ParsedCA,
  steps: MigrationStep[]
): ValidationRequirement[] {
  const reqs: ValidationRequirement[] = [];
  const stepIds = steps.map((s) => s.id);

  // Build must succeed
  reqs.push({
    id: "VAL-001",
    title: "Application build must pass",
    description: `After migration, the application must compile/build successfully against ${ca.packageName}@${ca.targetVersion} with no TypeScript or build errors.`,
    relatedStepIds: stepIds,
  });

  // Tests must pass if any test files are affected
  if (ia.affectedTests.length > 0) {
    const testStepIds = steps.filter((s) => s.category === "TEST").map((s) => s.id);
    reqs.push({
      id: "VAL-002",
      title: "Affected tests must pass",
      description: `${ia.affectedTests.length} test file(s) identified during impact analysis must pass after migration. Tests should confirm that ${ca.targetVersion} behavior is correctly handled.`,
      relatedStepIds: testStepIds.length > 0 ? testStepIds : stepIds,
    });
  }

  // No deprecated APIs should remain
  if (ia.affectedApis.length > 0) {
    const apiStepIds = steps.filter((s) => s.category === "API").map((s) => s.id);
    reqs.push({
      id: "VAL-003",
      title: "Deprecated API usage must be eliminated",
      description: `${ia.affectedApis.length} deprecated/removed API call(s) identified during P5 analysis should no longer be present in the codebase after migration.`,
      relatedStepIds: apiStepIds.length > 0 ? apiStepIds : stepIds,
    });
  }

  // High-risk areas must be verified
  if (ia.highRiskAreas.length > 0) {
    reqs.push({
      id: `VAL-${String(reqs.length + 1).padStart(3, "0")}`,
      title: "High-risk areas must be manually verified",
      description: `${ia.highRiskAreas.length} high-risk area(s) (${ia.highRiskAreas.map((a) => a.title).join(", ")}) identified during impact analysis should be manually reviewed and verified after migration.`,
      relatedStepIds: stepIds,
    });
  }

  return reqs;
}

// ---------------------------------------------------------------------------
// Helper — derive step risk relative to overall risk level
// ---------------------------------------------------------------------------

/**
 * For a given step category "natural risk", return the appropriate level.
 * - A HIGH overall risk migration escalates step risks to at least MEDIUM.
 * - A CRITICAL overall risk migration escalates all to at least HIGH.
 */
function stepRisk(overall: RiskLevel, natural: "low" | "medium" | "high"): RiskLevel {
  const levels: RiskLevel[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
  const naturalLevel: RiskLevel = natural === "low" ? "LOW" : natural === "medium" ? "MEDIUM" : "HIGH";
  const naturalIdx = levels.indexOf(naturalLevel);
  const overallIdx = levels.indexOf(overall);
  // Escalate: take the higher of natural and (overall - 1)
  const escalated = Math.max(naturalIdx, overallIdx - 1);
  return levels[Math.min(escalated, levels.length - 1)]!;
}
