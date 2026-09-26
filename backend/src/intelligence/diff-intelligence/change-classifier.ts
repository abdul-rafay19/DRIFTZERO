/**
 * P17 Diff Intelligence — File classifier.
 *
 * Deterministically classifies changed files into categories and derives
 * semantic DiffChangeCategory from available evidence.
 *
 * Classification rules use normalized relative paths only.
 * No filesystem access — operates on path strings.
 *
 * 0 Bob calls. 0 commands.
 */

import { extname, basename, dirname } from "path";
import type { DiffFileCategory, DiffChangeCategory } from "@driftzero/shared";

// ---------------------------------------------------------------------------
// File category classification
// ---------------------------------------------------------------------------

/** Test file name patterns */
const TEST_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /\/__tests__\//,
  /\/test\//,
  /\/tests\//,
  /\/fixtures\//,
  /^test\//,
  /^tests\//,
];

/** Dependency file exact names */
const DEPENDENCY_NAMES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
]);

/** Config file patterns */
const CONFIG_PATTERNS = [
  /tsconfig.*\.json$/,
  /\.config\.[jt]sx?$/,
  /\.config\.m[jt]s$/,
  /\.eslintrc/,
  /\.prettierrc/,
  /\.babelrc/,
  /jest\.config/,
  /vitest\.config/,
  /webpack\.config/,
  /vite\.config/,
  /rollup\.config/,
  /next\.config/,
  /tailwind\.config/,
  /postcss\.config/,
  /^\.env\./,
  /^\.env$/,
  /Dockerfile/,
  /docker-compose/,
  /\.gitignore$/,
  /\.npmrc$/,
  /\.nvmrc$/,
];

/** Documentation file extensions */
const DOC_EXTENSIONS = new Set([".md", ".txt", ".rst", ".adoc", ".asciidoc"]);
const DOC_NAMES = new Set(["README", "CHANGELOG", "LICENSE", "CONTRIBUTING", "AUTHORS", "NOTICE"]);

/**
 * Classify a file path into a broad DiffFileCategory.
 * Uses normalized relative path.
 */
export function classifyFile(relPath: string): DiffFileCategory {
  const norm = relPath.replace(/\\/g, "/");
  const name = basename(norm);
  const ext = extname(norm).toLowerCase();
  const nameWithoutExt = name.replace(/\.[^.]+$/, "");

  // Dependency files
  if (DEPENDENCY_NAMES.has(name)) return "DEPENDENCY";

  // Test files (check before source)
  for (const pat of TEST_PATTERNS) {
    if (pat.test(norm)) return "TEST";
  }

  // Documentation
  if (DOC_EXTENSIONS.has(ext)) return "DOCUMENTATION";
  if (DOC_NAMES.has(nameWithoutExt.toUpperCase())) return "DOCUMENTATION";

  // Configuration
  for (const pat of CONFIG_PATTERNS) {
    if (pat.test(norm)) return "CONFIG";
  }

  // Source files
  const SOURCE_EXTENSIONS = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ]);
  if (SOURCE_EXTENSIONS.has(ext)) return "SOURCE";

  return "OTHER";
}

// ---------------------------------------------------------------------------
// Semantic category derivation
// ---------------------------------------------------------------------------

/**
 * Derive a semantic DiffChangeCategory from available evidence:
 *  1. P8 step category (if correlated)
 *  2. File path patterns (fallback)
 *
 * Only uses existing evidence — never invents relationships.
 */
export function deriveChangeCategory(
  relPath: string,
  fileCategory: DiffFileCategory,
  planStepCategories: string[]
): DiffChangeCategory {
  // Explicit plan step category takes priority
  if (planStepCategories.length > 0) {
    const first = planStepCategories[0]!.toUpperCase();
    switch (first) {
      case "DEPENDENCY": return "DEPENDENCY";
      case "API": return "API";
      case "MIDDLEWARE": return "MIDDLEWARE";
      case "ROUTE": return "ROUTE";
      case "CONFIG": return "CONFIGURATION";
      case "TEST": return "TEST";
    }
  }

  // Fallback: derive from file category
  switch (fileCategory) {
    case "DEPENDENCY": return "DEPENDENCY";
    case "TEST": return "TEST";
    case "CONFIG": return "CONFIGURATION";
    case "DOCUMENTATION": return "OTHER";
    default: break;
  }

  // Fallback: path-based heuristics
  const norm = relPath.replace(/\\/g, "/").toLowerCase();

  if (norm.includes("/routes/") || norm.includes("/route/")) return "ROUTE";
  if (norm.includes("/middleware/") || norm.includes("/middlewares/")) return "MIDDLEWARE";
  if (
    norm.includes("/api/") ||
    norm.includes("/controllers/") ||
    norm.includes("/handlers/")
  ) return "API";

  return "SOURCE";
}

// ---------------------------------------------------------------------------
// Path safety check — rejects paths that would escape workspace
// ---------------------------------------------------------------------------

/**
 * Return true if the path looks safe to analyze.
 * Rejects: absolute paths, ../ sequences, .git/ paths, empty strings.
 */
export function isPathSafe(relPath: string): boolean {
  if (!relPath || !relPath.trim()) return false;
  if (relPath.startsWith("/")) return false;
  if (relPath.includes("../")) return false;
  if (relPath.startsWith(".git/") || relPath === ".git") return false;
  if (relPath.startsWith("\\")) return false;
  return true;
}
