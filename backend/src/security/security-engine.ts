/**
 * P15 Security Engine — main orchestrator.
 *
 * Pipeline:
 *   1. Validate input (Zod)
 *   2. Secret Scanner (deterministic)
 *   3. Dependency Audit (P3 npm audit)
 *   4. Security-Relevant Code/Config Analysis (deterministic)
 *   5. IBM Bob Security Review (optional, advisory)
 *   6. Deduplicate findings
 *   7. Sort deterministically
 *   8. Assign stable SEC-NNN IDs
 *   9. Build summary + checks
 *  10. Return SecurityScanResult
 *
 * Core invariants:
 *  - Deterministic checks NEVER depend on Bob.
 *  - Bob CANNOT override or delete deterministic findings.
 *  - No secret values ever appear in findings, logs, or API responses.
 *  - P15 produces findings; it does NOT reject migrations (P16 does that).
 *  - Same input → same output (deterministic except for Bob's response).
 */

import { readdir, readFile, stat } from "fs/promises";
import { join, extname } from "path";
import { ValidationError } from "@driftzero/shared";
import type {
  SecurityScanInput,
  SecurityScanResult,
  SecurityFinding,
  SecuritySummary,
  SecurityCheckResult,
  SecurityScanStatus,
  MigrationChange,
  UnexpectedChangeDetectionResult,
} from "@driftzero/shared";
import { logger } from "../utils/logger.js";
import { safeResolvePath } from "../workspace/files.js";
import { PathTraversalError } from "../workspace/workspace-errors.js";
import { securityScanInputSchema } from "./security-types.js";
import { SecurityWorkspaceError } from "./security-errors.js";
import { scanForSecrets } from "./secret-scanner.js";
import { auditDependencies } from "./dependency-audit.js";
import { runBobSecurityReview } from "./security-review.js";
import type { SecurityFileContext } from "../prompts/security-review.js";

// ---------------------------------------------------------------------------
// Security-relevant keyword patterns for code/config analysis
// ---------------------------------------------------------------------------

const SECURITY_RELEVANT_PATTERNS: Array<{
  pattern: RegExp;
  topic: string;
  severity: SecurityFinding["severity"];
  recommendation?: string;
}> = [
  {
    pattern: /cors\s*\(\s*\{\s*origin\s*:\s*["']\s*\*\s*["']/i,
    topic: "Permissive CORS origin (wildcard *)",
    severity: "MEDIUM",
    recommendation: "Restrict CORS origin to specific trusted domains.",
  },
  {
    pattern: /helmet\s*\(\s*\{\s*[^}]*contentSecurityPolicy\s*:\s*false/i,
    topic: "Content Security Policy disabled in Helmet",
    severity: "MEDIUM",
    recommendation: "Enable Content Security Policy in Helmet configuration.",
  },
  {
    pattern: /app\.disable\s*\(\s*["']x-powered-by["']\s*\)/i,
    topic: "X-Powered-By header explicitly disabled (positive)",
    severity: "LOW",
    recommendation: "This is good practice — no action needed.",
  },
  {
    pattern: /eval\s*\(/,
    topic: "eval() usage detected",
    severity: "HIGH",
    recommendation: "Avoid eval() — it can execute arbitrary code.",
  },
  {
    pattern: /child_process|exec\s*\(|spawn\s*\(|execSync\s*\(/,
    topic: "Child process / shell execution detected",
    severity: "MEDIUM",
    recommendation: "Ensure shell commands use sanitized inputs and are not influenced by user data.",
  },
  {
    pattern: /\.cookie\s*\([^)]*httpOnly\s*:\s*false/i,
    topic: "Cookie set without httpOnly flag",
    severity: "MEDIUM",
    recommendation: "Set httpOnly: true on sensitive cookies to prevent XSS access.",
  },
  {
    pattern: /\.cookie\s*\([^)]*secure\s*:\s*false/i,
    topic: "Cookie set without secure flag",
    severity: "LOW",
    recommendation: "Set secure: true on production cookies.",
  },
  {
    pattern: /tls\s*:\s*\{\s*rejectUnauthorized\s*:\s*false/i,
    topic: "TLS certificate validation disabled",
    severity: "HIGH",
    recommendation: "Never disable TLS certificate validation in production.",
  },
  {
    pattern: /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0["']?/,
    topic: "NODE_TLS_REJECT_UNAUTHORIZED set to 0",
    severity: "HIGH",
    recommendation: "Never disable TLS validation. Remove NODE_TLS_REJECT_UNAUTHORIZED=0.",
  },
  {
    pattern: /sql\s*=\s*["'`][^"'`]*\$\{[^}]+\}/,
    topic: "Potential string-interpolated SQL query",
    severity: "HIGH",
    recommendation: "Use parameterized queries or prepared statements to prevent SQL injection.",
  },
  {
    pattern: /req\.query\.[a-zA-Z]+\s*\|\|\s*["'].*["']/,
    topic: "User input from req.query used directly",
    severity: "LOW",
    recommendation: "Validate and sanitize all query parameters before use.",
  },
];

// ---------------------------------------------------------------------------
// Directory exclusions for code analysis (same as secret scanner)
// ---------------------------------------------------------------------------
const EXCLUDED_CODE_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "coverage",
  ".cache", ".turbo", "tmp",
]);

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the full P15 security scan.
 *
 * @throws {ValidationError}         on invalid input
 * @throws {SecurityWorkspaceError}  on workspace not READY
 */
export async function runSecurityScan(
  input: SecurityScanInput
): Promise<SecurityScanResult> {
  // 1. Validate input
  const parsed = securityScanInputSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    throw new ValidationError(message);
  }

  const {
    workspace,
    migrationPlan,
    migrationResult,
    testGenerationResult,
    recoveryResult,
    unexpectedChanges,
  } = parsed.data;

  // 2. Workspace must be READY
  if (workspace.status !== "READY") {
    throw new SecurityWorkspaceError(
      `Workspace ${workspace.id} is not in READY state (current: ${workspace.status})`
    );
  }

  const startedAt = new Date().toISOString();
  logger.info("Security scan started", { workspaceId: workspace.id });

  // Collect all findings (without IDs yet)
  const rawFindings: Omit<SecurityFinding, "id">[] = [];
  const checks: SecurityCheckResult[] = [];
  let anyOptionalFailed = false;

  // 3. Secret Scanner
  {
    const t0 = Date.now();
    let secretFindings: Omit<SecurityFinding, "id">[] = [];
    let checkStatus: SecurityCheckResult["status"] = "PASSED";

    try {
      secretFindings = await scanForSecrets(workspace.path);
      checkStatus = secretFindings.length > 0 ? "FINDINGS" : "PASSED";
    } catch (err) {
      checkStatus = "FAILED";
      anyOptionalFailed = true;
      logger.error("Secret scanner failed", {
        reason: err instanceof Error ? err.message : "unknown",
      });
    }

    rawFindings.push(...secretFindings);
    checks.push({
      id: "secret-scan",
      name: "Secret Scanner",
      status: checkStatus,
      findingCount: secretFindings.length,
      durationMs: Date.now() - t0,
    });
  }

  // 4. Dependency Audit
  {
    const t0 = Date.now();
    const auditResult = await auditDependencies(workspace.path);
    const depFindings = auditResult.findings;
    rawFindings.push(...depFindings);

    let checkStatus: SecurityCheckResult["status"];
    if (auditResult.status === "UNAVAILABLE") {
      checkStatus = "SKIPPED";
      anyOptionalFailed = true;
    } else if (auditResult.status === "FAILED") {
      checkStatus = "FAILED";
      anyOptionalFailed = true;
    } else if (auditResult.status === "PARTIAL") {
      checkStatus = depFindings.length > 0 ? "FINDINGS" : "PASSED";
      anyOptionalFailed = true;
    } else {
      checkStatus = depFindings.length > 0 ? "FINDINGS" : "PASSED";
    }

    checks.push({
      id: "dependency-audit",
      name: "Dependency Audit",
      status: checkStatus,
      findingCount: depFindings.length,
      durationMs: auditResult.durationMs,
      reason: auditResult.reason,
    });
  }

  // 5. Security-Relevant Code/Config Analysis
  {
    const t0 = Date.now();
    let codeFindings: Omit<SecurityFinding, "id">[] = [];
    let checkStatus: SecurityCheckResult["status"] = "PASSED";

    try {
      codeFindings = await analyzeSecurityRelevantChanges(
        workspace.path,
        migrationResult.changes,
        testGenerationResult?.changes ?? [],
        unexpectedChanges
      );
      checkStatus = codeFindings.length > 0 ? "FINDINGS" : "PASSED";
    } catch (err) {
      checkStatus = "FAILED";
      anyOptionalFailed = true;
      logger.error("Code/config security analysis failed", {
        reason: err instanceof Error ? err.message : "unknown",
      });
    }

    rawFindings.push(...codeFindings);
    checks.push({
      id: "code-analysis",
      name: "Security-Relevant Code Analysis",
      status: checkStatus,
      findingCount: codeFindings.length,
      durationMs: Date.now() - t0,
    });
  }

  // 6. IBM Bob Security Review (optional)
  {
    const t0 = Date.now();
    const allMigrationChanges: MigrationChange[] = [
      ...migrationResult.changes,
      ...(testGenerationResult?.changes.map((c) => ({
        stepId: c.stepId,
        filePath: c.filePath,
        operation: c.operation,
        explanation: c.explanation,
      })) ?? []),
    ];

    // Gather limited file contexts for Bob (avoid sending too much)
    const fileContexts = await gatherFileContexts(
      workspace.path,
      allMigrationChanges.map((c) => c.filePath)
    );

    // Only pass deterministic findings to Bob as context (already resolved)
    const deterministicFindings = rawFindings.map((f, i) => ({
      ...f,
      id: `DET-${String(i + 1).padStart(3, "0")}`,
    })) as SecurityFinding[];

    const reviewResult = await runBobSecurityReview(
      migrationPlan,
      allMigrationChanges,
      deterministicFindings,
      fileContexts,
      unexpectedChanges
    );

    const bobFindings = reviewResult.findings;
    rawFindings.push(...bobFindings);

    let checkStatus: SecurityCheckResult["status"];
    if (reviewResult.status === "UNAVAILABLE") {
      checkStatus = "SKIPPED";
      anyOptionalFailed = true;
    } else if (reviewResult.status === "FAILED") {
      checkStatus = "FAILED";
      anyOptionalFailed = true;
    } else {
      checkStatus = bobFindings.length > 0 ? "FINDINGS" : "PASSED";
    }

    checks.push({
      id: "bob-security-review",
      name: "IBM Bob Security Review",
      status: checkStatus,
      findingCount: bobFindings.length,
      durationMs: reviewResult.durationMs,
      reason: reviewResult.reason,
    });
  }

  // 7. Deduplicate
  const deduplicated = deduplicateFindings(rawFindings);

  // 8. Sort deterministically
  const sorted = sortFindings(deduplicated);

  // 9. Assign stable SEC-NNN IDs
  const findings: SecurityFinding[] = sorted.map((f, i) => ({
    ...f,
    id: `SEC-${String(i + 1).padStart(3, "0")}`,
  }));

  // 10. Build summary
  const summary = buildSummary(findings);

  // 11. Determine status
  const status = determineStatus(findings, anyOptionalFailed);

  const completedAt = new Date().toISOString();

  logger.info("Security scan completed", {
    workspaceId: workspace.id,
    status,
    totalFindings: findings.length,
    critical: summary.critical,
    high: summary.high,
  });

  return {
    workspaceId: workspace.id,
    status,
    findings,
    summary,
    checks,
    startedAt,
    completedAt,
  };
}

// ---------------------------------------------------------------------------
// Security-relevant code/config analysis
// ---------------------------------------------------------------------------

/**
 * Analyze files changed by the migration for security-relevant patterns.
 * Also considers P14 unexpected changes as context.
 */
async function analyzeSecurityRelevantChanges(
  workspacePath: string,
  migrationChanges: MigrationChange[],
  testChanges: Array<{ filePath: string }>,
  unexpectedChanges?: UnexpectedChangeDetectionResult
): Promise<Omit<SecurityFinding, "id">[]> {
  const findings: Omit<SecurityFinding, "id">[] = [];

  // Collect unique file paths to check
  const filePaths = new Set<string>([
    ...migrationChanges.map((c) => c.filePath),
    ...testChanges.map((c) => c.filePath),
  ]);

  // Also note unexpected changes as potential security context
  if (unexpectedChanges?.unexpectedChanges.length) {
    for (const uc of unexpectedChanges.unexpectedChanges) {
      filePaths.add(uc.filePath);
    }
  }

  for (const relPath of filePaths) {
    let absPath: string;
    try {
      absPath = safeResolvePath(workspacePath, relPath);
    } catch (err) {
      if (err instanceof PathTraversalError) continue;
      continue;
    }

    let content: string;
    try {
      const info = await stat(absPath);
      if (info.size > 512_000) continue; // skip large files
      content = await readFile(absPath, "utf8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      for (const rule of SECURITY_RELEVANT_PATTERNS) {
        if (rule.pattern.test(line)) {
          // LOW severity positive patterns (like x-powered-by disabled) skip
          if (rule.severity === "LOW" && rule.topic.includes("(positive)")) continue;

          findings.push({
            category: "CODE",
            severity: rule.severity,
            title: `Security-relevant pattern: ${rule.topic}`,
            description:
              `The migration changed ${relPath} which contains a security-relevant pattern. ` +
              `Topic: ${rule.topic}`,
            filePath: relPath,
            line: i + 1,
            evidence: [
              `File: ${relPath} (line ${i + 1})`,
              `Pattern: ${rule.topic}`,
            ],
            source: "DETERMINISTIC",
            recommendation: rule.recommendation,
          });

          break; // One finding per file per line is enough
        }
      }
    }
  }

  // Also scan configuration files across the workspace for certain patterns
  await walkForCodeFindings(workspacePath, workspacePath, findings, 0);

  return findings;
}

async function walkForCodeFindings(
  root: string,
  current: string,
  findings: Omit<SecurityFinding, "id">[],
  depth: number
): Promise<void> {
  if (depth > 5) return; // depth limit

  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_CODE_DIRS.has(entry.name)) continue;
      await walkForCodeFindings(root, join(current, entry.name), findings, depth + 1);
      continue;
    }

    if (!entry.isFile()) continue;

    const ext = extname(entry.name).toLowerCase();
    if (![".ts", ".tsx", ".js", ".jsx", ".mjs"].includes(ext)) continue;

    const fullPath = join(current, entry.name);
    const relPath = fullPath.slice(root.length + 1);

    let absPath: string;
    try {
      absPath = safeResolvePath(root, relPath);
    } catch {
      continue;
    }

    let content: string;
    try {
      const info = await stat(absPath);
      if (info.size > 512_000) continue;
      content = await readFile(absPath, "utf8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      for (const rule of SECURITY_RELEVANT_PATTERNS) {
        if (rule.severity === "LOW") continue; // skip low in broad scan
        if (rule.topic.includes("(positive)")) continue;
        if (rule.pattern.test(line)) {
          // Avoid duplicating what analyzeSecurityRelevantChanges already found
          const alreadyFound = findings.some(
            (f) => f.filePath === relPath && f.line === i + 1 && f.title.includes(rule.topic)
          );
          if (alreadyFound) continue;

          findings.push({
            category: "CODE",
            severity: rule.severity,
            title: `Security-relevant pattern: ${rule.topic}`,
            description:
              `${relPath} contains a security-relevant pattern detected during workspace scan. ` +
              `Topic: ${rule.topic}`,
            filePath: relPath,
            line: i + 1,
            evidence: [
              `File: ${relPath} (line ${i + 1})`,
              `Pattern: ${rule.topic}`,
            ],
            source: "DETERMINISTIC",
            recommendation: rule.recommendation,
          });
          break;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Gather file contexts for Bob (bounded, safe)
// ---------------------------------------------------------------------------

const MAX_FILE_CONTEXT_FILES = 8;
const MAX_FILE_CONTEXT_BYTES = 4000;

async function gatherFileContexts(
  workspacePath: string,
  filePaths: string[]
): Promise<SecurityFileContext[]> {
  const contexts: SecurityFileContext[] = [];
  const seen = new Set<string>();

  for (const relPath of filePaths) {
    if (seen.has(relPath)) continue;
    if (contexts.length >= MAX_FILE_CONTEXT_FILES) break;
    seen.add(relPath);

    let absPath: string;
    try {
      absPath = safeResolvePath(workspacePath, relPath);
    } catch {
      continue;
    }

    try {
      const info = await stat(absPath);
      if (info.size > 512_000) continue;
      const content = await readFile(absPath, "utf8");
      // Truncate to keep Bob prompt bounded
      const truncated =
        content.length > MAX_FILE_CONTEXT_BYTES
          ? content.slice(0, MAX_FILE_CONTEXT_BYTES) + "\n... (truncated)"
          : content;

      contexts.push({ filePath: relPath, content: truncated });
    } catch {
      continue;
    }
  }

  return contexts;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Deduplicate findings deterministically.
 * Fingerprint = category + filePath + line + normalised title.
 *
 * When two sources (e.g. DETERMINISTIC and BOB) find the same issue:
 *  - Keep the DETERMINISTIC finding (it has higher authority).
 *  - Bob finding is discarded (evidence already present).
 *
 * Two genuinely different findings are never merged.
 */
function deduplicateFindings(
  raw: Omit<SecurityFinding, "id">[]
): Omit<SecurityFinding, "id">[] {
  const seen = new Map<string, Omit<SecurityFinding, "id">>();

  for (const f of raw) {
    const key = fingerprint(f);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, f);
    } else {
      // Prefer DETERMINISTIC over BOB/DEPENDENCY_AUDIT
      if (
        existing.source === "BOB" &&
        (f.source === "DETERMINISTIC" || f.source === "DEPENDENCY_AUDIT")
      ) {
        seen.set(key, f);
      }
      // Otherwise keep existing (deterministic already wins)
    }
  }

  return Array.from(seen.values());
}

function fingerprint(f: Omit<SecurityFinding, "id">): string {
  const title = f.title.toLowerCase().replace(/\s+/g, " ").trim();
  return [
    f.category,
    f.filePath ?? "",
    String(f.line ?? ""),
    title,
  ].join("|");
}

// ---------------------------------------------------------------------------
// Sorting — CRITICAL > HIGH > MEDIUM > LOW, then category, filePath, title
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<SecurityFinding["severity"], number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

const CATEGORY_ORDER: Record<SecurityFinding["category"], number> = {
  SECRET: 0,
  DEPENDENCY: 1,
  CODE: 2,
  CONFIGURATION: 3,
  AI_REVIEW: 4,
};

function sortFindings(
  findings: Omit<SecurityFinding, "id">[]
): Omit<SecurityFinding, "id">[] {
  return [...findings].sort((a, b) => {
    const sevDiff =
      (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
    if (sevDiff !== 0) return sevDiff;

    const catDiff =
      (CATEGORY_ORDER[a.category] ?? 9) - (CATEGORY_ORDER[b.category] ?? 9);
    if (catDiff !== 0) return catDiff;

    const pathDiff = (a.filePath ?? "").localeCompare(b.filePath ?? "");
    if (pathDiff !== 0) return pathDiff;

    return a.title.localeCompare(b.title);
  });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function buildSummary(findings: SecurityFinding[]): SecuritySummary {
  return {
    totalFindings: findings.length,
    critical: findings.filter((f) => f.severity === "CRITICAL").length,
    high: findings.filter((f) => f.severity === "HIGH").length,
    medium: findings.filter((f) => f.severity === "MEDIUM").length,
    low: findings.filter((f) => f.severity === "LOW").length,
    secretsDetected: findings.filter((f) => f.category === "SECRET").length,
    dependencyFindings: findings.filter((f) => f.category === "DEPENDENCY").length,
    codeFindings: findings.filter((f) => f.category === "CODE").length,
    configurationFindings: findings.filter((f) => f.category === "CONFIGURATION").length,
    aiReviewFindings: findings.filter((f) => f.category === "AI_REVIEW").length,
  };
}

// ---------------------------------------------------------------------------
// Status determination
// ---------------------------------------------------------------------------

function determineStatus(
  findings: SecurityFinding[],
  anyOptionalFailed: boolean
): SecurityScanStatus {
  if (findings.length > 0) {
    return "FINDINGS";
  }
  if (anyOptionalFailed) {
    return "PARTIAL";
  }
  return "CLEAN";
}
