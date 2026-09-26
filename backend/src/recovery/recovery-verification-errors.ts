/**
 * Recovery Verification error classes (P13).
 * All extend DriftZeroError so the centralized error handler works uniformly.
 */

import { DriftZeroError } from "@driftzero/shared";

/** Thrown when P13 input fails Zod validation. */
export class RecoveryVerificationInputError extends DriftZeroError {
  constructor(message: string) {
    super(message, 400, "RECOVERY_VERIFICATION_INPUT_ERROR");
    this.name = "RecoveryVerificationInputError";
  }
}

/** Thrown when an internal verification invariant is violated (programming error). */
export class RecoveryVerificationInternalError extends DriftZeroError {
  constructor(message: string) {
    super(message, 500, "RECOVERY_VERIFICATION_INTERNAL_ERROR");
    this.name = "RecoveryVerificationInternalError";
  }
}
