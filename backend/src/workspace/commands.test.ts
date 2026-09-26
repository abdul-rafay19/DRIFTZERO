/**
 * Command runner tests.
 *
 * Uses real processes for allowed-command and disallowed-command tests.
 * For timeout tests, we use a real sleep-like command with a very short timeout.
 */
import { describe, it, expect } from "vitest";
import { runCommand, isCommandAllowed, ALLOWED_COMMANDS } from "../workspace/commands.js";
import { CommandNotAllowedError } from "../workspace/workspace-errors.js";
import { tmpdir } from "os";

const CWD = tmpdir();

describe("isCommandAllowed", () => {
  it("returns true for allowed commands", () => {
    expect(isCommandAllowed("git")).toBe(true);
    expect(isCommandAllowed("npm")).toBe(true);
    expect(isCommandAllowed("node")).toBe(true);
  });

  it("returns false for disallowed commands", () => {
    expect(isCommandAllowed("bash")).toBe(false);
    expect(isCommandAllowed("sh")).toBe(false);
    expect(isCommandAllowed("curl")).toBe(false);
    expect(isCommandAllowed("wget")).toBe(false);
    expect(isCommandAllowed("rm")).toBe(false);
    expect(isCommandAllowed("cat")).toBe(false);
    expect(isCommandAllowed("python")).toBe(false);
    expect(isCommandAllowed("python3")).toBe(false);
  });
});

describe("runCommand — allowlist enforcement", () => {
  it("throws CommandNotAllowedError for a disallowed command", async () => {
    await expect(runCommand("bash", ["-c", "echo hi"], CWD)).rejects.toThrow(
      CommandNotAllowedError
    );
  });

  it("throws CommandNotAllowedError for curl", async () => {
    await expect(runCommand("curl", ["https://example.com"], CWD)).rejects.toThrow(
      CommandNotAllowedError
    );
  });
});

describe("runCommand — execution", () => {
  it("executes an allowed command and captures stdout", async () => {
    // `git --version` is safe, always available, outputs to stdout
    const result = await runCommand("git", ["--version"], CWD);
    expect(result.command).toBe("git");
    expect(result.args).toEqual(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/git version/);
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("captures stderr and non-zero exit for a bad git subcommand", async () => {
    const result = await runCommand("git", ["this-subcommand-does-not-exist"], CWD);
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
    // git writes usage errors to stderr
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("handles timeout", async () => {
    // Use `git` with a nonsense operation that won't exist; we use a 1ms timeout
    // to guarantee a timeout even if the process fails immediately
    // We need a command that takes time — use node to sleep
    const result = await runCommand("node", ["-e", "setTimeout(()=>{},5000)"], CWD, 50);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(-1);
  }, 10000);
});

describe("runCommand — structured result shape", () => {
  it("result always has all required fields", async () => {
    const result = await runCommand("git", ["--version"], CWD);
    expect(typeof result.command).toBe("string");
    expect(Array.isArray(result.args)).toBe(true);
    expect(typeof result.exitCode).toBe("number");
    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
    expect(typeof result.durationMs).toBe("number");
    expect(typeof result.timedOut).toBe("boolean");
  });
});
