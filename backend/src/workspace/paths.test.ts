/**
 * Path safety (safeResolvePath) tests.
 * These use no filesystem I/O — purely path math.
 */
import { describe, it, expect } from "vitest";
import { safeResolvePath } from "../workspace/files.js";
import { PathTraversalError } from "../workspace/workspace-errors.js";
import { resolve } from "path";

const ROOT = "/tmp/driftzero-workspaces/ws_test000001";

describe("safeResolvePath", () => {
  it("accepts a simple relative path inside root", () => {
    const result = safeResolvePath(ROOT, "package.json");
    expect(result).toBe(resolve(ROOT, "package.json"));
  });

  it("accepts a nested relative path inside root", () => {
    const result = safeResolvePath(ROOT, "src/index.ts");
    expect(result).toBe(resolve(ROOT, "src/index.ts"));
  });

  it("accepts the root itself via '.'", () => {
    const result = safeResolvePath(ROOT, ".");
    expect(result).toBe(resolve(ROOT));
  });

  it("rejects single ../ traversal", () => {
    expect(() => safeResolvePath(ROOT, "../secret")).toThrow(PathTraversalError);
  });

  it("rejects deep traversal to /etc/passwd", () => {
    expect(() => safeResolvePath(ROOT, "../../../etc/passwd")).toThrow(PathTraversalError);
  });

  it("rejects absolute path escaping root", () => {
    expect(() => safeResolvePath(ROOT, "/etc/passwd")).toThrow(PathTraversalError);
  });

  it("rejects traversal hidden in nested path", () => {
    expect(() => safeResolvePath(ROOT, "src/../../outside")).toThrow(PathTraversalError);
  });
});
