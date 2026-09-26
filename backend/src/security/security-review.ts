/**
 * P15 IBM Bob Security Review integration.
 *
 * Calls the Bob client, validates output with Zod, and normalizes findings.
 *
 * Key invariants:
 *  - Bob findings are ALWAYS marked source = "BOB".
 *  - Bob cannot override or delete deterministic findings.
 *  - Malformed Bob output → structured "AI review unavailable" note; deterministic
 *    findings are unaffected.
 *  - No secret values are sent to Bob or returned from Bob.
 *  - Prompt injection protection is enforced in the prompt builder.
 */

import { bobGenerate } from "../bob/bob-client.js";
import type { BobRequest } from "../bob/bob-types.js";
import {
  BobConfigurationError,
  BobAuthenticationError,
  BobTimeoutError,
  BobInferenceError,
} from "../bob/bob-errors.js";
import { logger } from "../utils/logger.js";
import type {
  SecurityFinding,
  MigrationPlan,
  MigrationChange,
  UnexpectedChangeDetectionResult,
} from "@driftzero/shared";
import {
  bobSecurityReviewOutputSchema,
  type BobSecurityFinding,
} from "./security-types.js";
import { buildSecurityReviewPrompt, type SecurityFileContext } from "../prompts/security-review.js";

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export interface SecurityReviewResult {
  /** Normalized findings from Bob (source = "BOB"). */
  findings: Omit<SecurityFinding, "id">[];
  /**
   * COMPLETED — Bob responded with valid output
   * UNAVAILABLE — Bob not configured or timed out
   * FAILED — Bob produced invalid/unparsable output
   */
  status: "COMPLETED" | "UNAVAILABLE" | "FAILED";
  reason?: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run Bob's optional security review.
 *
 * Never throws — returns structured result even on Bob failure.
 */
export async function runBobSecurityReview(
  plan: MigrationPlan,
  migrationChanges: MigrationChange[],
  deterministicFindings: SecurityFinding[],
  fileContexts: SecurityFileContext[],
  unexpectedChanges?: UnexpectedChangeDetectionResult
): Promise<SecurityReviewResult> {
  const start = Date.now();

  const prompt = buildSecurityReviewPrompt(
    plan,
    migrationChanges,
    deterministicFindings,
    fileContexts,
    unexpectedChanges
  );

  const request: BobRequest = { prompt };

  let bobResponse: { content: string; durationMs: number } | undefined;
  try {
    bobResponse = await bobGenerate(request);
    if (!bobResponse || typeof bobResponse.content !== "string") {
      return {
        findings: [],
        status: "UNAVAILABLE",
        reason: "IBM Bob returned an unexpected response",
        durationMs: Date.now() - start,
      };
    }
  } catch (err) {
    const durationMs = Date.now() - start;
    if (
      err instanceof BobConfigurationError ||
      err instanceof BobAuthenticationError
    ) {
      logger.warn("Bob security review unavailable (configuration/auth)", {
        reason: (err as Error).message,
      });
      return {
        findings: [],
        status: "UNAVAILABLE",
        reason: "IBM Bob is not configured for security review",
        durationMs,
      };
    }
    if (err instanceof BobTimeoutError) {
      logger.warn("Bob security review timed out");
      return {
        findings: [],
        status: "UNAVAILABLE",
        reason: "IBM Bob security review timed out",
        durationMs,
      };
    }
    if (err instanceof BobInferenceError) {
      logger.warn("Bob security review inference error", {
        reason: (err as Error).message,
      });
      return {
        findings: [],
        status: "UNAVAILABLE",
        reason: "IBM Bob inference failed",
        durationMs,
      };
    }
    logger.error("Bob security review unexpected error");
    return {
      findings: [],
      status: "UNAVAILABLE",
      reason: "Unexpected Bob error",
      durationMs,
    };
  }

  // Strip markdown fences if present (bobResponse is guaranteed non-undefined here)
  const raw = stripMarkdownFences(bobResponse!.content);

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn("Bob security review output is not valid JSON");
    return {
      findings: [],
      status: "FAILED",
      reason: "Bob security review response was not valid JSON",
      durationMs: Date.now() - start,
    };
  }

  // Validate with Zod
  const validated = bobSecurityReviewOutputSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    logger.warn("Bob security review output failed schema validation", { issues });
    return {
      findings: [],
      status: "FAILED",
      reason: `Bob security review output schema invalid: ${issues}`,
      durationMs: Date.now() - start,
    };
  }

  const findings = validated.data.findings.map((f) =>
    normalizeBobFinding(f)
  );

  logger.info("Bob security review completed", {
    findingCount: findings.length,
    durationMs: Date.now() - start,
  });

  return {
    findings,
    status: "COMPLETED",
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Normalize Bob finding → SecurityFinding (without ID, source = BOB)
// ---------------------------------------------------------------------------

function normalizeBobFinding(
  f: BobSecurityFinding
): Omit<SecurityFinding, "id"> {
  return {
    category: f.category,
    severity: f.severity,
    title: f.title.slice(0, 200),
    description: f.description.slice(0, 1000),
    filePath: f.filePath,
    line: f.line,
    // Sanitize evidence — truncate each item, no raw secrets allowed by contract
    evidence: (f.evidence ?? []).map((e) => e.slice(0, 500)),
    source: "BOB",
    recommendation: f.recommendation?.slice(0, 500),
  };
}

// ---------------------------------------------------------------------------
// Strip markdown code fences
// ---------------------------------------------------------------------------

function stripMarkdownFences(content: string): string {
  return content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}
