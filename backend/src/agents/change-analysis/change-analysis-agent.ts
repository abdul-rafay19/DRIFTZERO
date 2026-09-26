/**
 * Change Analysis Agent
 *
 * Responsibilities:
 *  1. Validate input (packageName, sourceVersion, targetVersion)
 *  2. Build a structured prompt for IBM Bob
 *  3. Call the existing Bob client (P2)
 *  4. Parse and schema-validate Bob's JSON output
 *  5. Return a typed ChangeAnalysisResult
 *
 * This agent does NOT:
 *  - access the filesystem
 *  - execute commands
 *  - read repository files
 *  - modify any code
 *  - perform impact analysis (P5)
 *
 * IBM Bob is the only AI provider used.
 */

import { DriftZeroError } from "@driftzero/shared";
import type {
  ChangeAnalysisInput,
  ChangeAnalysisResult,
} from "@driftzero/shared";
import { bobGenerate } from "../../bob/bob-client.js";
import { logger } from "../../utils/logger.js";
import { buildChangeAnalysisPrompt } from "../../prompts/change-analysis.js";
import {
  changeAnalysisInputSchema,
  changeAnalysisOutputSchema,
} from "./change-analysis-types.js";
import { ValidationError } from "@driftzero/shared";

// ---------------------------------------------------------------------------
// Agent-specific error
// ---------------------------------------------------------------------------

/**
 * Thrown when Bob returns a response that cannot be parsed or fails schema validation.
 * Bob output is untrusted and must always pass validation before use.
 */
export class ChangeAnalysisParseError extends DriftZeroError {
  constructor(message: string) {
    super(message, 502, "CHANGE_ANALYSIS_PARSE_ERROR");
    this.name = "ChangeAnalysisParseError";
  }
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

/**
 * Run the Change Analysis Agent.
 *
 * @param input  packageName, sourceVersion, targetVersion
 * @returns      fully validated ChangeAnalysisResult
 *
 * @throws {ValidationError}           input fails validation
 * @throws {ChangeAnalysisParseError}  Bob response fails JSON parse or schema validation
 * @throws {BobConfigurationError}     BOB_API_KEY not set / bob binary missing
 * @throws {BobAuthenticationError}    invalid API key
 * @throws {BobTimeoutError}           inference timed out
 * @throws {BobInferenceError}         Bob returned empty or error response
 */
export async function runChangeAnalysis(
  input: ChangeAnalysisInput
): Promise<ChangeAnalysisResult> {
  // --- 1. Validate input ---
  const parsed = changeAnalysisInputSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.errors.map((e) => e.message).join("; ");
    throw new ValidationError(message);
  }

  const { packageName, sourceVersion, targetVersion } = parsed.data;

  logger.info("Change analysis started", { packageName, sourceVersion, targetVersion });

  // --- 2. Build prompt ---
  const prompt = buildChangeAnalysisPrompt(packageName, sourceVersion, targetVersion);

  // --- 3. Call Bob ---
  const bobResponse = await bobGenerate({ prompt });

  logger.info("Change analysis Bob response received", {
    durationMs: bobResponse.durationMs,
    responseLength: bobResponse.content.length,
  });

  // --- 4. Extract JSON from Bob's response ---
  // Bob is instructed to return raw JSON, but may occasionally wrap it in fences.
  // We strip markdown fences if present, then parse.
  const rawContent = stripMarkdownFences(bobResponse.content);

  let parsed_json: unknown;
  try {
    parsed_json = JSON.parse(rawContent);
  } catch {
    logger.error("Bob returned non-JSON response for change analysis", {
      contentLength: bobResponse.content.length,
    });
    throw new ChangeAnalysisParseError(
      "Bob returned a response that could not be parsed as JSON. " +
        "This may indicate an unexpected model output format."
    );
  }

  // --- 5. Validate schema ---
  const validated = changeAnalysisOutputSchema.safeParse(parsed_json);
  if (!validated.success) {
    const issues = validated.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    logger.error("Bob response failed schema validation", { issues });
    throw new ChangeAnalysisParseError(
      `Bob response did not match the expected schema: ${issues}`
    );
  }

  const output = validated.data;

  // --- 6. Assemble result ---
  const result: ChangeAnalysisResult = {
    packageName,
    sourceVersion,
    targetVersion,
    summary: output.summary,
    breakingChanges: output.breakingChanges,
    deprecatedApis: output.deprecatedApis,
    behaviorChanges: output.behaviorChanges,
    migrationRequirements: output.migrationRequirements,
    migrationPatterns: output.migrationPatterns,
    compatibilityNotes: output.compatibilityNotes,
    analyzedAt: new Date().toISOString(),
    meta: {
      bobDurationMs: bobResponse.durationMs,
      promptLength: prompt.length,
    },
  };

  logger.info("Change analysis completed", {
    packageName,
    sourceVersion,
    targetVersion,
    breakingChanges: result.breakingChanges.length,
    migrationRequirements: result.migrationRequirements.length,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip markdown code fences from a string if present.
 * Bob may sometimes wrap JSON in ```json ... ``` even when instructed not to.
 */
function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  // Match ```json ... ``` or ``` ... ```
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch?.[1] !== undefined) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}
