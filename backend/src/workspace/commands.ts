/**
 * Controlled command runner for DriftZero.
 *
 * Security principles:
 *  - Only explicitly allowed commands may be executed.
 *  - Arguments are passed as an array — never via shell string concatenation.
 *  - Every invocation has a hard timeout.
 *  - stdout/stderr are captured; nothing is echoed to Bob or the frontend.
 *  - IBM Bob must NEVER directly invoke this module; only DRIFTZERO's own
 *    workspace/agent logic may call it.
 */

import { spawn } from "child_process";
import type { CommandResult } from "@driftzero/shared";
import { COMMAND_TIMEOUT_MS } from "@driftzero/shared";
import { logger } from "../utils/logger.js";
import { CommandNotAllowedError, CommandTimeoutError } from "./workspace-errors.js";

// ---------------------------------------------------------------------------
// Allowlist — only these executables may be invoked.
// Extend this list as new phases require it; never add shell interpreters.
// ---------------------------------------------------------------------------
export const ALLOWED_COMMANDS = new Set<string>(["git", "npm", "node"]);

/**
 * Check whether a command is on the allowlist.
 */
export function isCommandAllowed(command: string): boolean {
  return ALLOWED_COMMANDS.has(command);
}

/**
 * Run an allowed command in a controlled subprocess.
 *
 * @param command     - Executable name (e.g. "git")
 * @param args        - Argument array (e.g. ["clone", "--depth", "1", url, dest])
 * @param cwd         - Working directory for the subprocess
 * @param timeoutMs   - Hard kill timeout (defaults to COMMAND_TIMEOUT_MS)
 *
 * @throws {CommandNotAllowedError}  command not on allowlist
 * @throws {CommandTimeoutError}     process killed after timeoutMs
 */
export async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number = COMMAND_TIMEOUT_MS
): Promise<CommandResult> {
  if (!isCommandAllowed(command)) {
    throw new CommandNotAllowedError(command);
  }

  const startTime = Date.now();
  logger.debug("Command started", { command, args, cwd });

  return new Promise<CommandResult>((resolve) => {
    let settled = false;

    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,        // never use shell — prevents injection
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      // Give it a moment, then SIGKILL
      setTimeout(() => child.kill("SIGKILL"), 2000);
      const durationMs = Date.now() - startTime;
      logger.warn("Command timed out", { command, args, durationMs, timeoutMs });
      resolve({
        command,
        args,
        exitCode: -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        durationMs,
        timedOut: true,
      });
    }, timeoutMs);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      logger.error("Command process error", { command, error: (err as Error).message });
      resolve({
        command,
        args,
        exitCode: -1,
        stdout: "",
        stderr: (err as Error).message,
        durationMs,
        timedOut: false,
      });
    });

    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      logger.debug("Command completed", { command, exitCode, durationMs });
      resolve({
        command,
        args,
        exitCode: exitCode ?? -1,
        stdout,
        stderr,
        durationMs,
        timedOut: false,
      });
    });
  });
}

/**
 * Like runCommand, but throws CommandTimeoutError / CommandFailedError
 * when the caller needs a hard failure on bad exit.
 * Returns stdout on success.
 */
export async function runCommandOrThrow(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number = COMMAND_TIMEOUT_MS
): Promise<string> {
  const result = await runCommand(command, args, cwd, timeoutMs);

  if (result.timedOut) {
    throw new CommandTimeoutError(command, timeoutMs);
  }

  // Import here to avoid circular — CommandFailedError is in workspace-errors
  if (result.exitCode !== 0) {
    const { CommandFailedError } = await import("./workspace-errors.js");
    throw new CommandFailedError(command, result.exitCode, result.stderr);
  }

  return result.stdout;
}
