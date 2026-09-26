/**
 * File operation tests (read/write/list/exists).
 * Uses the real filesystem with temp directories.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { join, resolve as resolvePath } from "path";
import { tmpdir } from "os";
import {
  readWorkspaceFile,
  writeWorkspaceFile,
  workspacePathExists,
  listWorkspaceFiles,
} from "../workspace/files.js";
import { PathTraversalError, WorkspaceFileNotFoundError } from "../workspace/workspace-errors.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dz-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe("writeWorkspaceFile / readWorkspaceFile", () => {
  it("writes and reads back a file", async () => {
    await writeWorkspaceFile(root, "hello.txt", "Hello, DriftZero!");
    const content = await readWorkspaceFile(root, "hello.txt");
    expect(content).toBe("Hello, DriftZero!");
  });

  it("creates intermediate directories when writing", async () => {
    await writeWorkspaceFile(root, "deep/nested/file.ts", "export {};\n");
    const content = await readWorkspaceFile(root, "deep/nested/file.ts");
    expect(content).toBe("export {};\n");
  });

  it("throws WorkspaceFileNotFoundError for missing file", async () => {
    await expect(readWorkspaceFile(root, "nonexistent.txt")).rejects.toThrow(
      WorkspaceFileNotFoundError
    );
  });

  it("throws PathTraversalError when writing outside root", async () => {
    await expect(writeWorkspaceFile(root, "../escape.txt", "bad")).rejects.toThrow(
      PathTraversalError
    );
  });

  it("throws PathTraversalError when reading outside root", async () => {
    await expect(readWorkspaceFile(root, "../../etc/passwd")).rejects.toThrow(
      PathTraversalError
    );
  });
});

describe("workspacePathExists", () => {
  it("returns true for an existing file", async () => {
    await writeWorkspaceFile(root, "exists.txt", "yes");
    expect(await workspacePathExists(root, "exists.txt")).toBe(true);
  });

  it("returns false for a missing file", async () => {
    expect(await workspacePathExists(root, "missing.txt")).toBe(false);
  });

  it("throws PathTraversalError for paths outside root", async () => {
    await expect(workspacePathExists(root, "../../../etc")).rejects.toThrow(PathTraversalError);
  });
});

describe("listWorkspaceFiles", () => {
  it("lists files in a directory", async () => {
    await writeWorkspaceFile(root, "a.ts", "");
    await writeWorkspaceFile(root, "b.ts", "");
    const entries = await listWorkspaceFiles(root, ".");
    const names = entries.map((e) => e.name).sort();
    expect(names).toContain("a.ts");
    expect(names).toContain("b.ts");
  });

  it("distinguishes directories from files", async () => {
    await mkdir(join(root, "subdir"));
    await writeWorkspaceFile(root, "file.ts", "");
    const entries = await listWorkspaceFiles(root, ".");
    const dir = entries.find((e) => e.name === "subdir");
    const file = entries.find((e) => e.name === "file.ts");
    expect(dir?.isDirectory).toBe(true);
    expect(file?.isDirectory).toBe(false);
  });

  it("throws WorkspaceFileNotFoundError for missing directory", async () => {
    await expect(listWorkspaceFiles(root, "nonexistent")).rejects.toThrow(
      WorkspaceFileNotFoundError
    );
  });

  it("throws PathTraversalError for directory outside root", async () => {
    await expect(listWorkspaceFiles(root, "../../etc")).rejects.toThrow(PathTraversalError);
  });
});
