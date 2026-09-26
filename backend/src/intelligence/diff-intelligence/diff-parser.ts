/**
 * P17 Diff Intelligence — Git unified diff parser.
 *
 * Parses the output of `git diff` (working tree vs HEAD) into structured
 * per-file records. Uses the actual format returned by P3's gitDiff().
 *
 * Supported input:
 *   diff --git a/... b/...
 *   [similarity index ...]
 *   [rename from ...]
 *   [rename to ...]
 *   [new file mode ...]
 *   [deleted file mode ...]
 *   [Binary files ...]
 *   --- a/path   (or /dev/null for new files)
 *   +++ b/path   (or /dev/null for deleted files)
 *   @@ -old_start,old_count +new_start,new_count @@
 *   [hunk lines...]
 *
 * Invariants:
 *  - Never executes diff content
 *  - Safe on malformed input (skips malformed entries, never crashes)
 *  - Enforces per-file limits on hunks and changed lines
 *  - Marks truncated entries explicitly
 *  - CRLF lines handled by normalizing to LF
 */

import type { DiffHunk, DiffFileAnalysis, DiffFileCategory, DiffChangeType } from "@driftzero/shared";
import { logger } from "../../utils/logger.js";

// ---------------------------------------------------------------------------
// Limits (exported so tests can reference them)
// ---------------------------------------------------------------------------

/** Max total diff bytes accepted before partial analysis. */
export const MAX_DIFF_BYTES = 2_000_000; // 2 MB
/** Max bytes for a single file's diff block. */
export const MAX_FILE_DIFF_BYTES = 200_000; // 200 KB
/** Max hunks per file. */
export const MAX_HUNKS_PER_FILE = 100;
/** Max changed lines captured per file (across all hunks). */
export const MAX_CHANGED_LINES_PER_FILE = 500;
/** Max content length per changed line (after redaction). */
export const MAX_LINE_CONTENT_LENGTH = 200;

// ---------------------------------------------------------------------------
// Internal parsed file record
// ---------------------------------------------------------------------------

export interface ParsedDiffFile {
  filePath: string;
  changeType: DiffChangeType;
  /** For RENAMED files: original path. */
  oldPath?: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  binary: boolean;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parse raw `git diff` output into structured file records.
 *
 * Returns an empty array for empty diffs.
 * Malformed file blocks are skipped with a warning, not crashed.
 */
export function parseDiff(raw: string): ParsedDiffFile[] {
  if (!raw || !raw.trim()) return [];

  // Guard total size
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > MAX_DIFF_BYTES) {
    logger.warn("Diff exceeds maximum size — will parse with truncation", {
      bytes,
      maxBytes: MAX_DIFF_BYTES,
    });
    // Still parse: individual files will be truncated
  }

  // Normalize CRLF to LF
  const normalized = raw.replace(/\r\n/g, "\n");

  // Split into per-file blocks by `diff --git` header
  const blocks = splitIntoFileBlocks(normalized);
  if (blocks.length === 0) return [];

  const results: ParsedDiffFile[] = [];

  for (const block of blocks) {
    try {
      const parsed = parseFileBlock(block);
      if (parsed) results.push(parsed);
    } catch (err) {
      logger.warn("Skipping malformed diff block", {
        reason: err instanceof Error ? err.message : "unknown",
        preview: block.slice(0, 80),
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Split diff string into per-file blocks
// ---------------------------------------------------------------------------

function splitIntoFileBlocks(diff: string): string[] {
  // Each file block starts with "diff --git"
  const blocks: string[] = [];
  const lines = diff.split("\n");
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current.length > 0) {
        blocks.push(current.join("\n"));
      }
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current.join("\n"));

  return blocks;
}

// ---------------------------------------------------------------------------
// Parse a single file block
// ---------------------------------------------------------------------------

function parseFileBlock(block: string): ParsedDiffFile | null {
  const lines = block.split("\n");
  if (lines.length === 0) return null;

  const header = lines[0] ?? "";
  if (!header.startsWith("diff --git ")) return null;

  // Extract paths from the header: diff --git a/PATH b/PATH
  const headerMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(header);
  if (!headerMatch) {
    logger.warn("Cannot parse diff --git header", { header: header.slice(0, 100) });
    return null;
  }

  const aPath = headerMatch[1]!;
  const bPath = headerMatch[2]!;

  // Detect file state
  let changeType: DiffChangeType = "MODIFIED";
  let oldPath: string | undefined;
  let binary = false;
  let isBeyondSizeLimit = false;

  // Scan metadata lines
  let lineIdx = 1;
  while (lineIdx < lines.length) {
    const line = lines[lineIdx] ?? "";

    if (line.startsWith("new file mode")) {
      changeType = "ADDED";
    } else if (line.startsWith("deleted file mode")) {
      changeType = "DELETED";
    } else if (line.startsWith("rename from ")) {
      changeType = "RENAMED";
      oldPath = line.slice("rename from ".length).trim();
    } else if (line.startsWith("rename to ")) {
      // bPath already has destination
    } else if (line.startsWith("Binary files")) {
      binary = true;
    } else if (line.startsWith("--- ") || line.startsWith("@@ ")) {
      break;
    }
    lineIdx++;
  }

  // Safety: check block byte size
  const blockBytes = Buffer.byteLength(block, "utf8");
  if (blockBytes > MAX_FILE_DIFF_BYTES) {
    logger.warn("File diff block exceeds max size — truncating", {
      filePath: bPath,
      blockBytes,
      maxBytes: MAX_FILE_DIFF_BYTES,
    });
    isBeyondSizeLimit = true;
  }

  // Binary file: return early with metadata only
  if (binary) {
    return {
      filePath: bPath,
      changeType,
      ...(changeType === "RENAMED" ? { oldPath } : {}),
      additions: 0,
      deletions: 0,
      hunks: [],
      binary: true,
      truncated: false,
    };
  }

  // Parse hunks
  const { hunks, additions, deletions, truncated } = parseHunks(
    lines,
    lineIdx,
    isBeyondSizeLimit
  );

  // Determine final filePath and oldPath for rename
  const filePath = changeType === "RENAMED" ? bPath : bPath;
  const finalOldPath = changeType === "RENAMED" ? (oldPath ?? aPath) : undefined;

  return {
    filePath,
    changeType,
    ...(finalOldPath ? { oldPath: finalOldPath } : {}),
    additions,
    deletions,
    hunks,
    binary: false,
    truncated: truncated || isBeyondSizeLimit,
  };
}

// ---------------------------------------------------------------------------
// Hunk parsing
// ---------------------------------------------------------------------------

interface HunkParseResult {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  truncated: boolean;
}

function parseHunks(
  lines: string[],
  startIdx: number,
  forcePartial: boolean
): HunkParseResult {
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let truncated = forcePartial;
  let totalChangedLines = 0;

  let i = startIdx;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (!line.startsWith("@@ ")) {
      i++;
      continue;
    }

    // Parse hunk header: @@ -old_start,old_count +new_start,new_count @@
    const hunkHeader = parseHunkHeader(line);
    if (!hunkHeader) {
      logger.warn("Malformed hunk header, skipping", { header: line.slice(0, 80) });
      i++;
      continue;
    }

    if (hunks.length >= MAX_HUNKS_PER_FILE) {
      truncated = true;
      break;
    }

    const hunkLines: string[] = [];
    let hunkAdditions = 0;
    let hunkDeletions = 0;
    i++;

    while (i < lines.length) {
      const hunkLine = lines[i] ?? "";
      if (hunkLine.startsWith("@@ ") || hunkLine.startsWith("diff --git ")) {
        break;
      }

      if (hunkLine.startsWith("+") && !hunkLine.startsWith("+++")) {
        hunkAdditions++;
        additions++;
        totalChangedLines++;
        if (totalChangedLines <= MAX_CHANGED_LINES_PER_FILE) {
          hunkLines.push(safeLineContent(hunkLine));
        } else {
          truncated = true;
        }
      } else if (hunkLine.startsWith("-") && !hunkLine.startsWith("---")) {
        hunkDeletions++;
        deletions++;
        totalChangedLines++;
        if (totalChangedLines <= MAX_CHANGED_LINES_PER_FILE) {
          hunkLines.push(safeLineContent(hunkLine));
        } else {
          truncated = true;
        }
      }
      i++;
    }

    hunks.push({
      oldStart: hunkHeader.oldStart,
      oldCount: hunkHeader.oldCount,
      newStart: hunkHeader.newStart,
      newCount: hunkHeader.newCount,
      lines: hunkLines,
    });
  }

  return { hunks, additions, deletions, truncated };
}

function parseHunkHeader(
  line: string
): { oldStart: number; oldCount: number; newStart: number; newCount: number } | null {
  // @@ -old_start[,old_count] +new_start[,new_count] @@
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) return null;
  return {
    oldStart: parseInt(match[1]!, 10),
    oldCount: match[2] !== undefined ? parseInt(match[2], 10) : 1,
    newStart: parseInt(match[3]!, 10),
    newCount: match[4] !== undefined ? parseInt(match[4], 10) : 1,
  };
}

// ---------------------------------------------------------------------------
// Safe line content — redact obvious secrets, truncate length
// ---------------------------------------------------------------------------

/**
 * Return a safe representation of a changed line.
 * Redacts obvious secret patterns and truncates to MAX_LINE_CONTENT_LENGTH.
 */
export function safeLineContent(line: string): string {
  // Truncate first
  const truncated = line.length > MAX_LINE_CONTENT_LENGTH
    ? line.slice(0, MAX_LINE_CONTENT_LENGTH) + "…"
    : line;

  return redactSecretsInLine(truncated);
}

/**
 * Redact obvious secret-like assignments from a diff line.
 * This is lightweight — P15 is the authoritative secret scanner.
 */
function redactSecretsInLine(line: string): string {
  // Pattern: assignment of a value that looks secret-like
  return line
    // key=value where value looks like a token/secret (long base64/alphanumeric)
    .replace(
      /((?:api[_-]?key|token|secret|password|passwd|pwd|auth[_-]?token|bearer)\s*[=:]\s*["']?)([A-Za-z0-9+/=_\-.]{16,})(["']?)/gi,
      (_, prefix, _secret, suffix) => `${prefix}****${suffix}`
    )
    // AWS access key IDs
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA****")
    // GitHub PAT
    .replace(/\bghp_[A-Za-z0-9_]{20,50}\b/g, "ghp_****")
    // PEM header lines
    .replace(/-----BEGIN\s+\S+\s+PRIVATE KEY-----/, "-----BEGIN **** PRIVATE KEY-----");
}

// ---------------------------------------------------------------------------
// Convert ParsedDiffFile to DiffFileAnalysis (adds category/migration context)
// ---------------------------------------------------------------------------

export function toDiffFileAnalysis(
  pf: ParsedDiffFile,
  category: DiffFileCategory,
  migrationRelated: boolean,
  unexpected: boolean,
  relatedPlanSteps: string[],
  relatedEvidence: string[]
): DiffFileAnalysis {
  return {
    filePath: pf.filePath,
    changeType: pf.changeType,
    ...(pf.oldPath ? { oldPath: pf.oldPath } : {}),
    additions: pf.additions,
    deletions: pf.deletions,
    hunks: pf.hunks.length,
    category,
    migrationRelated,
    unexpected,
    relatedPlanSteps,
    relatedEvidence,
    binary: pf.binary,
    truncated: pf.truncated,
  };
}
