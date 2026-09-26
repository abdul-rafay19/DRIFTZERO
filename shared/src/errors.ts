// Shared error classes for DriftZero

export class DriftZeroError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode = 500, code = "DRIFTZERO_ERROR") {
    super(message);
    this.name = "DriftZeroError";
    this.statusCode = statusCode;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends DriftZeroError {
  constructor(message: string) {
    super(message, 400, "VALIDATION_ERROR");
    this.name = "ValidationError";
  }
}

export class NotFoundError extends DriftZeroError {
  constructor(message: string) {
    super(message, 404, "NOT_FOUND");
    this.name = "NotFoundError";
  }
}

/**
 * Error type for AI provider failures.
 * The sole AI provider for DriftZero is IBM Bob (Phase 2+).
 */
export class ProviderError extends DriftZeroError {
  constructor(message: string) {
    super(message, 502, "PROVIDER_ERROR");
    this.name = "ProviderError";
  }
}
