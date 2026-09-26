/**
 * Git operations for the DriftZero workspace layer.
 *
 * Only the Git operations needed for workspace setup and inspection
 * are implemented here. No PR creation, push automation, or commit
 * automation — those belong to later phases.
 */

import { join } from "path";
import { runCommand, runCommandOrThrow } from "./commands.js";
import type { CommandResult } from "@driftzero/shared";
import { COMMAND_TIMEOUT_MS } from "@driftzero/shared";
import { logger } from "../utils/logger.js";
import { CloneError } from "./workspace-errors.js";

/** Options for cloning a repository. */
export interface CloneOptions {
  /** Repository URL or local path to clone. */
  repoUrl: string;
  /** Absolute destination directory inside the workspace. */
  destPath: string;
  /** Optional branch to clone. */
  branch?: string;
  /** Override the default command timeout. */
  timeoutMs?: number;
}

/** Structured clone result. */
export interface CloneResult {
  success: boolean;
  repoPath: string;
  commandResult: CommandResult;
}

/**
 * Clone a repository into destPath.
 *
 * Uses `git clone --depth 1` for speed; passes branch via -b if provided.
 * destPath is the parent directory — the cloned repo lands in destPath/repo.
 *
 * @throws {CloneError} if git exits non-zero or times out
 */
export async function cloneRepository(options: CloneOptions): Promise<CloneResult> {
  const { repoUrl, destPath, branch, timeoutMs = COMMAND_TIMEOUT_MS } = options;

  const repoPath = join(destPath, "repo");

  const args = ["clone", "--depth", "1"];
  if (branch) {
    args.push("-b", branch);
  }
  args.push("--", repoUrl, repoPath);

  logger.info("Git clone started", { repoUrl, destPath: repoPath });

  const result = await runCommand("git", args, destPath, timeoutMs);

  if (result.timedOut) {
    logger.error("Git clone timed out", { repoUrl, timeoutMs });
    throw new CloneError(`git clone timed out after ${timeoutMs}ms`);
  }

  if (result.exitCode !== 0) {
    logger.error("Git clone failed", { repoUrl, exitCode: result.exitCode });
    throw new CloneError(
      `git clone failed (exit ${result.exitCode}): ${result.stderr.slice(0, 300)}`
    );
  }

  logger.info("Git clone completed", { repoUrl, durationMs: result.durationMs });

  return { success: true, repoPath, commandResult: result };
}

/**
 * Return the current git status of a cloned repository.
 * Returns the raw `git status --short` output.
 */
export async function gitStatus(repoPath: string): Promise<string> {
  return runCommandOrThrow("git", ["status", "--short"], repoPath);
}

/**
 * Return the name of the current branch in a cloned repository.
 */
export async function gitCurrentBranch(repoPath: string): Promise<string> {
  const branch = await runCommandOrThrow(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    repoPath
  );
  return branch.trim();
}

/**
 * Return a unified diff between the working tree and HEAD.
 * Pass a specific file path to limit the diff scope.
 */
export async function gitDiff(repoPath: string, filePath?: string): Promise<string> {
  const args = ["diff"];
  if (filePath) {
    args.push("--", filePath);
  }
  return runCommandOrThrow("git", args, repoPath);
}

/**
 * Checkout an existing branch or create a new one.
 *
 * @param repoPath  - Absolute path to the cloned repo
 * @param branch    - Branch name
 * @param create    - When true, passes -b to create the branch
 */
export async function gitCheckout(
  repoPath: string,
  branch: string,
  create = false
): Promise<CommandResult> {
  const args = create
    ? ["checkout", "-b", branch]
    : ["checkout", branch];
  return runCommand("git", args, repoPath);
}
