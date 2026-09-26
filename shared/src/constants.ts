// Shared constants for DriftZero

export const APP_NAME = "DriftZero" as const;

export const APP_VERSION = "0.1.0" as const;

export const SUPPORTED_MIGRATIONS = [
  {
    source: "express@4",
    target: "express@5",
  },
] as const;

export const MAX_RECOVERY_ATTEMPTS = 3;

/** Timeout for IBM Bob LLM calls (Phase 2+) */
export const LLM_TIMEOUT_MS = 30_000;

/** Timeout for shell command execution (Phase 2+) */
export const COMMAND_TIMEOUT_MS = 120_000;
