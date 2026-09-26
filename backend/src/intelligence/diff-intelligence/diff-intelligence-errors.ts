/**
 * P17 Diff Intelligence — error classes.
 */

import { DriftZeroError } from "@driftzero/shared";

/** Input Zod validation failure. */
export class DiffInputError extends DriftZeroError {
  constructor(message: string) {
    super(message, 400, "DIFF_INPUT_ERROR");
    this.name = "DiffInputError";
  }
}

/** Workspace not available or not in expected state. */
export class DiffWorkspaceError extends DriftZeroError {
  constructor(message: string) {
    super(message, 422, "DIFF_WORKSPACE_ERROR");
    this.name = "DiffWorkspaceError";
  }
}

/** Git diff could not be retrieved — distinct from an empty diff. */
export class DiffRetrievalError extends DriftZeroError {
  constructor(message: string) {
    super(message, 500, "DIFF_RETRIEVAL_ERROR");
    this.name = "DiffRetrievalError";
  }
}

/** Diff output was malformed beyond recovery. */
export class DiffParseError extends DriftZeroError {
  constructor(message: string) {
    super(message, 500, "DIFF_PARSE_ERROR");
    this.name = "DiffParseError";
  }
}

/** General diff intelligence infrastructure error. */
export class DiffIntelligenceError extends DriftZeroError {
  constructor(message: string) {
    super(message, 500, "DIFF_INTELLIGENCE_ERROR");
    this.name = "DiffIntelligenceError";
  }
}
