/**
 * Validation Engine (P11).
 *
 * Objectively evaluates the current state of a migrated workspace by executing
 * the repository's own configured validation commands (dependency install,
 * typecheck, build, test) through the P3 controlled command runner.
 *
 * Core invariants:
 *   - IBM Bob is NEVER called.  Zero LLM calls.
 *   - All command execution goes through P3 runCommand (shell: false, allowlist enforced).
 *   - Output is bounded: stdout/stderr truncated to MAX_OUTPUT_CHARS.
 *   - Validation is purely observational — no code changes, no Git operations.
 *   - PASSED only when all applicable required checks exit with code 0.
 *   - NOT_VALIDATED when no applicable checks could be determined.
 *
 * Execution order (deterministic):
 *   1. DEPENDENCY  — install / verify dependencies
 *   2. TYPECHECK   — TypeScript compilation check
 *   3. BUILD       — project build
 *   4. TEST        — test suite
 *
 * Failure policy:
 *   - DEPENDENCY fail  → TYPECHECK/BUILD/TEST all skipped
 *   - TYPECHECK fail   → BUILD skipped (type-unsafe compilation likely broken)
 *   - BUILD fail       → TEST still executes (test runner may work independently)
 *   - TEST fail        → overall status FAILED, remaining checks still run
 *
 * Does NOT:
 *   - Repair code
 *   - Retry commands
 *   - Call IBM Bob
 *   - Commit / push / create PRs
 *   - Reset or clean the workspace
 */

import { ValidationError } from "@driftzero/shared";
import type {
  ValidationInput,
  ValidationResult,
  ValidationCheckResult,
  ValidationCheckStatus,
  ValidationSummary,
} from "@driftzero/shared";
import { runCommand } from "../workspace/commands.js";
import { readWorkspaceFile, workspacePathExists } from "../workspace/files.js";
import { logger } from "../utils/logger.js";
import {
  ValidationEngineError,
  ValidationWorkspaceError,
  ValidationManifestError,
} from "./validation-errors.js";
import {
  validationInputSchema,
  LOCK_FILE_PRIORITY,
  MAX_OUTPUT_CHARS,
  TRUNCATION_MARKER,
  RECOGNIZED_TYPECHECK_SCRIPTS,
  RECOGNIZED_BUILD_SCRIPTS,
  RECOGNIZED_TEST_SCRIPTS,
} from "./validation-types.js";
import type { PackageManager, ResolvedWorkspaceConfig } from "./validation-types.js";

// ---------------------------------------------------------------------------
// Validation timeout — longer than standard commands (tests can be slow)
// ---------------------------------------------------------------------------

/** Per-command timeout for validation runs (5 minutes). */
const VALIDATION_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Execute the P11 Validation Engine against a workspace.
 *
 * Runs the repository's own configured validation commands in deterministic
 * order.  Returns structured evidence for every check.
 *
 * @throws {ValidationError}           invalid input
 * @throws {ValidationWorkspaceError}  workspace not in READY state
 * @throws {ValidationManifestError}   package.json cannot be read or parsed
 * @throws {ValidationEngineError}     unexpected internal error
 */
export async function runValidation(input: ValidationInput): Promise<ValidationResult> {
  const startedAt = new Date().toISOString();

  // 1. Validate input at the boundary
  const parsed = validationInputSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    throw new ValidationError(message);
  }

  const { workspace } = parsed.data;

  // 2. Workspace must be READY
  if (workspace.status !== "READY") {
    throw new ValidationWorkspaceError(
      `Workspace ${workspace.id} is not in READY state (current: ${workspace.status})`
    );
  }

  logger.info("Validation engine started", {
    workspaceId: workspace.id,
    workspacePath: workspace.path,
  });

  // 3. Resolve workspace configuration (package manager + scripts)
  const config = await resolveWorkspaceConfig(workspace.path);

  logger.info("Workspace configuration resolved", {
    workspaceId: workspace.id,
    packageManager: config.packageManager,
    typecheckScript: config.typecheckScript,
    buildScript: config.buildScript,
    testScript: config.testScript,
  });

  // 4. Execute validation checks in deterministic order
  const checks: ValidationCheckResult[] = [];

  // ── DEPENDENCY ──────────────────────────────────────────────────────────
  const depCheck = await runDependencyCheck(workspace.path, config);
  checks.push(depCheck);

  const dependencyPassed = depCheck.status === "PASSED" || depCheck.status === "NOT_APPLICABLE";

  // ── TYPECHECK ────────────────────────────────────────────────────────────
  if (!dependencyPassed) {
    checks.push(makeSkipped("check-typecheck", "TYPECHECK",
      "Skipped because dependency check failed"));
  } else {
    const tcCheck = await runScriptCheck(
      "check-typecheck", "TYPECHECK", workspace.path, config.packageManager,
      config.typecheckScript, "typecheck"
    );
    checks.push(tcCheck);
  }

  const typecheckPassed = checks[checks.length - 1]!.status === "PASSED"
    || checks[checks.length - 1]!.status === "NOT_APPLICABLE";

  // ── BUILD ────────────────────────────────────────────────────────────────
  if (!dependencyPassed) {
    checks.push(makeSkipped("check-build", "BUILD",
      "Skipped because dependency check failed"));
  } else if (!typecheckPassed) {
    checks.push(makeSkipped("check-build", "BUILD",
      "Skipped because typecheck failed"));
  } else {
    const buildCheck = await runScriptCheck(
      "check-build", "BUILD", workspace.path, config.packageManager,
      config.buildScript, "build"
    );
    checks.push(buildCheck);
  }

  // ── TEST ─────────────────────────────────────────────────────────────────
  if (!dependencyPassed) {
    checks.push(makeSkipped("check-test", "TEST",
      "Skipped because dependency check failed"));
  } else {
    // Tests run even if build failed — test runner may be independent
    const testCheck = await runScriptCheck(
      "check-test", "TEST", workspace.path, config.packageManager,
      config.testScript, "test"
    );
    checks.push(testCheck);
  }

  // 5. Compute overall status
  const status = computeOverallStatus(checks);
  const summary = computeSummary(checks);
  const completedAt = new Date().toISOString();

  const result: ValidationResult = {
    workspaceId: workspace.id,
    status,
    checks,
    summary,
    startedAt,
    completedAt,
  };

  logger.info("Validation engine completed", {
    workspaceId: workspace.id,
    status,
    passed: summary.passed,
    failed: summary.failed,
    notApplicable: summary.notApplicable,
    skipped: summary.skipped,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Workspace configuration resolution
// ---------------------------------------------------------------------------

/**
 * Detect the package manager and resolve available validation scripts
 * by reading the workspace package.json through the P3 file layer.
 *
 * @throws {ValidationManifestError}  if package.json cannot be read/parsed
 */
async function resolveWorkspaceConfig(workspacePath: string): Promise<ResolvedWorkspaceConfig> {
  // 1. Detect package manager by lock-file presence
  const packageManager = await detectPackageManager(workspacePath);

  // 2. Read package.json
  let manifestText: string;
  try {
    manifestText = await readWorkspaceFile(workspacePath, "package.json");
  } catch {
    throw new ValidationManifestError(
      "Cannot read package.json in workspace root — validation requires a valid Node.js project"
    );
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new ValidationManifestError(
      "package.json is not valid JSON — cannot determine available validation scripts"
    );
  }

  // 3. Extract scripts (tolerant — missing scripts field is fine)
  const scripts: Record<string, string> =
    isObject(manifest) && isObject(manifest["scripts"])
      ? extractStringRecord(manifest["scripts"])
      : {};

  // 4. Select scripts using the recognized allowlist
  const typecheckScript = findScript(scripts, RECOGNIZED_TYPECHECK_SCRIPTS) ?? null;
  const buildScript = findScript(scripts, RECOGNIZED_BUILD_SCRIPTS) ?? null;
  const testScript = findScript(scripts, RECOGNIZED_TEST_SCRIPTS) ?? null;

  return { packageManager, scripts, typecheckScript, buildScript, testScript };
}

/**
 * Detect package manager from lock-file presence.
 * Falls back to "npm" when no lock file is found.
 */
async function detectPackageManager(workspacePath: string): Promise<PackageManager> {
  for (const { file, pm } of LOCK_FILE_PRIORITY) {
    const exists = await workspacePathExists(workspacePath, file);
    if (exists) return pm;
  }
  return "npm";
}

// ---------------------------------------------------------------------------
// Dependency check
// ---------------------------------------------------------------------------

/**
 * Run the dependency installation / verification check.
 *
 * Uses:
 *   pnpm install --frozen-lockfile      (pnpm)
 *   npm ci                              (npm, when package-lock.json present)
 *   npm install                         (npm, no lock file)
 *   yarn install --frozen-lockfile      (yarn)
 */
async function runDependencyCheck(
  workspacePath: string,
  config: ResolvedWorkspaceConfig
): Promise<ValidationCheckResult> {
  const id = "check-dependency";
  const startedAt = Date.now();

  // Build the install command
  let command: string;
  let args: string[];

  switch (config.packageManager) {
    case "pnpm":
      command = "pnpm";
      args = ["install", "--frozen-lockfile"];
      break;
    case "yarn":
      command = "yarn";
      args = ["install", "--frozen-lockfile"];
      break;
    case "npm": {
      // Use `npm ci` when package-lock.json is present (more rigorous)
      const hasLock = await workspacePathExists(workspacePath, "package-lock.json");
      command = "npm";
      args = hasLock ? ["ci"] : ["install"];
      break;
    }
  }

  logger.info("Running dependency check", { command, args, workspacePath });

  const cmdStr = [command, ...args].join(" ");
  const result = await runCommand(command, args, workspacePath, VALIDATION_TIMEOUT_MS);
  const durationMs = Date.now() - startedAt;

  const { stdout, stderr, truncated } = truncateOutput(result.stdout, result.stderr);

  if (result.timedOut) {
    logger.warn("Dependency check timed out", { command, durationMs });
    return {
      id, type: "DEPENDENCY", status: "FAILED",
      command: cmdStr, args, exitCode: result.exitCode,
      stdout, stderr, durationMs,
      reason: `Dependency check timed out after ${VALIDATION_TIMEOUT_MS}ms`,
      truncated,
    };
  }

  const status: ValidationCheckStatus = result.exitCode === 0 ? "PASSED" : "FAILED";

  logger.info("Dependency check completed", { status, exitCode: result.exitCode, durationMs });

  return {
    id, type: "DEPENDENCY", status,
    command: cmdStr, args, exitCode: result.exitCode,
    stdout, stderr, durationMs,
    reason: status === "PASSED"
      ? "Dependencies installed successfully"
      : `Dependency installation failed with exit code ${result.exitCode}`,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Generic script check (typecheck / build / test)
// ---------------------------------------------------------------------------

/**
 * Run a package-manager script check.
 *
 * When scriptName is null (script not found in package.json), returns NOT_APPLICABLE.
 */
async function runScriptCheck(
  id: string,
  type: ValidationCheckResult["type"],
  workspacePath: string,
  packageManager: PackageManager,
  scriptName: string | null,
  humanName: string
): Promise<ValidationCheckResult> {
  // Not applicable if no matching script found
  if (scriptName === null) {
    logger.debug(`No ${humanName} script found — check not applicable`, { id });
    return {
      id, type, status: "NOT_APPLICABLE",
      durationMs: 0,
      reason: `No "${humanName}" script found in package.json`,
    };
  }

  // Build the run command: pnpm run <script> / npm run <script> / yarn run <script>
  let command: string;
  let args: string[];

  switch (packageManager) {
    case "pnpm": command = "pnpm"; args = ["run", scriptName]; break;
    case "yarn": command = "yarn"; args = ["run", scriptName]; break;
    case "npm":  command = "npm";  args = ["run", scriptName]; break;
  }

  const cmdStr = [command, ...args].join(" ");
  logger.info(`Running ${humanName} check`, { command: cmdStr, workspacePath });

  const startedAt = Date.now();
  const result = await runCommand(command, args, workspacePath, VALIDATION_TIMEOUT_MS);
  const durationMs = Date.now() - startedAt;

  const { stdout, stderr, truncated } = truncateOutput(result.stdout, result.stderr);

  if (result.timedOut) {
    logger.warn(`${humanName} check timed out`, { command, durationMs });
    return {
      id, type, status: "FAILED",
      command: cmdStr, args, exitCode: result.exitCode,
      stdout, stderr, durationMs,
      reason: `${humanName} check timed out after ${VALIDATION_TIMEOUT_MS}ms`,
      truncated,
    };
  }

  const status: ValidationCheckStatus = result.exitCode === 0 ? "PASSED" : "FAILED";

  logger.info(`${humanName} check completed`, { status, exitCode: result.exitCode, durationMs });

  return {
    id, type, status,
    command: cmdStr, args, exitCode: result.exitCode,
    stdout, stderr, durationMs,
    reason: status === "PASSED"
      ? `${humanName} passed`
      : `${humanName} failed with exit code ${result.exitCode}`,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a SKIPPED check result with zero duration. */
function makeSkipped(
  id: string,
  type: ValidationCheckResult["type"],
  reason: string
): ValidationCheckResult {
  return { id, type, status: "SKIPPED", durationMs: 0, reason };
}

/**
 * Compute the overall ValidationResult status from the individual checks.
 *
 * PASSED        — all checks are PASSED or NOT_APPLICABLE (at least one PASSED)
 * FAILED        — at least one check is FAILED
 * NOT_VALIDATED — all checks are NOT_APPLICABLE or SKIPPED (nothing ran)
 */
function computeOverallStatus(
  checks: ValidationCheckResult[]
): ValidationResult["status"] {
  const hasFailed = checks.some((c) => c.status === "FAILED");
  if (hasFailed) return "FAILED";

  const hasPassed = checks.some((c) => c.status === "PASSED");
  if (hasPassed) return "PASSED";

  return "NOT_VALIDATED";
}

/** Compute summary counts from checks. */
function computeSummary(checks: ValidationCheckResult[]): ValidationSummary {
  return {
    total: checks.length,
    passed: checks.filter((c) => c.status === "PASSED").length,
    failed: checks.filter((c) => c.status === "FAILED").length,
    notApplicable: checks.filter((c) => c.status === "NOT_APPLICABLE").length,
    skipped: checks.filter((c) => c.status === "SKIPPED").length,
  };
}

/**
 * Truncate stdout and stderr to MAX_OUTPUT_CHARS.
 *
 * When truncated, the first half and last half of MAX_OUTPUT_CHARS are
 * preserved, with TRUNCATION_MARKER in between.  This ensures both the
 * beginning and the end of the output are always visible.
 */
function truncateOutput(
  stdout: string,
  stderr: string
): { stdout: string; stderr: string; truncated: boolean } {
  const ts = truncateString(stdout);
  const te = truncateString(stderr);
  return {
    stdout: ts.value,
    stderr: te.value,
    truncated: ts.truncated || te.truncated,
  };
}

function truncateString(s: string): { value: string; truncated: boolean } {
  if (s.length <= MAX_OUTPUT_CHARS) return { value: s, truncated: false };
  const half = Math.floor((MAX_OUTPUT_CHARS - TRUNCATION_MARKER.length) / 2);
  const head = s.slice(0, half);
  const tail = s.slice(s.length - half);
  return { value: head + TRUNCATION_MARKER + tail, truncated: true };
}

/** Find the first matching script name from the priority list. */
function findScript(
  scripts: Record<string, string>,
  candidates: ReadonlyArray<string>
): string | undefined {
  return candidates.find((name) => name in scripts);
}

/** Type-guard: is the value a non-null object? */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Extract string-valued keys from a record (ignores non-string values). */
function extractStringRecord(obj: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") result[k] = v;
  }
  return result;
}
