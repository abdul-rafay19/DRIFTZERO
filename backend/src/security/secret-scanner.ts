/**
 * P15 Secret Scanner — deterministic credential/secret detection.
 *
 * Invariants:
 *  - Zero Bob calls. Fully deterministic regex-based scanning.
 *  - NEVER returns secret values in findings. Evidence is redacted.
 *  - Skips excluded directories (node_modules, .git, dist, .next, etc.).
 *  - Uses P3 safeResolvePath for all file access.
 *  - Conservative patterns — prefers false negatives over false positives.
 *  - Obvious placeholders are never flagged (YOUR_API_KEY, CHANGE_ME, etc.).
 *  - PEM/key files are scanned regardless of extension.
 */

import { readdir, readFile, stat } from "fs/promises";
import { join, extname } from "path";
import { safeResolvePath } from "../workspace/files.js";
import { PathTraversalError } from "../workspace/workspace-errors.js";
import { logger } from "../utils/logger.js";
import type { SecurityFinding, SecurityFindingSeverity } from "@driftzero/shared";

// ---------------------------------------------------------------------------
// Excluded directory names — never descend into these
// ---------------------------------------------------------------------------
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".turbo",
  "tmp",
  ".nyc_output",
  "out",
]);

// ---------------------------------------------------------------------------
// File extensions to scan
// ---------------------------------------------------------------------------
const SCANNABLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg",
  ".env", ".sh", ".bash", ".zsh",
  ".conf", ".config",
  ".properties", ".xml",
  ".dockerignore", ".dockerfile",
  ".tf", ".tfvars",  // Terraform
  // Certificate / key files
  ".pem", ".key", ".crt", ".cert", ".cer", ".p12", ".pfx",
]);

// Files to always scan regardless of extension (environment files, dotfiles)
const ALWAYS_SCAN_NAMES = new Set([
  ".env", ".env.local", ".env.production", ".env.development", ".env.test",
  ".env.staging", ".env.example", ".env.template",
  "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
  ".npmrc", ".yarnrc", "config",
]);

// ---------------------------------------------------------------------------
// Obvious placeholders — these patterns in the value → skip the line
// ---------------------------------------------------------------------------
const PLACEHOLDER_PATTERNS = [
  /YOUR_[A-Z_]+/,
  /CHANGE_ME/i,
  /REPLACE_ME/i,
  /PLACEHOLDER/i,
  /example/i,
  /<[A-Z_]+>/,          // <TOKEN>, <API_KEY>
  /\$\{[A-Z_]+\}/,      // ${ENV_VAR}
  /\$[A-Z_]+/,          // $ENV_VAR (shell var reference)
  /^(true|false|null|undefined|0|1)$/i,
  /localhost/i,
  /127\.0\.0\.1/,
  /\.\.\./,             // ellipsis placeholders
];

// ---------------------------------------------------------------------------
// Secret detection rules
// ---------------------------------------------------------------------------

interface SecretRule {
  id: string;
  name: string;
  severity: SecurityFindingSeverity;
  pattern: RegExp;
  /** Extract the "value" part for placeholder checking (group 1 if present) */
  valueGroup?: number;
  recommendation?: string;
}

const SECRET_RULES: SecretRule[] = [
  // Private keys (PEM headers)
  {
    id: "private-key",
    name: "Private Key",
    severity: "CRITICAL",
    pattern: /-----BEGIN\s+(RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/,
    recommendation: "Remove private keys from source code. Use secure key management.",
  },
  // AWS access key ID
  {
    id: "aws-access-key",
    name: "AWS Access Key ID",
    severity: "CRITICAL",
    pattern: /\b(AKIA[0-9A-Z]{16})\b/,
    valueGroup: 1,
    recommendation: "Rotate this AWS access key immediately. Never commit cloud credentials.",
  },
  // AWS secret key (looks like: aws_secret_access_key = <40-char value>)
  {
    id: "aws-secret-key",
    name: "AWS Secret Access Key",
    severity: "CRITICAL",
    pattern: /aws[_\-.]?secret[_\-.]?(access[_\-.]?)?key\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})["']?/i,
    valueGroup: 2,
    recommendation: "Rotate this AWS secret access key immediately.",
  },
  // Generic high-entropy API keys (sk-, pk-, key patterns)
  {
    id: "api-key-generic",
    name: "API Key Assignment",
    severity: "HIGH",
    // key/api_key/apiKey assigned a value that looks like a real secret (not a reference)
    pattern: /(?:api[_\-.]?key|apikey|access[_\-.]?key)\s*[=:]\s*["']?([a-zA-Z0-9_\-./+]{20,})["']?/i,
    valueGroup: 1,
    recommendation: "Move API keys to environment variables, never commit them.",
  },
  // Secret/password assignment in config/env
  {
    id: "secret-assignment",
    name: "Secret or Password Assignment",
    severity: "HIGH",
    pattern: /(?:secret|password|passwd|pwd)\s*[=:]\s*["']([^"'\s]{8,})["']/i,
    valueGroup: 1,
    recommendation: "Use environment variables or a secrets manager for credentials.",
  },
  // Token assignment
  {
    id: "token-assignment",
    name: "Token Assignment",
    severity: "HIGH",
    pattern: /(?:token|auth[_\-.]?token|bearer[_\-.]?token|access[_\-.]?token)\s*[=:]\s*["']([a-zA-Z0-9_.\-+/]{20,})["']/i,
    valueGroup: 1,
    recommendation: "Do not hard-code tokens. Use environment variables.",
  },
  // GitHub personal access token (classic: ghp_, fine-grained: github_pat_)
  {
    id: "github-token",
    name: "GitHub Token",
    severity: "HIGH",
    // Classic tokens are ghp_ + 36 chars; allow 30–50 to handle test fixtures
    pattern: /\b(ghp_[A-Za-z0-9_]{30,50}|github_pat_[A-Za-z0-9_]{70,100})\b/,
    valueGroup: 1,
    recommendation: "Revoke this GitHub token immediately and remove from source.",
  },
  // Generic Bearer token in Authorization header value
  {
    id: "bearer-token",
    name: "Bearer Token in Authorization Value",
    severity: "HIGH",
    pattern: /[Aa]uthorization\s*[=:]\s*["']?Bearer\s+([A-Za-z0-9\-._~+/]{20,})["']?/,
    valueGroup: 1,
    recommendation: "Do not hard-code authorization tokens.",
  },
  // Database connection string with credentials
  {
    id: "db-connection-string",
    name: "Database Connection String with Credentials",
    severity: "HIGH",
    pattern: /(?:mongodb|postgres|postgresql|mysql|redis|amqp)(?:\+[a-z]+)?:\/\/[^:@\s]+:[^@\s]{4,}@/i,
    recommendation: "Use environment variables for database credentials.",
  },
  // Slack token
  {
    id: "slack-token",
    name: "Slack Token",
    severity: "MEDIUM",
    pattern: /\b(xox[baprs]-[0-9A-Za-z\-]{10,})\b/,
    valueGroup: 1,
    recommendation: "Revoke this Slack token and remove from source.",
  },
  // Generic base64-looking secret in env-style assignment (for .env files specifically)
  {
    id: "env-secret",
    name: "Environment Variable Secret Value",
    severity: "MEDIUM",
    // Only match in env-style files — long opaque values assigned
    pattern: /^(?:SECRET|PRIVATE|CREDENTIAL|KEY|PASS|PWD)\w*\s*=\s*([A-Za-z0-9+/=]{32,})\s*$/m,
    valueGroup: 1,
    recommendation: "Do not commit secret environment variable values.",
  },
  // JWT-like triple-base64 pattern
  {
    id: "jwt-token",
    name: "JWT-like Token",
    severity: "MEDIUM",
    pattern: /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/,
    recommendation: "Do not hard-code JWT tokens in source code.",
  },
];

// ---------------------------------------------------------------------------
// Main scanner
// ---------------------------------------------------------------------------

export interface SecretScannerOptions {
  /** Maximum file size to scan in bytes (default: 500 KB) */
  maxFileSizeBytes?: number;
}

/**
 * Scan the workspace directory for secret/credential patterns.
 *
 * Returns raw SecurityFinding objects without assigned IDs (IDs are assigned
 * by the engine after deduplication/sorting).
 *
 * INVARIANT: No secret values are ever included in returned findings.
 */
export async function scanForSecrets(
  workspacePath: string,
  options: SecretScannerOptions = {}
): Promise<Omit<SecurityFinding, "id">[]> {
  const maxSize = options.maxFileSizeBytes ?? 512_000; // 500 KB
  const findings: Omit<SecurityFinding, "id">[] = [];

  await walkDirectory(workspacePath, workspacePath, maxSize, findings);

  return findings;
}

// ---------------------------------------------------------------------------
// Directory walker
// ---------------------------------------------------------------------------

async function walkDirectory(
  root: string,
  current: string,
  maxSize: number,
  findings: Omit<SecurityFinding, "id">[]
): Promise<void> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    // Permission denied or not a directory — skip
    return;
  }

  for (const entry of entries) {
    const fullPath = join(current, entry.name);

    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      await walkDirectory(root, fullPath, maxSize, findings);
      continue;
    }

    if (!entry.isFile()) continue;

    const ext = extname(entry.name).toLowerCase();
    const shouldScan =
      SCANNABLE_EXTENSIONS.has(ext) || ALWAYS_SCAN_NAMES.has(entry.name);

    if (!shouldScan) continue;

    // Enforce safe path resolution
    let safePath: string;
    try {
      safePath = safeResolvePath(root, fullPath.slice(root.length + 1));
    } catch (err) {
      if (err instanceof PathTraversalError) continue;
      continue;
    }

    // Size check
    try {
      const info = await stat(safePath);
      if (info.size > maxSize) continue;
    } catch {
      continue;
    }

    // Read and scan
    let content: string;
    try {
      content = await readFile(safePath, "utf8");
    } catch {
      continue;
    }

    const relPath = fullPath.slice(root.length + 1);
    scanFileContent(relPath, content, findings);
  }
}

// ---------------------------------------------------------------------------
// Per-file scanner
// ---------------------------------------------------------------------------

function scanFileContent(
  relativePath: string,
  content: string,
  findings: Omit<SecurityFinding, "id">[]
): void {
  const lines = content.split("\n");

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? "";
    const lineNum = lineIndex + 1;

    // Skip comment lines (simple heuristic)
    const trimmed = line.trimStart();
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*")
    ) {
      // Still check for private key headers which can appear in comments
      if (!trimmed.includes("BEGIN") && !trimmed.includes("PRIVATE KEY")) continue;
    }

    for (const rule of SECRET_RULES) {
      const match = rule.pattern.exec(line);
      if (!match) continue;

      // Extract value for placeholder check
      const valueIdx = rule.valueGroup ?? 0;
      const value = match[valueIdx] ?? match[0] ?? "";

      // Skip placeholder values
      if (isPlaceholder(value)) continue;

      // Skip test/fixture files for lower-severity rules
      if (
        rule.severity === "LOW" &&
        (relativePath.includes(".test.") ||
          relativePath.includes(".spec.") ||
          relativePath.includes("__fixtures__") ||
          relativePath.includes("fixtures"))
      ) {
        continue;
      }

      // Build redacted evidence — never include the actual secret value
      const redacted = redactValue(value);
      const evidence = buildEvidence(relativePath, lineNum, rule.name, redacted);

      // Avoid duplicate finding for the same rule/file/line
      const alreadyFound = findings.some(
        (f) =>
          f.filePath === relativePath &&
          f.line === lineNum &&
          f.title === ruleTitle(rule)
      );
      if (alreadyFound) continue;

      logger.debug("Secret scanner found potential credential", {
        ruleId: rule.id,
        filePath: relativePath,
        line: lineNum,
        severity: rule.severity,
      });

      findings.push({
        category: "SECRET",
        severity: rule.severity,
        title: ruleTitle(rule),
        description: buildDescription(rule, relativePath),
        filePath: relativePath,
        line: lineNum,
        evidence,
        source: "DETERMINISTIC",
        recommendation: rule.recommendation,
      });

      // One finding per line per rule is enough
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlaceholder(value: string): boolean {
  const v = value.trim();
  if (!v || v.length < 4) return true;
  for (const pat of PLACEHOLDER_PATTERNS) {
    if (pat.test(v)) return true;
  }
  return false;
}

/**
 * Redact a secret value for safe inclusion in evidence.
 * Shows only a hint like "sk-****abcd" or just "(redacted)".
 */
function redactValue(value: string): string {
  if (!value || value.length < 4) return "(redacted)";
  const last4 = value.slice(-4);
  return `****${last4}`;
}

function ruleTitle(rule: SecretRule): string {
  return `Potential ${rule.name} detected`;
}

function buildDescription(rule: SecretRule, filePath: string): string {
  return `A ${rule.name.toLowerCase()} pattern was detected in ${filePath}. ` +
    "The actual value has been redacted from this finding.";
}

function buildEvidence(
  filePath: string,
  line: number,
  ruleName: string,
  redacted: string
): string[] {
  return [
    `File: ${filePath} (line ${line})`,
    `Pattern matched: ${ruleName}`,
    `Value hint: ${redacted}`,
  ];
}
