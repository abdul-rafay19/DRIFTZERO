/**
 * Code Migration Agent — P9-specific error classes.
 *
 * All extend DriftZeroError so the centralized error handler works uniformly.
 */

import { DriftZeroError } from "@driftzero/shared";

/**
 * Generic agent-level failure (e.g. invalid workspace, plan integrity).
 */
export class MigrationAgentError extends DriftZeroError {
  constructor(message: string) {
    super(message, 500, "MIGRATION_AGENT_ERROR");
    this.name = "MigrationAgentError";
  }
}

/**
 * Thrown when Bob's response cannot be parsed or fails the ProposedMigrationChange schema.
 */
export class MigrationResponseParseError extends DriftZeroError {
  constructor(message: string) {
    super(message, 502, "MIGRATION_RESPONSE_PARSE_ERROR");
    this.name = "MigrationResponseParseError";
  }
}

/**
 * Thrown when a proposed change fails structural validation
 * (e.g. invalid operation type, missing required field).
 */
export class MigrationChangeValidationError extends DriftZeroError {
  constructor(message: string) {
    super(message, 422, "MIGRATION_CHANGE_VALIDATION_ERROR");
    this.name = "MigrationChangeValidationError";
  }
}

/**
 * Thrown when Bob proposes modifying a file not authorized by the current migration step.
 */
export class MigrationUnauthorizedFileError extends DriftZeroError {
  constructor(filePath: string, stepId: string) {
    super(
      `File "${filePath}" is not authorized for modification by step ${stepId}`,
      403,
      "MIGRATION_UNAUTHORIZED_FILE"
    );
    this.name = "MigrationUnauthorizedFileError";
  }
}

/**
 * Thrown when the current file content does not match Bob's expectedContent.
 * Prevents silently overwriting unexpected repository state.
 */
export class MigrationExpectedStateMismatchError extends DriftZeroError {
  constructor(filePath: string, stepId: string) {
    super(
      `File "${filePath}" does not match the expected state for step ${stepId}. Refusing to overwrite.`,
      409,
      "MIGRATION_EXPECTED_STATE_MISMATCH"
    );
    this.name = "MigrationExpectedStateMismatchError";
  }
}

/**
 * Thrown when a migration step cannot be applied and execution must stop.
 */
export class MigrationStepExecutionError extends DriftZeroError {
  public readonly stepId: string;
  constructor(stepId: string, message: string) {
    super(`Step ${stepId} failed: ${message}`, 500, "MIGRATION_STEP_EXECUTION_ERROR");
    this.name = "MigrationStepExecutionError";
    this.stepId = stepId;
  }
}
