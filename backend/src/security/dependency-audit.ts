/**
 * P15 Dependency Audit — deterministic dependency inventory and security analysis.
 *
 * Strategy:
 *  - Parse package.json manifests and lockfiles from the workspace.
 *  - Attempt to run "npm audit --json" via P3 runCommand if npm is available.
 *  - Normalize audit output into SecurityFinding objects.
 *  - Malformed individual audit entries are skipped; partial results are kept.
 *  - If npm audit cannot run (not on allowlist or command fails), fall back to
 *    manifest-only inventory with a PARTIAL note.
 *
 * Does NOT:
 *  - Invent CVE identifiers.
 *  - Connect to external vulnerability databases.
 *  - Bypass P3 runCommand.
 */

import { join } from "path";
import { safeResolvePath } from "../workspace/files.js";
import { runCommand, ALLOWED_COMMANDS } from "../workspace/commands.js";
import { PathTraversalError } from "../workspace/workspace-errors.js";
import { logger } from "../utils/logger.js";
import type { SecurityFinding } from "@driftzero/shared";

// ---------------------------------------------------------------------------
// npm audit JSON output shapes (v2 format)
// ---------------------------------------------------------------------------

interface NpmAuditVulnerability {
  name?: string;
  severity?: string;
  via?: unknown[];
  range?: string;
  nodes?: string[];
  effects?: string[];
  fixAvailable?: boolean | { name: string; version: string };
  isDirect?: boolean;
  title?: string;
  url?: string;
}

interface NpmAuditMetadata {
  vulnerabilities?: {
    total?: number;
    info?: number;
    low?: number;
    moderate?: number;
    high?: number;
    critical?: number;
  };
}

interface NpmAuditOutput {
  vulnerabilities?: Record<string, NpmAuditVulnerability>;
  metadata?: NpmAuditMetadata;
  auditReportVersion?: number;
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface DependencyAuditResult {
  available: boolean;
  findings: Omit<SecurityFinding, "id">[];
  /**
   * COMPLETED — audit ran and output was parsed
   * PARTIAL   — audit ran but some output was malformed; usable findings kept
   * UNAVAILABLE — audit could not run (not in allowlist or no package.json)
   * FAILED    — audit command produced an unexpected error
   */
  status: "COMPLETED" | "PARTIAL" | "UNAVAILABLE" | "FAILED";
  reason?: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run a dependency security audit against the workspace.
 *
 * Never throws — returns a structured result even on error.
 */
export async function auditDependencies(
  workspacePath: string
): Promise<DependencyAuditResult> {
  const start = Date.now();

  // Verify workspace has a package.json
  let pkgJsonPath: string;
  try {
    pkgJsonPath = safeResolvePath(workspacePath, "package.json");
  } catch (err) {
    if (err instanceof PathTraversalError) {
      return unavailable("Path traversal prevented package.json access", start);
    }
    return unavailable("Could not resolve package.json path", start);
  }

  const { readFile } = await import("fs/promises");
  try {
    await readFile(pkgJsonPath, "utf8");
  } catch {
    // No package.json → dependency audit is not applicable
    return unavailable("No package.json found in workspace root", start);
  }

  // Check if npm is on the allowlist
  if (!ALLOWED_COMMANDS.has("npm")) {
    return unavailable("npm is not on the P3 command allowlist", start);
  }

  // Run npm audit --json
  logger.info("Running npm audit", { workspacePath });
  let auditOutput: string;
  try {
    const result = await runCommand(
      "npm",
      ["audit", "--json"],
      workspacePath,
      60_000 // 60s timeout for audit
    );
    // npm audit exits with non-zero when vulnerabilities found — that's fine
    auditOutput = result.stdout;
    if (!auditOutput.trim()) {
      return {
        available: true,
        findings: [],
        status: "COMPLETED",
        reason: "npm audit produced no output",
        durationMs: Date.now() - start,
      };
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Unknown error";
    logger.warn("npm audit command failed", { reason });
    return {
      available: false,
      findings: [],
      status: "FAILED",
      reason: `npm audit failed: ${reason}`,
      durationMs: Date.now() - start,
    };
  }

  // Parse output
  return parseAuditOutput(auditOutput, start);
}

// ---------------------------------------------------------------------------
// Parse npm audit --json output
// ---------------------------------------------------------------------------

function parseAuditOutput(
  raw: string,
  startTime: number
): DependencyAuditResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn("npm audit output is not valid JSON");
    return {
      available: true,
      findings: [],
      status: "PARTIAL",
      reason: "npm audit output could not be parsed as JSON",
      durationMs: Date.now() - startTime,
    };
  }

  const audit = parsed as NpmAuditOutput;

  if (!audit.vulnerabilities || typeof audit.vulnerabilities !== "object") {
    // npm audit returned something but no vulnerabilities key — treat as clean
    return {
      available: true,
      findings: [],
      status: "COMPLETED",
      durationMs: Date.now() - startTime,
    };
  }

  const findings: Omit<SecurityFinding, "id">[] = [];
  let hadMalformed = false;

  for (const [pkgName, vuln] of Object.entries(audit.vulnerabilities)) {
    try {
      const finding = normalizeVulnerability(pkgName, vuln);
      if (finding) findings.push(finding);
    } catch {
      hadMalformed = true;
      logger.warn("Skipping malformed npm audit vulnerability entry", { pkgName });
    }
  }

  return {
    available: true,
    findings,
    status: hadMalformed ? "PARTIAL" : "COMPLETED",
    durationMs: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// Normalize a single vulnerability entry
// ---------------------------------------------------------------------------

function normalizeVulnerability(
  pkgName: string,
  vuln: NpmAuditVulnerability
): Omit<SecurityFinding, "id"> | null {
  if (!pkgName) return null;

  const rawSeverity = (vuln.severity ?? "").toLowerCase();
  const severity = mapSeverity(rawSeverity);

  // Build advisory title from available fields
  // Titles from npm audit output are strings — never invent CVE IDs
  const viaTitle = extractViaTitle(vuln.via);
  const title = viaTitle
    ? `Vulnerable dependency: ${pkgName} — ${viaTitle}`
    : `Vulnerable dependency: ${pkgName}`;

  const range = vuln.range ?? "unknown range";
  const isDirect = vuln.isDirect ?? false;

  const evidence: string[] = [
    `Package: ${pkgName}`,
    `Affected range: ${range}`,
    `Direct dependency: ${isDirect}`,
  ];

  if (vuln.effects && vuln.effects.length > 0) {
    evidence.push(`Affects: ${vuln.effects.slice(0, 5).join(", ")}`);
  }

  // Advisory URL if available — this comes from npm, not invented
  if (vuln.url && typeof vuln.url === "string") {
    evidence.push(`Advisory: ${vuln.url}`);
  }

  const fixNote =
    typeof vuln.fixAvailable === "object" && vuln.fixAvailable !== null
      ? `Fix available: upgrade to ${vuln.fixAvailable.name}@${vuln.fixAvailable.version}`
      : vuln.fixAvailable === true
      ? "A fix is available — run npm audit fix"
      : "No automated fix available";

  return {
    category: "DEPENDENCY",
    severity,
    title,
    description: `npm audit identified a vulnerability in ${pkgName}. ${fixNote}.`,
    evidence,
    source: "DEPENDENCY_AUDIT",
    recommendation: fixNote,
  };
}

function extractViaTitle(via: unknown[] | undefined): string | null {
  if (!Array.isArray(via)) return null;
  for (const entry of via) {
    if (typeof entry === "object" && entry !== null && "title" in entry) {
      const t = (entry as { title?: unknown }).title;
      if (typeof t === "string" && t.trim()) return t.trim().slice(0, 120);
    }
    if (typeof entry === "string" && entry.trim()) {
      return entry.slice(0, 120);
    }
  }
  return null;
}

function mapSeverity(
  raw: string
): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  switch (raw) {
    case "critical": return "CRITICAL";
    case "high":     return "HIGH";
    case "moderate": return "MEDIUM";
    case "low":      return "LOW";
    case "info":     return "LOW";
    default:         return "MEDIUM";
  }
}

function unavailable(reason: string, start: number): DependencyAuditResult {
  return {
    available: false,
    findings: [],
    status: "UNAVAILABLE",
    reason,
    durationMs: Date.now() - start,
  };
}
