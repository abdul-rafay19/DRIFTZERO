/**
 * P16 Safety Gate error classes.
 * All extend DriftZeroError for uniform centralized handling.
 */

import { DriftZeroError } from "@driftzero/shared";

/**
 * Thrown when the safety gate input fails Zod validation.
 */
export class SafetyGateInputError extends DriftZeroError {
  constructor(message: string) {
    super(message, 400, "SAFETY_GATE_INPUT_ERROR");
    this.name = "SafetyGateInputError";
  }
}

/**
 * Thrown when the safety gate detects internally contradictory evidence
 * that cannot be resolved (infrastructure error, not a migration safety issue).
 */
export class SafetyEvidenceError extends DriftZeroError {
  constructor(message: string) {
    super(message, 422, "SAFETY_EVIDENCE_ERROR");
    this.name = "SafetyEvidenceError";
  }
}

/**
 * General safety gate infrastructure error.
 */
export class SafetyGateError extends DriftZeroError {
  constructor(message: string) {
    super(message, 500, "SAFETY_GATE_ERROR");
    this.name = "SafetyGateError";
  }
}
