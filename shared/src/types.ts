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
