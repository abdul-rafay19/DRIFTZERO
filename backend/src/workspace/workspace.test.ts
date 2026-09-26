/**
 * Workspace creation and cleanup tests.
 * Uses the real filesystem — creates/removes actual temp directories.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, access, rm, mkdir } from "fs/promises";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { createWorkspace, cleanupWorkspace, getWorkspaceRoot } from "../workspace/cleanup.js";

describe("createWorkspace", () => {
  const createdPaths: string[] = [];

  afterEach(async () => {
    for (const p of createdPaths) {
      await rm(p, { recursive: true, force: true }).catch(() => undefined);
    }
    createdPaths.length = 0;
  });

  it("creates a unique workspace directory", async () => {
    const ws = await createWorkspace("https://github.com/example/repo");
    createdPaths.push(ws.path);

    expect(ws.id).toMatch(/^ws_[a-f0-9]{12}$/);
    expect(ws.repoUrl).toBe("https://github.com/example/repo");
    expect(ws.status).toBe("CREATING");
    expect(ws.branch).toBeNull();
    expect(ws.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Verify the directory actually exists
    await expect(access(ws.path)).resolves.toBeUndefined();
  });

  it("creates unique paths for concurrent workspaces", async () => {
    const [a, b] = await Promise.all([
      createWorkspace("https://github.com/example/a"),
      createWorkspace("https://github.com/example/b"),
    ]);
    createdPaths.push(a.path, b.path);

    expect(a.path).not.toBe(b.path);
    expect(a.id).not.toBe(b.id);
  });

  it("workspace path is inside WORKSPACE_ROOT", async () => {
    const ws = await createWorkspace("https://github.com/example/repo");
    createdPaths.push(ws.path);

    const root = getWorkspaceRoot();
    expect(resolve(ws.path).startsWith(resolve(root))).toBe(true);
  });

  it("workspace path is never the application source directory", async () => {
    const ws = await createWorkspace("https://github.com/example/repo");
    createdPaths.push(ws.path);

    // Application source is the cwd when running tests
    expect(ws.path.startsWith(process.cwd())).toBe(false);
  });
});

describe("cleanupWorkspace", () => {
  it("removes an existing workspace directory", async () => {
    const ws = await createWorkspace("https://github.com/example/repo");
    await expect(access(ws.path)).resolves.toBeUndefined();

    const result = await cleanupWorkspace(ws);
    expect(result.success).toBe(true);
    expect(result.alreadyCleaned).toBe(false);

    // Directory should be gone
    await expect(access(ws.path)).rejects.toThrow();
  });

  it("handles already-cleaned workspace gracefully", async () => {
    const ws = await createWorkspace("https://github.com/example/repo");
    // Clean once
    await cleanupWorkspace(ws);
    // Clean again — must not throw
    const result = await cleanupWorkspace(ws);
    expect(result.success).toBe(true);
    expect(result.alreadyCleaned).toBe(true);
  });

  it("rejects cleanup of a path outside WORKSPACE_ROOT", async () => {
    const fakeWs = {
      id: "ws_test",
      repoUrl: "https://example.com",
      path: "/etc",
      branch: null,
      createdAt: new Date().toISOString(),
      status: "READY" as const,
    };
    const result = await cleanupWorkspace(fakeWs);
    expect(result.success).toBe(false);
    expect(result.error).toContain("not inside WORKSPACE_ROOT");
  });

  it("rejects cleanup of a relative path", async () => {
    const fakeWs = {
      id: "ws_test",
      repoUrl: "https://example.com",
      path: "relative/path",
      branch: null,
      createdAt: new Date().toISOString(),
      status: "READY" as const,
    };
    const result = await cleanupWorkspace(fakeWs);
    expect(result.success).toBe(false);
    expect(result.error).toContain("not absolute");
  });

  it("rejects cleanup of the WORKSPACE_ROOT itself", async () => {
    const root = getWorkspaceRoot();
    const fakeWs = {
      id: "ws_root",
      repoUrl: "https://example.com",
      path: root,
      branch: null,
      createdAt: new Date().toISOString(),
      status: "READY" as const,
    };
    const result = await cleanupWorkspace(fakeWs);
    expect(result.success).toBe(false);
    expect(result.error).toContain("not inside WORKSPACE_ROOT");
  });
});
