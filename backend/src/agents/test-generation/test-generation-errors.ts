/**
 * Test Generation Agent — P10-specific error classes.
 *
 * All extend DriftZeroError so the centralized error handler works uniformly.
 * Error names mirror the P9 pattern for consistency.
 */

import { DriftZeroError } from "@driftzero/shared";

/** Generic agent-level failure (invalid workspace, plan integrity, etc.). */
export class TestGenerationError extends DriftZeroError {
  constructor(message: string) {
    super(message, 500, "TEST_GENERATION_ERROR");
    this.name = "TestGenerationError";
  }
}

/** Bob's response cannot be parsed or fails the ProposedTestChange schema. */
export class TestGenerationParseError extends DriftZeroError {
  constructor(message: string) {
    super(message, 502, "TEST_GENERATION_PARSE_ERROR");
    this.name = "TestGenerationParseError";
  }
}

/** A proposed test change fails structural validation. */
export class TestChangeValidationError extends DriftZeroError {
  constructor(message: string) {
    super(message, 422, "TEST_CHANGE_VALIDATION_ERROR");
    this.name = "TestChangeValidationError";
  }
}

/**
 * Bob proposed a test file that is not authorized for this migration step —
 * either unrelated to the migration, outside test conventions, or a
 * production-code file masquerading as a test.
 */
export class UnauthorizedTestFileError extends DriftZeroError {
  constructor(filePath: string, stepId: string) {
    super(
      `File "${filePath}" is not an authorized test file for step ${stepId}`,
      403,
      "UNAUTHORIZED_TEST_FILE"
    );
    this.name = "UnauthorizedTestFileError";
  }
}

/** Current test file content does not match Bob's expectedContent. */
export class TestExpectedStateMismatchError extends DriftZeroError {
  constructor(filePath: string, stepId: string) {
    super(
      `Test file "${filePath}" does not match the expected state for step ${stepId}. Refusing to overwrite.`,
      409,
      "TEST_EXPECTED_STATE_MISMATCH"
    );
    this.name = "TestExpectedStateMismatchError";
  }
}

/** Applying a test change failed at the filesystem level. */
export class TestChangeApplicationError extends DriftZeroError {
  public readonly stepId: string;
  constructor(stepId: string, message: string) {
    super(`Test step ${stepId} failed: ${message}`, 500, "TEST_CHANGE_APPLICATION_ERROR");
    this.name = "TestChangeApplicationError";
    this.stepId = stepId;
  }
}
