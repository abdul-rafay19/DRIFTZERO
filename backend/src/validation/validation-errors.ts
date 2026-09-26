/**
 * Validation Engine error classes (P11).
 * All extend DriftZeroError so the centralized error handler works uniformly.
 */

import { DriftZeroError } from "@driftzero/shared";

/** Generic validation engine error. */
export class ValidationEngineError extends DriftZeroError {
  constructor(message: string) {
    super(message, 500, "VALIDATION_ENGINE_ERROR");
    this.name = "ValidationEngineError";
  }
}

/**
 * Thrown when the workspace is not in a state suitable for validation.
 * (e.g. workspace.status !== "READY")
 */
export class ValidationWorkspaceError extends DriftZeroError {
  constructor(message: string) {
    super(message, 409, "VALIDATION_WORKSPACE_ERROR");
    this.name = "ValidationWorkspaceError";
  }
}

/**
 * Thrown when package.json cannot be read or parsed.
 * NOT thrown for missing optional scripts — only for unreadable manifests.
 */
export class ValidationManifestError extends DriftZeroError {
  constructor(message: string) {
    super(message, 422, "VALIDATION_MANIFEST_ERROR");
    this.name = "ValidationManifestError";
  }
}
