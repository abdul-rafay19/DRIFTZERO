/**
 * Controlled file utilities for the DriftZero workspace.
 *
 * Security rule: every path operation must be resolved against the workspace
 * root and validated to stay inside it. Path traversal (e.g. "../../etc/passwd")
 * is rejected before any I/O is performed.
 */

import { readFile, writeFile, readdir, access, stat } from "fs/promises";
import { constants as fsConstants } from "fs";
import { resolve, join, relative, normalize } from "path";
import { PathTraversalError, WorkspaceFileNotFoundError } from "./workspace-errors.js";

/** An entry returned by listFiles. */
export interface FileEntry {
  name: string;
  relativePath: string;
  isDirectory: boolean;
  sizeBytes: number;
}

/**
 * Resolve a user-supplied relative path against the workspace root,
 * returning the absolute path only if it stays inside root.
 *
 * @throws {PathTraversalError} if the resolved path escapes root
 */
export function safeResolvePath(root: string, userPath: string): string {
  const normalizedRoot = resolve(root);

  // Reject absolute user paths outright — they can only refer to system paths
  if (normalize(userPath).startsWith("/")) {
    throw new PathTraversalError(userPath);
  }

  // Join and fully resolve against the root
  const resolved = resolve(join(normalizedRoot, userPath));

  // relative() will start with ".." if resolved escapes normalizedRoot
  const rel = relative(normalizedRoot, resolved);
  if (rel.startsWith("..")) {
    throw new PathTraversalError(userPath);
  }

  return resolved;
}

/**
 * Read a text file inside the workspace.
 *
 * @throws {PathTraversalError}           path escapes workspace root
 * @throws {WorkspaceFileNotFoundError}   file does not exist
 */
export async function readWorkspaceFile(root: string, filePath: string): Promise<string> {
  const safe = safeResolvePath(root, filePath);

  try {
    await access(safe, fsConstants.R_OK);
  } catch {
    throw new WorkspaceFileNotFoundError(filePath);
  }

  return readFile(safe, "utf8");
}

/**
 * Write a text file inside the workspace.
 * Creates intermediate directories if they don't exist.
 *
 * @throws {PathTraversalError}  path escapes workspace root
 */
export async function writeWorkspaceFile(
  root: string,
  filePath: string,
  content: string
): Promise<void> {
  const safe = safeResolvePath(root, filePath);
  const { mkdir } = await import("fs/promises");
  const { dirname } = await import("path");
  await mkdir(dirname(safe), { recursive: true });
  await writeFile(safe, content, "utf8");
}

/**
 * Check whether a path exists inside the workspace.
 *
 * @throws {PathTraversalError}  path escapes workspace root
 */
export async function workspacePathExists(root: string, filePath: string): Promise<boolean> {
  const safe = safeResolvePath(root, filePath);
  try {
    await access(safe);
    return true;
  } catch {
    return false;
  }
}

/**
 * List files in a directory inside the workspace (one level deep).
 *
 * @throws {PathTraversalError}           directory escapes workspace root
 * @throws {WorkspaceFileNotFoundError}   directory does not exist
 */
export async function listWorkspaceFiles(root: string, dirPath: string): Promise<FileEntry[]> {
  const safe = safeResolvePath(root, dirPath);

  try {
    await access(safe, fsConstants.R_OK);
  } catch {
    throw new WorkspaceFileNotFoundError(dirPath);
  }

  const entries = await readdir(safe, { withFileTypes: true });

  const result: FileEntry[] = await Promise.all(
    entries.map(async (entry) => {
      const full = join(safe, entry.name);
      let sizeBytes = 0;
      try {
        const s = await stat(full);
        sizeBytes = s.size;
      } catch {
        // ignore stat errors for individual files
      }
      return {
        name: entry.name,
        relativePath: join(dirPath, entry.name),
        isDirectory: entry.isDirectory(),
        sizeBytes,
      };
    })
  );

  return result;
}
