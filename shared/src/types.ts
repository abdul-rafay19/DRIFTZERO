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

// ---------------------------------------------------------------------------
// Code Migration Agent types (P9)
// ---------------------------------------------------------------------------

/** Status of a single file change produced by P9. */
export type MigrationChangeStatus = "APPLIED" | "REJECTED" | "FAILED";

/** A file operation proposed by IBM Bob and applied by P9. */
export type MigrationOperation = "MODIFY" | "CREATE";

/**
 * A successfully applied file change.
 * Traceable to the migration step that authorized it.
 */
export interface MigrationChange {
  stepId: string;
  filePath: string;
  operation: MigrationOperation;
  /** Bob's explanation of what was changed and why. */
  explanation: string;
}

/**
 * Structured evidence record for every applied, rejected, or failed change.
 * Evidence answers: which step? which file? what operation? was it applied? why?
 */
export interface MigrationEvidence {
  stepId: string;
  filePath: string;
  operation: MigrationOperation;
  status: MigrationChangeStatus;
  reason: string;
}

/** Full result of a P9 code migration execution. */
export interface CodeMigrationResult {
  workspaceId: string;
  /** Total steps in the P8 plan. */
  planSteps: number;
  completedSteps: number;
  failedSteps: number;
  /** COMPLETED if all steps finished without error; FAILED otherwise. */
  status: "COMPLETED" | "FAILED";
  changes: MigrationChange[];
  evidence: MigrationEvidence[];
}

/** Input to the Code Migration Agent. */
export interface CodeMigrationInput {
  workspace: Workspace;
  plan: MigrationPlan;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
}

// ---------------------------------------------------------------------------
// Test Generation Agent types (P10)
// ---------------------------------------------------------------------------

/** A test file change applied by P10. */
export interface TestChange {
  stepId: string;
  filePath: string;
  operation: MigrationOperation;
  explanation: string;
  relatedChangeIds: string[];
}

/** Structured evidence record for every applied, rejected, or failed test change. */
export interface TestChangeEvidence {
  stepId: string;
  filePath: string;
  operation: MigrationOperation;
  status: MigrationChangeStatus;
  reason: string;
  relatedChangeIds: string[];
}

/** Full result of a P10 test generation execution. */
export interface TestGenerationResult {
  workspaceId: string;
  plannedTestChanges: number;
  appliedTestChanges: number;
  failedTestChanges: number;
  status: "COMPLETED" | "FAILED";
  changes: TestChange[];
  evidence: TestChangeEvidence[];
}

/** Input to the Test Generation Agent. */
export interface TestGenerationInput {
  workspace: Workspace;
  plan: MigrationPlan;
  migrationResult: CodeMigrationResult;
}

export interface HealthResponse {
  status: "ok" | "degraded" | "down";
  uptime: number;
  version: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// P11 — Validation Engine types
// ---------------------------------------------------------------------------

/** The category of a validation check. */
export type ValidationCheckType = "DEPENDENCY" | "TYPECHECK" | "BUILD" | "TEST";

/**
 * The outcome of a single validation check.
 *
 * PASSED        — command executed with exit code 0
 * FAILED        — command executed with non-zero exit code or timed out
 * NOT_APPLICABLE — no script or configuration exists for this check
 * SKIPPED       — skipped because a prerequisite check failed
 */
export type ValidationCheckStatus = "PASSED" | "FAILED" | "NOT_APPLICABLE" | "SKIPPED";

/** Structured result for one validation check. */
export interface ValidationCheckResult {
  /** Unique check identifier, e.g. "check-typecheck". */
  id: string;
  /** Category of this check. */
  type: ValidationCheckType;
  /** Outcome of the check. */
  status: ValidationCheckStatus;
  /** The command that was (or would have been) executed. */
  command?: string;
  /** Arguments passed to the command. */
  args?: string[];
  /** Process exit code (undefined if not applicable/skipped). */
  exitCode?: number;
  /** Captured stdout (may be truncated). */
  stdout?: string;
  /** Captured stderr (may be truncated). */
  stderr?: string;
  /** Execution duration in milliseconds. */
  durationMs: number;
  /** Human-readable explanation of the outcome. */
  reason?: string;
  /** Whether the captured output was truncated. */
  truncated?: boolean;
}

/** Counts and summary across all checks in a validation run. */
export interface ValidationSummary {
  total: number;
  passed: number;
  failed: number;
  notApplicable: number;
  skipped: number;
}

/**
 * The full result of a P11 validation run.
 *
 * status:
 *   PASSED        — all required applicable checks passed
 *   FAILED        — at least one required check failed
 *   NOT_VALIDATED — engine could not establish validation (e.g. no checks applicable)
 */
export interface ValidationResult {
  workspaceId: string;
  status: "PASSED" | "FAILED" | "NOT_VALIDATED";
  checks: ValidationCheckResult[];
  summary: ValidationSummary;
  startedAt: string;
  completedAt: string;
}

/** Input to the P11 Validation Engine. */
export interface ValidationInput {
  workspace: Workspace;
  migrationPlan: MigrationPlan;
  /** P9 result — optional; provides context for evidence traceability. */
  migrationResult?: CodeMigrationResult;
  /** P10 result — optional; provides context for evidence traceability. */
  testGenerationResult?: TestGenerationResult;
}

// ---------------------------------------------------------------------------
// P12 — Autonomous Recovery Engine types
// ---------------------------------------------------------------------------

/** Overall status of a P12 recovery run. */
export type RecoveryStatus =
  | "RECOVERED"      // P11 passed after one or more repair attempts
  | "NOT_NEEDED"     // P11 was already PASSED — no recovery required
  | "FAILED"         // All attempts exhausted; P11 never passed
  | "STOPPED";       // Attempt limit reached or unsafe condition detected

/** Status of a single recovery attempt. */
export type RecoveryAttemptStatus =
  | "RECOVERED"   // This attempt resulted in P11 PASSED
  | "FAILED"      // Repair applied but P11 still FAILED
  | "REJECTED"    // Proposal was unsafe/unauthorized — no changes applied
  | "STOPPED";    // Bob failed or limit reached — no changes applied

/** A single file change within a repair proposal or applied result. */
export interface RecoveryChange {
  filePath: string;
  operation: "MODIFY" | "CREATE";
  explanation: string;
  relatedStepIds: string[];
  relatedValidationCheckIds: string[];
}

/** Bob's structured diagnosis and repair proposal for one attempt. */
export interface RecoveryDiagnosis {
  /** Short description of what Bob believes went wrong. */
  diagnosis: string;
  /** Root cause analysis from Bob (advisory — not proven). */
  rootCause: string;
  /** List of proposed file changes. */
  proposedChanges: RecoveryChange[];
  /** Bob's inference duration. */
  bobDurationMs: number;
}

/** Full record of a single autonomous recovery attempt. */
export interface RecoveryAttempt {
  /** 1-based attempt number. */
  attempt: number;
  /** Bob's diagnosis and proposed repair. */
  diagnosis: RecoveryDiagnosis;
  /** Changes that were proposed by Bob. */
  proposedChanges: RecoveryChange[];
  /** Changes that were actually applied (empty if proposal was rejected). */
  appliedChanges: RecoveryChange[];
  /** P11 result after applying repair (or the original failure if rejected). */
  validation: ValidationResult;
  status: RecoveryAttemptStatus;
  /** Human-readable reason for this attempt's outcome. */
  reason: string;
}

/** Full result of a P12 recovery run. */
export interface RecoveryResult {
  workspaceId: string;
  status: RecoveryStatus;
  /** All attempted recovery rounds. */
  attempts: RecoveryAttempt[];
  /** The final P11 ValidationResult after all attempts. */
  finalValidation?: ValidationResult;
  /** Human-readable summary of the recovery outcome. */
  reason: string;
}

/** Input to the P12 Autonomous Recovery Engine. */
export interface RecoveryInput {
  workspace: Workspace;
  migrationPlan: MigrationPlan;
  migrationResult: CodeMigrationResult;
  testGenerationResult?: TestGenerationResult;
  /** The P11 ValidationResult that triggered recovery. */
  validationResult: ValidationResult;
}

// ---------------------------------------------------------------------------
// P13 — Recovery Verification types
// ---------------------------------------------------------------------------

/** Identifies which structural invariant a verification check tests. */
export type RecoveryVerificationCheckType =
  | "INITIAL_FAILURE_CHECK"
  | "ATTEMPT_SEQUENCE_CHECK"
  | "ATTEMPT_LIMIT_CHECK"
  | "CHANGE_SCOPE_CHECK"
  | "CHANGE_EVIDENCE_CHECK"
  | "EXPECTED_STATE_CHECK"
  | "POST_REPAIR_VALIDATION_CHECK"
  | "FINAL_STATUS_CHECK"
  | "DUPLICATE_REPAIR_CHECK"
  | "RECOVERY_CONSISTENCY_CHECK";

/** Outcome of a single verification check. */
export type RecoveryVerificationCheckStatus = "PASSED" | "FAILED";

/** Structured result for one verification check. */
export interface RecoveryVerificationCheck {
  /** Unique check ID within this verification run, e.g. "vc-final-status". */
  id: string;
  /** Which structural invariant this check tests. */
  type: RecoveryVerificationCheckType;
  /** Outcome of this check. */
  status: RecoveryVerificationCheckStatus;
  /** Human-readable description of what was checked and what was found. */
  message: string;
  /** Supporting evidence references (file paths, attempt numbers, etc.). */
  evidence?: string[];
}

/**
 * Overall status of a P13 verification run.
 *
 * VERIFIED      — all checks passed; recovery evidence is complete and consistent
 * NOT_REQUIRED  — initial validation was already PASSED; no recovery was needed
 * FAILED        — evidence is missing, contradictory, or insufficient
 */
export type RecoveryVerificationStatus = "VERIFIED" | "NOT_REQUIRED" | "FAILED";

/** Full result of a P13 recovery verification run. */
export interface RecoveryVerificationResult {
  status: RecoveryVerificationStatus;
  /** The P12 status that was verified (or NOT_NEEDED). */
  recoveryStatus: RecoveryStatus;
  /** All checks executed, in deterministic order. */
  checks: RecoveryVerificationCheck[];
  /** The final P11 ValidationResult from the recovery process (if present). */
  finalValidation?: ValidationResult;
  /** Number of P12 recovery attempts verified. */
  verifiedAttempts: number;
  /** Total number of applied recovery changes verified. */
  verifiedChanges: number;
  /** All error messages from failed checks. */
  errors: string[];
  /** Human-readable summary of the verification outcome. */
  summary: string;
}

/** Input to the P13 Recovery Verification engine. */
export interface RecoveryVerificationInput {
  workspace: Workspace;
  migrationPlan: MigrationPlan;
  migrationResult: CodeMigrationResult;
  testGenerationResult?: TestGenerationResult;
  /** The initial P11 ValidationResult before any recovery. */
  initialValidation: ValidationResult;
  /** The full P12 RecoveryResult to be verified. */
  recoveryResult: RecoveryResult;
}

// ---------------------------------------------------------------------------
// P14 — Unexpected Change Detection types
// ---------------------------------------------------------------------------

/** How a file actually changed in the workspace. */
export type ActualChangeType = "ADDED" | "MODIFIED" | "DELETED" | "RENAMED";

/** A file change detected in the actual workspace diff. */
export interface ActualChange {
  filePath: string;
  changeType: ActualChangeType;
  /** For RENAMED: original path. */
  oldPath?: string;
}

/**
 * The migration phase that authorized an expected change.
 * P8 affectedFiles alone does NOT constitute authorization.
 */
export type ExpectedChangeSource = "P9" | "P10" | "P12";

/** A change that DRIFTZERO explicitly authorized during migration/recovery. */
export interface ExpectedChange {
  filePath: string;
  source: ExpectedChangeSource;
  relatedStepIds: string[];
}

/** Why a change is considered unexpected. */
export type UnexpectedChangeReason =
  | "NOT_AUTHORIZED"
  | "NOT_IN_MIGRATION_SCOPE"
  | "UNEXPECTED_DELETE"
  | "UNEXPECTED_CREATE"
  | "UNEXPECTED_RENAME";

/** A file change that has no authorized migration evidence. */
export interface UnexpectedChange {
  filePath: string;
  changeType: ActualChangeType;
  reason: UnexpectedChangeReason;
  evidence: string[];
}

/** Summary counts for the detection result. */
export interface UnexpectedChangeSummary {
  totalActualChanges: number;
  totalExpectedChanges: number;
  totalUnexpectedChanges: number;
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
}

/**
 * Result of the P14 Unexpected Change Detection engine.
 *
 * CLEAN             — all actual changes are authorized
 * UNEXPECTED_CHANGES — one or more unauthorized changes detected
 * FAILED            — infrastructure/input error prevented reliable detection
 */
export type UnexpectedChangeDetectionStatus =
  | "CLEAN"
  | "UNEXPECTED_CHANGES"
  | "FAILED";

/** Full result of a P14 detection run. */
export interface UnexpectedChangeDetectionResult {
  workspaceId: string;
  status: UnexpectedChangeDetectionStatus;
  actualChanges: ActualChange[];
  expectedChanges: ExpectedChange[];
  unexpectedChanges: UnexpectedChange[];
  summary: UnexpectedChangeSummary;
}

/** Input to the P14 Unexpected Change Detection engine. */
export interface UnexpectedChangeDetectionInput {
  workspace: Workspace;
  migrationPlan: MigrationPlan;
  migrationResult: CodeMigrationResult;
  testGenerationResult?: TestGenerationResult;
  recoveryResult?: RecoveryResult;
}

// ---------------------------------------------------------------------------
// P15 — Security Engine types
// ---------------------------------------------------------------------------

/**
 * The overall status of a P15 security scan.
 *
 * CLEAN    — all deterministic checks ran; no findings
 * FINDINGS — one or more security findings exist
 * PARTIAL  — deterministic checks completed but optional component (Bob or
 *            dependency audit) could not complete
 * FAILED   — the security engine itself could not produce a reliable result
 */
export type SecurityScanStatus = "CLEAN" | "FINDINGS" | "PARTIAL" | "FAILED";

/** Category that classifies the nature of a security finding. */
export type SecurityFindingCategory =
  | "SECRET"
  | "DEPENDENCY"
  | "CODE"
  | "CONFIGURATION"
  | "AI_REVIEW";

/** Severity of a security finding (does NOT imply a migration verdict). */
export type SecurityFindingSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/**
 * Which scanner produced the finding.
 * DETERMINISTIC — secret scanner or code/config pattern analysis
 * DEPENDENCY_AUDIT — package-manager audit
 * BOB — IBM Bob security review (advisory only)
 */
export type SecurityFindingSource = "DETERMINISTIC" | "DEPENDENCY_AUDIT" | "BOB";

/** A single security finding with full evidence attribution. */
export interface SecurityFinding {
  /** Stable deterministic ID, e.g. "SEC-001". */
  id: string;
  category: SecurityFindingCategory;
  severity: SecurityFindingSeverity;
  title: string;
  description: string;
  /** Relative file path within the workspace (if file-specific). */
  filePath?: string;
  /** Line number within the file (if known). */
  line?: number;
  /** Evidence strings — MUST NOT contain raw secret values. */
  evidence: string[];
  source: SecurityFindingSource;
  /** Optional remediation advice. */
  recommendation?: string;
}

/** Status of a single security check phase. */
export type SecurityCheckStatus = "PASSED" | "FINDINGS" | "SKIPPED" | "FAILED";

/** Result of one named security check (e.g. "secret-scan", "dependency-audit"). */
export interface SecurityCheckResult {
  id: string;
  name: string;
  status: SecurityCheckStatus;
  findingCount: number;
  durationMs: number;
  /** Human-readable reason when status is SKIPPED or FAILED. */
  reason?: string;
}

/** Aggregate counts across all findings in a scan. */
export interface SecuritySummary {
  totalFindings: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  secretsDetected: number;
  dependencyFindings: number;
  codeFindings: number;
  configurationFindings: number;
  aiReviewFindings: number;
}

/** Full result of a P15 security scan. */
export interface SecurityScanResult {
  workspaceId: string;
  status: SecurityScanStatus;
  findings: SecurityFinding[];
  summary: SecuritySummary;
  checks: SecurityCheckResult[];
  startedAt: string;
  completedAt: string;
}

/** Input to the P15 Security Engine. */
export interface SecurityScanInput {
  workspace: Workspace;
  migrationPlan: MigrationPlan;
  migrationResult: CodeMigrationResult;
  testGenerationResult?: TestGenerationResult;
  recoveryResult?: RecoveryResult;
  unexpectedChanges?: UnexpectedChangeDetectionResult;
}

// ---------------------------------------------------------------------------
// P16 — Migration Safety Gate types
// ---------------------------------------------------------------------------

/**
 * The authoritative migration safety decision.
 *
 * SAFE_TO_PROCEED — all mandatory safety checks passed; migration may advance
 * STOP_SAFELY     — one or more checks failed; migration must halt
 */
export type SafetyDecision = "SAFE_TO_PROCEED" | "STOP_SAFELY";

/** The outcome of a single deterministic safety check. */
export type SafetyCheckStatus = "PASS" | "FAIL" | "NOT_VERIFIED";

/** Severity of a safety reason — used to distinguish blocking vs advisory. */
export type SafetyReasonSeverity = "ERROR" | "WARNING";

/** A deterministic safety check result. */
export interface SafetyCheckResult {
  /** Stable check identifier, e.g. "SG-001". */
  id: string;
  /** Human-readable check name. */
  name: string;
  /** Outcome of this check. */
  status: SafetyCheckStatus;
  /** Whether this check, if FAIL/NOT_VERIFIED, blocks SAFE_TO_PROCEED. */
  blocking: boolean;
  /** Human-readable reason for this status. */
  reason: string;
  /** Supporting evidence items (must NOT contain secret values). */
  evidence: string[];
}

/** A structured safety reason (blocking or advisory). */
export interface SafetyReason {
  /** Stable reason code, e.g. "VALIDATION_FAILED". */
  code: string;
  severity: SafetyReasonSeverity;
  title: string;
  message: string;
  /** Supporting evidence items. */
  evidence: string[];
}

/** Aggregate counts for the safety gate summary. */
export interface SafetySummary {
  totalChecks: number;
  passed: number;
  failed: number;
  notVerified: number;
  blockingReasonCount: number;
  warningCount: number;
}

/** Full result of a P16 safety gate evaluation. */
export interface SafetyGateResult {
  workspaceId: string;
  decision: SafetyDecision;
  /** All safety checks in stable SG-001 … SG-005 order. */
  checks: SafetyCheckResult[];
  /** Reasons that caused STOP_SAFELY. Empty when SAFE_TO_PROCEED. */
  blockingReasons: SafetyReason[];
  /** Advisory warnings that do not block progression. */
  warnings: SafetyReason[];
  summary: SafetySummary;
}

/** Input to the P16 Safety Gate. */
export interface SafetyGateInput {
  workspaceId: string;
  /** P11 authoritative validation result. */
  validation: ValidationResult;
  /** P13 authoritative recovery verification result. */
  recoveryVerification: RecoveryVerificationResult;
  /** P14 authoritative unexpected-change detection result. */
  unexpectedChanges: UnexpectedChangeDetectionResult;
  /** P15 authoritative security scan result. */
  security: SecurityScanResult;
  /** Optional: P8 migration plan (for context/evidence traceability). */
  migrationPlan?: MigrationPlan;
}
