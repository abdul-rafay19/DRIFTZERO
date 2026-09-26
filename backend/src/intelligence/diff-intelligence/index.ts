/**
 * P17 Diff Intelligence — public barrel.
 */

export { runDiffIntelligence } from "./diff-intelligence.js";
export { diffIntelligenceInputSchema } from "./diff-intelligence-types.js";
export { parseDiff, safeLineContent, MAX_DIFF_BYTES, MAX_FILE_DIFF_BYTES, MAX_HUNKS_PER_FILE, MAX_CHANGED_LINES_PER_FILE } from "./diff-parser.js";
export { classifyFile, deriveChangeCategory, isPathSafe } from "./change-classifier.js";
export { correlateFile, buildPlanStepCategoryMap } from "./change-correlation.js";
export {
  DiffInputError,
  DiffWorkspaceError,
  DiffRetrievalError,
  DiffParseError,
  DiffIntelligenceError,
} from "./diff-intelligence-errors.js";
