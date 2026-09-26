import { DriftZeroError } from "@driftzero/shared";

/**
 * Workspace-specific error classes.
 * All extend DriftZeroError so the centralized error handler works uniformly.
 */

/** Thrown when a workspace cannot be created on disk. */
export class WorkspaceCreationError extends DriftZeroError {
  constructor(message: string) {
    super(message, 500, "WORKSPACE_CREATION_ERROR");
    this.name = "WorkspaceCreationError";
  }
}

/** Thrown when a repository clone fails or times out. */
export class CloneError extends DriftZeroError {
  constructor(message: string) {
    super(message, 500, "CLONE_ERROR");
    this.name = "CloneError";
  }
}

/** Thrown when a requested command is not on the allowlist. */
export class CommandNotAllowedError extends DriftZeroError {
  constructor(command: string) {
    super(
      `Command "${command}" is not allowed. Only explicitly permitted commands may be executed.`,
      400,
      "COMMAND_NOT_ALLOWED"
    );
    this.name = "CommandNotAllowedError";
  }
}

/** Thrown when a controlled command times out. */
export class CommandTimeoutError extends DriftZeroError {
  constructor(command: string, timeoutMs: number) {
    super(
      `Command "${command}" timed out after ${timeoutMs}ms`,
      504,
      "COMMAND_TIMEOUT"
    );
    this.name = "CommandTimeoutError";
  }
}

/** Thrown when a command exits with a non-zero code and the caller needs a hard failure. */
export class CommandFailedError extends DriftZeroError {
  public readonly exitCode: number;
  constructor(command: string, exitCode: number, stderr: string) {
    super(
      `Command "${command}" exited with code ${exitCode}: ${stderr.slice(0, 200)}`,
      500,
      "COMMAND_FAILED"
    );
    this.name = "CommandFailedError";
    this.exitCode = exitCode;
  }
}

/** Thrown when a path escapes the workspace root boundary. */
export class PathTraversalError extends DriftZeroError {
  constructor(path: string) {
    super(
      `Path "${path}" escapes the workspace root — path traversal is not permitted`,
      400,
      "PATH_TRAVERSAL"
    );
    this.name = "PathTraversalError";
  }
}

/** Thrown when a file or directory inside the workspace is not found. */
export class WorkspaceFileNotFoundError extends DriftZeroError {
  constructor(path: string) {
    super(`File not found in workspace: ${path}`, 404, "WORKSPACE_FILE_NOT_FOUND");
    this.name = "WorkspaceFileNotFoundError";
  }
}

/** Thrown when workspace cleanup fails. */
export class CleanupError extends DriftZeroError {
  constructor(message: string) {
    super(message, 500, "CLEANUP_ERROR");
    this.name = "CleanupError";
  }
}
