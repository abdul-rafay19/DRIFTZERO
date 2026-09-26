import { DriftZeroError } from "@driftzero/shared";

/**
 * Bob-specific error classes.
 * All map into DriftZeroError so the centralized error handler works uniformly.
 */

/**
 * Thrown when BOB_API_KEY is missing or empty at startup/call time.
 */
export class BobConfigurationError extends DriftZeroError {
  constructor(message: string) {
    super(message, 500, "BOB_CONFIGURATION_ERROR");
    this.name = "BobConfigurationError";
  }
}

/**
 * Thrown when Bob Shell rejects the request due to invalid/expired credentials.
 */
export class BobAuthenticationError extends DriftZeroError {
  constructor(message: string) {
    super(message, 502, "BOB_AUTHENTICATION_ERROR");
    this.name = "BobAuthenticationError";
  }
}

/**
 * Thrown when the Bob Shell process does not respond within the timeout window.
 */
export class BobTimeoutError extends DriftZeroError {
  constructor() {
    super("IBM Bob inference request timed out", 504, "BOB_TIMEOUT");
    this.name = "BobTimeoutError";
  }
}

/**
 * Thrown when Bob Shell exits with a non-zero code or produces an empty/unexpected response.
 */
export class BobInferenceError extends DriftZeroError {
  constructor(message: string) {
    super(message, 502, "BOB_INFERENCE_ERROR");
    this.name = "BobInferenceError";
  }
}
