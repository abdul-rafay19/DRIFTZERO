/**
 * Git clone tests.
 *
 * Integration clone tests require network access and a real git binary.
 * We test with a local bare git repo to avoid network dependencies.
 * Clone-failure and timeout paths are also covered.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { runCommand } from "../workspace/commands.js";
import { cloneRepository, gitStatus, gitCurrentBranch } from "../workspace/clone.js";
import { CloneError } from "../workspace/workspace-errors.js";

let testRoot: string;

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "dz-clone-test-"));
});

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true }).catch(() => undefined);
});

/**
 * Creates a minimal local bare git repository for testing.
 * Returns the path to the bare repo (usable as a clone URL).
 */
async function createLocalRepo(parentDir: string): Promise<string> {
  const repoPath = join(parentDir, "source-repo");
  await mkdir(repoPath, { recursive: true });

  // Initialize repo
  await runCommand("git", ["init"], repoPath);
  await runCommand("git", ["config", "user.email", "test@driftzero.test"], repoPath);
  await runCommand("git", ["config", "user.name", "DriftZero Test"], repoPath);

  // Create an initial commit
  await writeFile(join(repoPath, "README.md"), "# Test Repo\n", "utf8");
  await runCommand("git", ["add", "."], repoPath);
  await runCommand("git", ["commit", "-m", "Initial commit"], repoPath);

  return repoPath;
}

describe("cloneRepository", () => {
  it("clones a local repository into the workspace", async () => {
    const sourceRepo = await createLocalRepo(testRoot);
    const destPath = join(testRoot, "workspace");
    await mkdir(destPath, { recursive: true });

    const result = await cloneRepository({
      repoUrl: sourceRepo,
      destPath,
    });

    expect(result.success).toBe(true);
    expect(result.repoPath).toContain("repo");
    expect(result.commandResult.exitCode).toBe(0);
    expect(result.commandResult.timedOut).toBe(false);

    // The cloned directory should exist
    const { access } = await import("fs/promises");
    await expect(access(result.repoPath)).resolves.toBeUndefined();
  });

  it("throws CloneError for an invalid repository URL", async () => {
    const destPath = join(testRoot, "workspace");
    await mkdir(destPath, { recursive: true });

    await expect(
      cloneRepository({
        repoUrl: "/nonexistent/path/to/repo",
        destPath,
      })
    ).rejects.toThrow(CloneError);
  });

  it("throws CloneError when timeout is exceeded", async () => {
    const destPath = join(testRoot, "workspace");
    await mkdir(destPath, { recursive: true });

    // 1ms timeout will always fire
    await expect(
      cloneRepository({
        repoUrl: "https://github.com/example/repo",
        destPath,
        timeoutMs: 1,
      })
    ).rejects.toThrow(CloneError);
  });
});

describe("gitStatus", () => {
  it("returns status output for a clean repo", async () => {
    const sourceRepo = await createLocalRepo(testRoot);
    const destPath = join(testRoot, "workspace");
    await mkdir(destPath, { recursive: true });

    const { repoPath } = await cloneRepository({ repoUrl: sourceRepo, destPath });

    const status = await gitStatus(repoPath);
    // clean repo should return empty string or whitespace
    expect(typeof status).toBe("string");
  });
});

describe("gitCurrentBranch", () => {
  it("returns a branch name string", async () => {
    const sourceRepo = await createLocalRepo(testRoot);
    const destPath = join(testRoot, "workspace");
    await mkdir(destPath, { recursive: true });

    const { repoPath } = await cloneRepository({ repoUrl: sourceRepo, destPath });

    const branch = await gitCurrentBranch(repoPath);
    expect(typeof branch).toBe("string");
    expect(branch.length).toBeGreaterThan(0);
  });
});
