/**
 * Unexpected Change Detection error classes (P14).
 */

import { DriftZeroError } from "@driftzero/shared";

/** Thrown when the workspace is not accessible for change detection. */
export class UnexpectedChangeWorkspaceError extends DriftZeroError {
  constructor(message: string) {
    super(message, 409, "UNEXPECTED_CHANGE_WORKSPACE_ERROR");
    this.name = "UnexpectedChangeWorkspaceError";
  }
}

/** Thrown when git status cannot be obtained. */
export class UnexpectedChangeGitError extends DriftZeroError {
  constructor(message: string) {
    super(message, 500, "UNEXPECTED_CHANGE_GIT_ERROR");
    this.name = "UnexpectedChangeGitError";
  }
}
