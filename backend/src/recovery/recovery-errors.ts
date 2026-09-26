/**
 * Autonomous Recovery Engine error classes (P12).
 * All extend DriftZeroError so the centralized error handler works uniformly.
 */

import { DriftZeroError } from "@driftzero/shared";

/** Generic recovery engine failure. */
export class RecoveryEngineError extends DriftZeroError {
  constructor(message: string) {
    super(message, 500, "RECOVERY_ENGINE_ERROR");
    this.name = "RecoveryEngineError";
  }
}

/**
 * Thrown when the workspace is not in a valid state for recovery.
 * (workspace.status !== "READY")
 */
export class RecoveryWorkspaceError extends DriftZeroError {
  constructor(message: string) {
    super(message, 409, "RECOVERY_WORKSPACE_ERROR");
    this.name = "RecoveryWorkspaceError";
  }
}

/**
 * Thrown when Bob's response cannot be parsed or does not match
 * the ProposedRecovery schema.
 */
export class RecoveryParseError extends DriftZeroError {
  constructor(message: string) {
    super(message, 502, "RECOVERY_PARSE_ERROR");
    this.name = "RecoveryParseError";
  }
}

/**
 * Thrown (internally) when a proposed repair file is not authorized
 * by the current migration scope.
 */
export class RecoveryUnauthorizedFileError extends DriftZeroError {
  constructor(filePath: string) {
    super(
      `File "${filePath}" is not within the authorized migration scope for recovery`,
      403,
      "RECOVERY_UNAUTHORIZED_FILE"
    );
    this.name = "RecoveryUnauthorizedFileError";
  }
}

/**
 * Thrown (internally) when a MODIFY's expectedContent does not match
 * the current disk content.
 */
export class RecoveryExpectedStateMismatchError extends DriftZeroError {
  constructor(filePath: string) {
    super(
      `File "${filePath}" does not match the expected state. Refusing to overwrite.`,
      409,
      "RECOVERY_EXPECTED_STATE_MISMATCH"
    );
    this.name = "RecoveryExpectedStateMismatchError";
  }
}

/**
 * Thrown (internally) when a proposal exceeds the per-attempt file scope limit.
 */
export class RecoveryScopeExceededError extends DriftZeroError {
  constructor(proposed: number, limit: number) {
    super(
      `Recovery proposal contains ${proposed} file changes, which exceeds the per-attempt limit of ${limit}`,
      422,
      "RECOVERY_SCOPE_EXCEEDED"
    );
    this.name = "RecoveryScopeExceededError";
  }
}

/**
 * Thrown (internally) when a recovery proposal is identical to a previous
 * attempt — duplicate repairs are rejected to preserve recovery budget.
 */
export class RecoveryDuplicateRepairError extends DriftZeroError {
  constructor(attempt: number) {
    super(
      `Recovery proposal for attempt ${attempt} is identical to a previous attempt — rejecting duplicate`,
      422,
      "RECOVERY_DUPLICATE_REPAIR"
    );
    this.name = "RecoveryDuplicateRepairError";
  }
}
