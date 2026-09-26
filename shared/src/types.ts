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
