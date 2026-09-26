/**
 * Workspace lifecycle: creation and cleanup.
 *
 * Security rules:
 *  - Workspaces are always created inside WORKSPACE_ROOT (never the app source tree).
 *  - Cleanup validates the target path before any deletion.
 *  - Arbitrary paths cannot be passed to recursive delete.
 */

import { mkdtemp, rm, access } from "fs/promises";
import { join, resolve, relative } from "path";
import { tmpdir } from "os";
import { v4 as uuidv4 } from "uuid";
import type { Workspace, CleanupResult } from "@driftzero/shared";
import { logger } from "../utils/logger.js";
import { WorkspaceCreationError, CleanupError } from "./workspace-errors.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Root directory under which all workspaces are created.
 * Configurable via WORKSPACE_ROOT env var; defaults to os.tmpdir()/driftzero-workspaces.
 * Never set to the application source directory.
 */
export function getWorkspaceRoot(): string {
  const envRoot = process.env["WORKSPACE_ROOT"];
  if (envRoot) {
    return resolve(envRoot);
  }
  return join(tmpdir(), "driftzero-workspaces");
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a new isolated temporary workspace directory.
 *
 * The directory is created as:
 *   <WORKSPACE_ROOT>/ws_<uuid>-XXXXXX
 *
 * @param repoUrl - Repository URL that will be cloned into this workspace
 * @throws {WorkspaceCreationError} if directory creation fails
 */
export async function createWorkspace(repoUrl: string): Promise<Workspace> {
  const root = getWorkspaceRoot();
  const id = `ws_${uuidv4().replace(/-/g, "").slice(0, 12)}`;

  let workspacePath: string;
  try {
    // mkdtemp adds a random suffix after the prefix
    workspacePath = await mkdtemp(join(root, `${id}-`));
  } catch (err) {
    // Root dir may not exist yet — create it and retry once
    try {
      const { mkdir } = await import("fs/promises");
      await mkdir(root, { recursive: true });
      workspacePath = await mkdtemp(join(root, `${id}-`));
    } catch (retryErr) {
      logger.error("Workspace creation failed", {
        id,
        error: (retryErr as Error).message,
      });
      throw new WorkspaceCreationError(
        `Failed to create workspace directory: ${(retryErr as Error).message}`
      );
    }
  }

  logger.info("Workspace created", { id, path: workspacePath });

  return {
    id,
    repoUrl,
    path: workspacePath,
    branch: null,
    createdAt: new Date().toISOString(),
    status: "CREATING",
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Recursively remove a workspace directory.
 *
 * Safety checks:
 *  1. The path must be an absolute path.
 *  2. The path must sit inside WORKSPACE_ROOT.
 *  3. The path must not be the workspace root itself.
 *
 * Returns a structured result; never throws (callers should log the result).
 */
export async function cleanupWorkspace(workspace: Workspace): Promise<CleanupResult> {
  const { id, path: workspacePath } = workspace;
  const root = getWorkspaceRoot();

  logger.info("Workspace cleanup started", { id, path: workspacePath });

  // --- Safety check 1: must be an absolute path
  const absPath = resolve(workspacePath);
  if (absPath !== workspacePath) {
    const msg = "Cleanup rejected: path is not absolute";
    logger.error(msg, { id, path: workspacePath });
    return { workspaceId: id, path: workspacePath, success: false, alreadyCleaned: false, error: msg };
  }

  // --- Safety check 2: must be inside WORKSPACE_ROOT
  const rel = relative(root, absPath);
  if (rel.startsWith("..") || rel === "") {
    const msg = "Cleanup rejected: path is not inside WORKSPACE_ROOT";
    logger.error(msg, { id, path: workspacePath, root });
    return { workspaceId: id, path: workspacePath, success: false, alreadyCleaned: false, error: msg };
  }

  // --- Check if already cleaned
  try {
    await access(absPath);
  } catch {
    logger.info("Workspace already cleaned (directory not found)", { id, path: workspacePath });
    return { workspaceId: id, path: workspacePath, success: true, alreadyCleaned: true };
  }

  // --- Remove
  try {
    await rm(absPath, { recursive: true, force: true });
    logger.info("Workspace cleanup completed", { id, path: workspacePath });
    return { workspaceId: id, path: workspacePath, success: true, alreadyCleaned: false };
  } catch (err) {
    const msg = `Cleanup failed: ${(err as Error).message}`;
    logger.error("Workspace cleanup failed", { id, path: workspacePath, error: (err as Error).message });
    return { workspaceId: id, path: workspacePath, success: false, alreadyCleaned: false, error: msg };
  }
}
