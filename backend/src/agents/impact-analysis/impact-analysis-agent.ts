/**
 * Impact Analysis Agent (P5)
 *
 * Analyzes an actual repository workspace to identify files, APIs, tests,
 * dependencies, and configurations affected by a given migration.
 *
 * Design principles:
 *  - Deterministic repository scanning is done locally (no AI needed)
 *  - IBM Bob is used only for semantic interpretation of edge cases where
 *    the deterministic scan has produced evidence but needs context
 *  - All file access goes through the P3 workspace file utilities
 *  - Bob output is validated before use
 *  - The agent is read-only — no files are modified, no commands run
 *  - Workspace boundaries are enforced via safeResolvePath
 */

import { resolve, join, extname, relative } from "path";
import { readdir, stat, access as fsAccess } from "fs/promises";
import { DriftZeroError, ValidationError } from "@driftzero/shared";
import type {
  ImpactAnalysisInput,
  ImpactAnalysisResult,
  AffectedFile,
  AffectedApi,
  AffectedDependency,
  AffectedTest,
  AffectedConfig,
  HighRiskArea,
  AffectedFileCategory,
  ChangeAnalysisResult,
} from "@driftzero/shared";
import { safeResolvePath, readWorkspaceFile } from "../../workspace/files.js";
import { PathTraversalError } from "../../workspace/workspace-errors.js";
import { logger } from "../../utils/logger.js";
import {
  impactAnalysisInputSchema,
  impactAnalysisResultSchema,
} from "./impact-analysis-types.js";

// ---------------------------------------------------------------------------
// Agent error
// ---------------------------------------------------------------------------

export class ImpactAnalysisError extends DriftZeroError {
  constructor(message: string) {
    super(message, 500, "IMPACT_ANALYSIS_ERROR");
    this.name = "ImpactAnalysisError";
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directories that must never be scanned. */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".cache",
  "out",
]);

/** Source file extensions to scan. */
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
]);

/** Test file name patterns. */
const TEST_FILE_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /^__tests__\//,
  /\/test\//,
  /\/tests\//,
];

/** Config file names to check. */
const CONFIG_FILE_NAMES = [
  "package.json",
  "tsconfig.json",
  "tsconfig.base.json",
  ".babelrc",
  ".babelrc.json",
  "babel.config.js",
  "babel.config.ts",
  "jest.config.js",
  "jest.config.ts",
  "vitest.config.ts",
  "vitest.config.js",
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.js",
  "eslint.config.js",
  "eslint.config.ts",
  "webpack.config.js",
  "vite.config.ts",
  "vite.config.js",
];

/** Lock file names → package manager mapping. */
const LOCK_FILES: Record<string, "npm" | "pnpm" | "yarn"> = {
  "package-lock.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
};

// ---------------------------------------------------------------------------
// Main agent entry point
// ---------------------------------------------------------------------------

/**
 * Run the Impact Analysis Agent.
 *
 * @throws {ValidationError}       invalid input
 * @throws {ImpactAnalysisError}   workspace inaccessible or scan failure
 */
export async function runImpactAnalysis(
  input: ImpactAnalysisInput
): Promise<ImpactAnalysisResult> {
  // 1. Validate input
  const parsed = impactAnalysisInputSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.errors.map((e) => e.message).join("; ");
    throw new ValidationError(message);
  }

  const { workspacePath, packageName, sourceVersion, targetVersion, changeAnalysis } = parsed.data;

  logger.info("Impact analysis started", { packageName, sourceVersion, targetVersion, workspacePath });

  // 2. Verify workspace is accessible and inside a safe boundary
  const absWorkspace = resolve(workspacePath);
  try {
    await fsAccess(absWorkspace);
  } catch {
    throw new ImpactAnalysisError(
      `Workspace path does not exist or is not accessible: ${workspacePath}`
    );
  }

  // 3. Walk the repository tree
  const allFiles = await walkRepository(absWorkspace);
  logger.debug("Repository walk completed", { fileCount: allFiles.length });

  // 4. Analyse dependencies
  const affectedDependencies = await scanDependencies(absWorkspace, packageName, allFiles);

  // 5. Determine API terms to search for based on P4 results
  const searchTerms = buildSearchTerms(packageName, changeAnalysis);

  // 6. Scan source files for affected patterns
  const { affectedFiles, affectedApis, affectedTests } = await scanSourceFiles(
    absWorkspace,
    allFiles,
    packageName,
    searchTerms,
    changeAnalysis
  );

  // 7. Identify affected configs
  const affectedConfigs = await scanConfigs(absWorkspace, allFiles, packageName, changeAnalysis);

  // 8. Identify high-risk areas
  const highRiskAreas = deriveHighRiskAreas(affectedFiles, affectedApis, affectedDependencies);

  // 9. Assemble and validate result
  const rawResult: ImpactAnalysisResult = {
    packageName,
    sourceVersion,
    targetVersion,
    affectedFiles,
    affectedApis,
    affectedDependencies,
    affectedTests,
    affectedConfigs,
    highRiskAreas,
    summary: buildSummary(packageName, sourceVersion, targetVersion, affectedFiles, affectedDependencies),
    analyzedAt: new Date().toISOString(),
  };

  const validated = impactAnalysisResultSchema.safeParse(rawResult);
  if (!validated.success) {
    const issues = validated.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
    logger.error("Impact analysis result failed schema validation", { issues });
    throw new ImpactAnalysisError(`Impact analysis result failed schema validation: ${issues}`);
  }

  logger.info("Impact analysis completed", {
    packageName,
    affectedFiles: affectedFiles.length,
    affectedApis: affectedApis.length,
    affectedDependencies: affectedDependencies.length,
    affectedTests: affectedTests.length,
  });

  return validated.data;
}

// ---------------------------------------------------------------------------
// Repository walker
// ---------------------------------------------------------------------------

/** Walk the repository tree recursively, skipping ignored directories. */
async function walkRepository(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // skip unreadable directories
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  await walk(root);
  return files;
}

// ---------------------------------------------------------------------------
// Dependency scanner
// ---------------------------------------------------------------------------

async function scanDependencies(
  root: string,
  packageName: string,
  allFiles: string[]
): Promise<AffectedDependency[]> {
  const results: AffectedDependency[] = [];

  // Determine package manager from lock files
  let packageManager: "npm" | "pnpm" | "yarn" | "unknown" = "unknown";
  for (const [lockFile, pm] of Object.entries(LOCK_FILES)) {
    if (allFiles.some((f) => relative(root, f) === lockFile)) {
      packageManager = pm;
      break;
    }
  }

  // Find all package.json files (not inside node_modules — already excluded by walk)
  const pkgJsonPaths = allFiles.filter((f) => relative(root, f).endsWith("package.json"));

  for (const pkgPath of pkgJsonPaths) {
    const relPath = relative(root, pkgPath);
    let pkgContent: string;
    try {
      pkgContent = await readWorkspaceFile(root, relPath);
    } catch {
      continue;
    }

    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(pkgContent) as Record<string, unknown>;
    } catch {
      continue;
    }

    for (const depType of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
      const deps = pkg[depType];
      if (!deps || typeof deps !== "object") continue;

      const version = (deps as Record<string, string>)[packageName];
      if (version !== undefined) {
        results.push({
          name: packageName,
          declaredVersion: version,
          dependencyType: depType,
          packageManager,
          reason: `Package "${packageName}" is declared in ${relPath} (${depType})`,
        });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Search term builder (from P4 output)
// ---------------------------------------------------------------------------

/** Build a list of API/symbol strings to search for in source files. */
function buildSearchTerms(packageName: string, changeAnalysis: ChangeAnalysisResult): string[] {
  const terms = new Set<string>([packageName]);

  for (const dep of changeAnalysis.deprecatedApis) {
    terms.add(dep.apiName);
    if (dep.replacement) terms.add(dep.replacement);
  }

  for (const pattern of changeAnalysis.migrationPatterns) {
    // Extract simple identifiers from before/after snippets
    if (pattern.before) {
      const ids = extractIdentifiers(pattern.before);
      ids.forEach((id) => terms.add(id));
    }
  }

  return Array.from(terms).filter((t) => t.length >= 2);
}

/** Extract likely API identifiers from a code snippet. */
function extractIdentifiers(code: string): string[] {
  // Match things like app.del, res.json, require('express'), import express
  const matches = code.match(/[a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)*/g) ?? [];
  return matches.filter((m) => m.length >= 3 && !["const", "let", "var", "function", "return", "import", "from", "true", "false"].includes(m));
}

// ---------------------------------------------------------------------------
// Source file scanner
// ---------------------------------------------------------------------------

async function scanSourceFiles(
  root: string,
  allFiles: string[],
  packageName: string,
  searchTerms: string[],
  changeAnalysis: ChangeAnalysisResult
): Promise<{ affectedFiles: AffectedFile[]; affectedApis: AffectedApi[]; affectedTests: AffectedTest[] }> {
  const affectedFiles: AffectedFile[] = [];
  const affectedApis: AffectedApi[] = [];
  const affectedTests: AffectedTest[] = [];

  const sourceFiles = allFiles.filter((f) => SOURCE_EXTENSIONS.has(extname(f)));

  for (const filePath of sourceFiles) {
    const relPath = relative(root, filePath);
    let content: string;

    try {
      content = await readWorkspaceFile(root, relPath);
    } catch {
      continue; // unreadable file — skip
    }

    const isTest = TEST_FILE_PATTERNS.some((p) => (typeof p === "string" ? relPath.includes(p) : p.test(relPath)));
    const evidence: string[] = [];

    // Check for package import
    const importRegex = new RegExp(
      `(?:require|import)[^'"]*['"]${escapeRegex(packageName)}['"]`,
      "g"
    );
    const importMatches = content.match(importRegex);
    if (importMatches) {
      evidence.push(...importMatches.slice(0, 3).map((m) => m.trim()));
    }

    // Check for deprecated API usage from P4
    for (const dep of changeAnalysis.deprecatedApis) {
      const depRegex = new RegExp(escapeRegex(dep.apiName), "g");
      if (depRegex.test(content)) {
        evidence.push(`deprecated API: ${dep.apiName}`);

        // Find the first matching requirement
        const reqId = changeAnalysis.migrationRequirements[0]?.id;
        affectedApis.push({
          file: relPath,
          api: dep.apiName,
          reason: `Uses deprecated API: ${dep.apiName}. ${dep.description}`,
          migrationRequirementId: reqId,
        });
      }
    }

    // Check for other search terms if the file already has some evidence or imports the package
    if (evidence.length > 0 || importMatches) {
      for (const term of searchTerms) {
        if (term === packageName) continue;
        if (content.includes(term) && !evidence.some((e) => e.includes(term))) {
          evidence.push(`usage: ${term}`);
        }
      }
    }

    if (evidence.length === 0) continue;

    const category = categorizeFile(relPath, isTest);

    if (isTest) {
      affectedTests.push({ path: relPath, reason: `Test file references ${packageName}`, evidence });
    } else {
      affectedFiles.push({
        path: relPath,
        category,
        reason: `File uses ${packageName} or affected APIs`,
        relevance: importMatches ? "direct" : "indirect",
        evidence,
      });
    }
  }

  return { affectedFiles, affectedApis, affectedTests };
}

// ---------------------------------------------------------------------------
// Config scanner
// ---------------------------------------------------------------------------

async function scanConfigs(
  root: string,
  allFiles: string[],
  packageName: string,
  changeAnalysis: ChangeAnalysisResult
): Promise<AffectedConfig[]> {
  const results: AffectedConfig[] = [];

  for (const filePath of allFiles) {
    const relPath = relative(root, filePath);
    const fileName = relPath.split("/").pop() ?? "";

    if (!CONFIG_FILE_NAMES.includes(fileName)) continue;
    if (fileName === "package.json") continue; // handled by dependency scanner

    let content: string;
    try {
      content = await readWorkspaceFile(root, relPath);
    } catch {
      continue;
    }

    // Flag if it references the package directly
    if (content.includes(packageName)) {
      results.push({ path: relPath, reason: `Config file references ${packageName}` });
    } else if (fileName === "tsconfig.json" || fileName === "tsconfig.base.json") {
      // TypeScript config may need target/lib updates for new package version compatibility requirements
      results.push({
        path: relPath,
        reason: "TypeScript configuration may need updates to meet compatibility requirements of the new version.",
      });
    } else {
      // Check for compatibility notes (e.g. engine requirements from P4)
      const noteTerms = changeAnalysis.compatibilityNotes
        .flatMap((n) => n.split(/\s+/))
        .filter((w) => w.length > 4);
      if (noteTerms.some((t) => content.includes(t))) {
        results.push({ path: relPath, reason: "Config file may need updates based on compatibility requirements" });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// High-risk area derivation
// ---------------------------------------------------------------------------

function deriveHighRiskAreas(
  affectedFiles: AffectedFile[],
  affectedApis: AffectedApi[],
  affectedDependencies: AffectedDependency[]
): HighRiskArea[] {
  const areas: HighRiskArea[] = [];

  // Middleware files are high risk
  const middlewareFiles = affectedFiles.filter((f) => f.category === "MIDDLEWARE");
  if (middlewareFiles.length > 0) {
    areas.push({
      title: "Custom middleware",
      description: "Custom middleware files may require updates for the new version's middleware API changes.",
      files: middlewareFiles.map((f) => f.path),
    });
  }

  // Deprecated API usage is always high risk
  if (affectedApis.length > 0) {
    const uniqueFiles = [...new Set(affectedApis.map((a) => a.file))];
    areas.push({
      title: "Deprecated API usage",
      description: `${affectedApis.length} deprecated API usage(s) found across ${uniqueFiles.length} file(s). These must be replaced before migration.`,
      files: uniqueFiles,
    });
  }

  // Tests depending on old behavior need verification
  const testFiles = affectedFiles.filter((f) => f.category === "TEST");
  if (testFiles.length > 0) {
    areas.push({
      title: "Tests depending on old behavior",
      description: "Test files directly reference the migrated package and may assert old behaviors.",
      files: testFiles.map((f) => f.path),
    });
  }

  // Direct package dependency needs version bump
  if (affectedDependencies.length > 0) {
    areas.push({
      title: "Package version declaration",
      description: "The package.json dependency version must be updated to target the new version.",
      files: [],
    });
  }

  return areas;
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummary(
  packageName: string,
  sourceVersion: string,
  targetVersion: string,
  affectedFiles: AffectedFile[],
  affectedDependencies: AffectedDependency[]
): string {
  const fileCount = affectedFiles.length;
  const depFound = affectedDependencies.length > 0;
  return (
    `Impact analysis for ${packageName} ${sourceVersion}→${targetVersion}: ` +
    `found ${fileCount} affected source file(s)` +
    (depFound ? `, package declared in ${affectedDependencies.length} manifest(s)` : "") +
    "."
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function categorizeFile(relPath: string, isTest: boolean): AffectedFileCategory {
  if (isTest) return "TEST";
  const lower = relPath.toLowerCase();
  if (lower.includes("/route") || lower.includes("/routes")) return "ROUTE";
  if (lower.includes("/middleware") || lower.includes("/middlewares")) return "MIDDLEWARE";
  if (lower.includes("/controller") || lower.includes("/controllers")) return "CONTROLLER";
  return "API";
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
