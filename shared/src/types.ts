// Shared types for DriftZero

export type MigrationStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "STOPPED"
  | "UNSAFE";

export type MigrationStage =
  | "PENDING"
  | "ANALYZING"
  | "IMPACT_ANALYSIS"
  | "RISK_ASSESSMENT"
  | "PREVIEW"
  | "PLANNING"
  | "MIGRATING"
  | "TEST_GENERATION"
  | "VALIDATING"
  | "RECOVERING"
  | "REVALIDATING"
  | "CHANGE_VERIFICATION"
  | "SECURITY_REVIEW"
  | "SAFETY_GATE"
  | "DIFF_INTELLIGENCE"
  | "CONFIDENCE"
  | "VERIFIED"
  | "COMMIT"
  | "PUSH"
  | "CREATE_PR"
  | "REPORT"
  | "COMPLETED";

export interface MigrationJob {
  id: string;
  repoUrl: string;
  sourceVersion: string;
  targetVersion: string;
  status: MigrationStatus;
  currentStage: MigrationStage;
  progress: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Workspace types
// ---------------------------------------------------------------------------

/** Lifecycle status of an isolated migration workspace. */
export type WorkspaceStatus =
  | "CREATING"
  | "READY"
  | "CLEANING"
  | "CLEANED"
  | "FAILED";

/** A controlled temporary directory that holds a cloned repository. */
export interface Workspace {
  /** Unique workspace identifier, e.g. ws_<uuid> */
  id: string;
  /** Source repository URL (or local path) that was cloned. */
  repoUrl: string;
  /** Absolute path to the isolated workspace directory on disk. */
  path: string;
  /** Git branch checked out inside the workspace, if any. */
  branch: string | null;
  /** ISO timestamp when the workspace was created. */
  createdAt: string;
  /** Current lifecycle status. */
  status: WorkspaceStatus;
}

/** Structured result of a controlled command execution. */
export interface CommandResult {
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

/** Result returned by a workspace cleanup operation. */
export interface CleanupResult {
  workspaceId: string;
  path: string;
  success: boolean;
  alreadyCleaned: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Change Analysis types
// ---------------------------------------------------------------------------

export type ChangeSeverity = "low" | "medium" | "high" | "critical";

export interface BreakingChange {
  id: string;
  title: string;
  description: string;
  severity: ChangeSeverity;
  affectedArea?: string;
  migrationRequired: boolean;
}

export interface DeprecatedApi {
  id: string;
  apiName: string;
  description: string;
  replacement?: string;
  removedInVersion?: string;
}

export interface BehaviorChange {
  id: string;
  title: string;
  description: string;
  severity: ChangeSeverity;
  affectedArea?: string;
}

export interface MigrationRequirement {
  id: string;
  title: string;
  description: string;
  mandatory: boolean;
}

export interface MigrationPattern {
  id: string;
  title: string;
  description: string;
  before?: string;
  after?: string;
}

/** Full structured result from the Change Analysis Agent. */
export interface ChangeAnalysisResult {
  packageName: string;
  sourceVersion: string;
  targetVersion: string;
  summary: string;
  breakingChanges: BreakingChange[];
  deprecatedApis: DeprecatedApi[];
  behaviorChanges: BehaviorChange[];
  migrationRequirements: MigrationRequirement[];
  migrationPatterns: MigrationPattern[];
  compatibilityNotes: string[];
  /** ISO timestamp of when the analysis was performed. */
  analyzedAt: string;
  /** Metadata for future evidence/traceability use. */
  meta: ChangeAnalysisMeta;
}

/** Traceability metadata attached to every analysis. */
export interface ChangeAnalysisMeta {
  bobDurationMs: number;
  promptLength: number;
}

/** Input to the Change Analysis Agent. */
export interface ChangeAnalysisInput {
  packageName: string;
  sourceVersion: string;
  targetVersion: string;
}

// ---------------------------------------------------------------------------
// Impact Analysis types (P5)
// ---------------------------------------------------------------------------

export type AffectedFileCategory =
  | "API"
  | "ROUTE"
  | "MIDDLEWARE"
  | "CONTROLLER"
  | "TEST"
  | "DEPENDENCY"
  | "CONFIG"
  | "OTHER";

export interface AffectedFile {
  path: string;
  category: AffectedFileCategory;
  reason: string;
  relevance: "direct" | "indirect";
  evidence: string[];
}

export interface AffectedApi {
  file: string;
  symbol?: string;
  api: string;
  reason: string;
  /** References a MigrationRequirement.id from the P4 ChangeAnalysisResult */
  migrationRequirementId?: string;
}

export interface AffectedDependency {
  name: string;
  declaredVersion: string;
  dependencyType: "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies";
  packageManager: "npm" | "pnpm" | "yarn" | "unknown";
  reason: string;
}

export interface AffectedTest {
  path: string;
  reason: string;
  evidence: string[];
}

export interface AffectedConfig {
  path: string;
  reason: string;
}

export interface HighRiskArea {
  title: string;
  description: string;
  files: string[];
}

export interface ImpactAnalysisResult {
  packageName: string;
  sourceVersion: string;
  targetVersion: string;
  affectedFiles: AffectedFile[];
  affectedApis: AffectedApi[];
  affectedDependencies: AffectedDependency[];
  affectedTests: AffectedTest[];
  affectedConfigs: AffectedConfig[];
  highRiskAreas: HighRiskArea[];
  summary: string;
  analyzedAt: string;
}

export interface ImpactAnalysisInput {
  workspacePath: string;
  packageName: string;
  sourceVersion: string;
  targetVersion: string;
  changeAnalysis: ChangeAnalysisResult;
}

// ---------------------------------------------------------------------------
// Risk Score types (P6)
// ---------------------------------------------------------------------------

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** A single scored contributing factor with evidence. */
export interface RiskReason {
  factor: string;
  description: string;
  /** Points contributed by this factor toward the total score. */
  contribution: number;
  evidence: string[];
}

/** Raw factor counts before scoring (for UI display). */
export interface RiskFactors {
  breakingChanges: number;
  deprecatedApis: number;
  affectedFiles: number;
  affectedApis: number;
  affectedDependencies: number;
  affectedTests: number;
  highRiskAreas: number;
}

/** The fully resolved risk assessment for a migration. */
export interface RiskScoreResult {
  /** Numeric score 0–100. */
  score: number;
  level: RiskLevel;
  reasons: RiskReason[];
  factors: RiskFactors;
  assessedAt: string;
}

/** Input to the Risk Scoring Engine. */
export interface RiskScoreInput {
  changeAnalysis: ChangeAnalysisResult;
  impactAnalysis: ImpactAnalysisResult;
}

// ---------------------------------------------------------------------------
// Impact Preview types (P7)
// ---------------------------------------------------------------------------

/**
 * Source phase that produced a preview finding.
 * Enables full traceability: preview item → P4/P5 finding → raw evidence.
 */
export type PreviewSource = "CHANGE_ANALYSIS" | "IMPACT_ANALYSIS" | "RISK_SCORE";

/**
 * A single evidence-backed finding in the impact preview.
 *
 * Language is predictive ("may require", "potentially affected") — not
 * declarative ("this is broken"). The preview runs before migration.
 */
export interface PreviewItem {
  /** Short human-readable title. */
  title: string;
  /** Predictive description of the impact. */
  description: string;
  /** Severity inherited from the upstream P4/P5 finding, if applicable. */
  severity?: ChangeSeverity;
  /** Which upstream phase produced this finding. */
  source: PreviewSource;
  /** Raw evidence strings (IDs, file paths, API names) backing this item. */
  evidence: string[];
  /** Source file associated with this finding, if applicable. */
  file?: string;
}

/** Ordered, evidence-backed "What Will Break?" preview. */
export interface ImpactPreviewResult {
  packageName: string;
  sourceVersion: string;
  targetVersion: string;

  /** P6 risk score and level — passed through unchanged, never recalculated. */
  risk: {
    score: number;
    level: RiskLevel;
  };

  /** Deterministic code-generated summary — never AI-generated. */
  summary: string;

  // Ordered categories (spec §8)
  breakingChanges: PreviewItem[];
  deprecatedApis: PreviewItem[];
  highRiskAreas: PreviewItem[];
  affectedApis: PreviewItem[];
  affectedFiles: PreviewItem[];
  affectedDependencies: PreviewItem[];
  affectedTests: PreviewItem[];
  affectedConfigs: PreviewItem[];
  behaviorChanges: PreviewItem[];

  /** ISO timestamp when the preview was generated. */
  generatedAt: string;
}

/** Input to the Impact Preview Engine. */
export interface ImpactPreviewInput {
  changeAnalysis: ChangeAnalysisResult;
  impactAnalysis: ImpactAnalysisResult;
  riskScore: RiskScoreResult;
}

// ---------------------------------------------------------------------------
// Migration Planner types (P8)
// ---------------------------------------------------------------------------

export type StepCategory =
  | "DEPENDENCY"
  | "API"
  | "MIDDLEWARE"
  | "ROUTE"
  | "CONTROLLER"
  | "TEST"
  | "CONFIG"
  | "OTHER";

/** A single ordered, traceable step in the migration plan. */
export interface MigrationStep {
  /** Deterministic sequential ID, e.g. STEP-001. */
  id: string;
  /** 1-based execution order. */
  order: number;
  title: string;
  description: string;
  category: StepCategory;
  /** Relative file paths from P5 that this step will modify. */
  affectedFiles: string[];
  /** P4 BreakingChange/BehaviorChange IDs related to this step. */
  relatedChangeIds: string[];
  /** P4 MigrationRequirement IDs related to this step. */
  relatedRequirementIds: string[];
  /** Human-readable rationale for this step. */
  reason: string;
  /** Risk level for this individual step. */
  risk: RiskLevel;
  /** IDs of MigrationSteps that must complete before this one. */
  dependencies: string[];
}

/** A required condition that must be satisfied before migration begins. */
export interface MigrationPrerequisite {
  id: string;
  title: string;
  description: string;
  /** Traceability references (P4 IDs, P5 file paths, etc.). */
  evidence: string[];
  mandatory: boolean;
}

/** A post-migration validation requirement. P9/validation engine will execute these. */
export interface ValidationRequirement {
  id: string;
  title: string;
  description: string;
  /** Step IDs this requirement validates. */
  relatedStepIds: string[];
}

/** A fully planned, ordered migration with DAG-validated step dependencies. */
export interface MigrationPlan {
  packageName: string;
  sourceVersion: string;
  targetVersion: string;
  /** High-level goal of this migration. */
  objective: string;
  prerequisites: MigrationPrerequisite[];
  /** Ordered steps forming a valid DAG. */
  steps: MigrationStep[];
  validationRequirements: ValidationRequirement[];
  /** Human-readable areas affected (from P5/P7). */
  affectedAreas: string[];
  /** P6 risk — passed through unchanged. */
  risk: {
    score: number;
    level: RiskLevel;
  };
  /** ISO timestamp when the plan was generated. */
  generatedAt: string;
}

/** Input to the Migration Planner. */
export interface MigrationPlannerInput {
  changeAnalysis: ChangeAnalysisResult;
  impactAnalysis: ImpactAnalysisResult;
  riskScore: RiskScoreResult;
  impactPreview: ImpactPreviewResult;
}

export interface CreateMigrationRequest {
  repoUrl: string;
  sourceVersion: string;
  targetVersion: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
}

export interface HealthResponse {
  status: "ok" | "degraded" | "down";
  uptime: number;
  version: string;
  timestamp: string;
}
