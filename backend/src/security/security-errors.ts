/**
 * P15 Security Engine error classes.
 * All extend DriftZeroError for uniform centralized handling.
 */

import { DriftZeroError } from "@driftzero/shared";

/**
 * Thrown when the security scan input fails Zod validation.
 * Re-exports as SecurityValidationError to avoid collision with shared ValidationError.
 */
export class SecurityValidationError extends DriftZeroError {
  constructor(message: string) {
    super(message, 400, "SECURITY_VALIDATION_ERROR");
    this.name = "SecurityValidationError";
  }
}

/**
 * Thrown when the workspace is not in a state that allows security scanning.
 */
export class SecurityWorkspaceError extends DriftZeroError {
  constructor(message: string) {
    super(message, 422, "SECURITY_WORKSPACE_ERROR");
    this.name = "SecurityWorkspaceError";
  }
}

/**
 * Thrown when the secret scanner itself encounters an unrecoverable error.
 * Normal scan failures produce findings; this is for infrastructure errors.
 */
export class SecretScannerError extends DriftZeroError {
  constructor(message: string) {
    super(message, 500, "SECRET_SCANNER_ERROR");
    this.name = "SecretScannerError";
  }
}

/**
 * Thrown when the dependency audit produces output that cannot be parsed.
 * Malformed individual entries are skipped; this is for total parse failure.
 */
export class DependencyAuditError extends DriftZeroError {
  constructor(message: string) {
    super(message, 500, "DEPENDENCY_AUDIT_ERROR");
    this.name = "DependencyAuditError";
  }
}

/**
 * Thrown when Bob's security review output cannot be parsed or validated.
 * Does NOT prevent deterministic findings from being returned.
 */
export class SecurityReviewParseError extends DriftZeroError {
  constructor(message: string) {
    super(message, 500, "SECURITY_REVIEW_PARSE_ERROR");
    this.name = "SecurityReviewParseError";
  }
}
