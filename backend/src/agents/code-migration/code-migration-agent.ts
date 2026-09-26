/**
 * Code Migration Agent (P9).
 *
 * Executes a P8 MigrationPlan step-by-step against a P3 workspace.
 * Uses IBM Bob to propose structured file changes for each step.
 * DRIFTZERO validates every proposal before applying it.
 *
 * Execution contract per step:
 *   1. Read authorized files from workspace (P3 safe APIs)
 *   2. Build structured prompt (no injection risk)
 *   3. Call Bob (P2 client)
 *   4. Parse + schema-validate Bob's JSON response
 *   5. For each proposed change:
 *      a. Validate path (no traversal, authorized by step)
 *      b. For MODIFY: verify expected content matches current state
 *      c. For CREATE: verify file does not already exist (unless explicitly allowed)
 *      d. Apply via P3 workspace layer
 *   6. Record structured evidence
 *   7. Stop cleanly on failure — no silent continuation
 *
 * DOES NOT:
 *   - Execute shell commands
 *   - Allow Bob to run commands or access the filesystem directly
 *   - Implement recovery (P12)
 *   - Implement validation (P10/P11)
 *   - Commit or push (P20/P21)
 */

import { ValidationError } from "@driftzero/shared";
import type {
  CodeMigrationInput,
  CodeMigrationResult,
  MigrationChange,
  MigrationEvidence,
} from "@driftzero/shared";
import { bobGenerate } from "../../bob/bob-client.js";
import { logger } from "../../utils/logger.js";
import {
  readWorkspaceFile,
  writeWorkspaceFile,
  workspacePathExists,
  safeResolvePath,
} from "../../workspace/files.js";
import { PathTraversalError, WorkspaceFileNotFoundError } from "../../workspace/workspace-errors.js";
import { buildCodeMigrationPrompt } from "../../prompts/code-migration.js";
import {
  codeMigrationInputSchema,
  bobMigrationResponseSchema,
  codeMigrationResultSchema,
} from "./code-migration-types.js";
import {
  MigrationAgentError,
  MigrationResponseParseError,
  MigrationUnauthorizedFileError,
  MigrationExpectedStateMismatchError,
  MigrationStepExecutionError,
} from "./code-migration-errors.js";

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Execute the code migration against a workspace using the P8 plan.
 *
 * Steps are executed in deterministic order (step.order 1, 2, 3…).
 * Each step calls Bob once. Bob's response is validated before application.
 * Execution stops at the first step failure — no silent continuation.
 *
 * @throws {ValidationError}              invalid input (plan or workspace)
 * @throws {MigrationAgentError}          workspace not in READY state
 * @throws {MigrationStepExecutionError}  a step failed during execution
 */
export async function runCodeMigration(input: CodeMigrationInput): Promise<CodeMigrationResult> {
  // 1. Validate the full input at the boundary
  const parsed = codeMigrationInputSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
    throw new ValidationError(message);
  }

  const { workspace, plan } = parsed.data;

  // 2. Workspace must be READY before migration begins
  if (workspace.status !== "READY") {
    throw new MigrationAgentError(
      `Workspace ${workspace.id} is not in READY state (current: ${workspace.status})`
    );
  }

  logger.info("Code migration started", {
    workspaceId: workspace.id,
    packageName: plan.packageName,
    sourceVersion: plan.sourceVersion,
    targetVersion: plan.targetVersion,
    totalSteps: plan.steps.length,
    riskLevel: plan.risk.level,
  });

  const allChanges: MigrationChange[] = [];
  const allEvidence: MigrationEvidence[] = [];
  let completedSteps = 0;
  let failedSteps = 0;

  // 3. Execute steps in deterministic order (already sorted by P8, order 1..N)
  const sortedSteps = [...plan.steps].sort((a, b) => a.order - b.order);

  for (const step of sortedSteps) {
    logger.info("Executing migration step", {
      stepId: step.id,
      order: step.order,
      category: step.category,
      affectedFiles: step.affectedFiles.length,
    });

    try {
      const { changes, evidence } = await executeStep(
        workspace.path,
        workspace.id,
        plan.packageName,
        plan.sourceVersion,
        plan.targetVersion,
        plan.objective,
        step
      );
      allChanges.push(...changes);
      allEvidence.push(...evidence);
      completedSteps++;

      logger.info("Migration step completed", {
        stepId: step.id,
        changesApplied: changes.length,
      });
    } catch (err) {
      failedSteps++;
      const reason =
        err instanceof Error ? err.message : "Unknown error during step execution";

      // Record failure evidence
      for (const f of step.affectedFiles) {
        allEvidence.push({
          stepId: step.id,
          filePath: f,
          operation: "MODIFY",
          status: "FAILED",
          reason: `Step execution failed: ${reason}`,
        });
      }

      logger.error("Migration step failed — stopping execution", {
        stepId: step.id,
        reason,
      });

      // Stop cleanly — do not continue to subsequent steps
      throw new MigrationStepExecutionError(step.id, reason);
    }
  }

  const status = failedSteps === 0 ? "COMPLETED" : "FAILED";

  const rawResult: CodeMigrationResult = {
    workspaceId: workspace.id,
    planSteps: plan.steps.length,
    completedSteps,
    failedSteps,
    status,
    changes: allChanges,
    evidence: allEvidence,
  };

  // Validate result shape (defence-in-depth)
  const validated = codeMigrationResultSchema.safeParse(rawResult);
  if (!validated.success) {
    const issues = validated.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
    logger.error("Code migration result failed schema validation", { issues });
    throw new MigrationAgentError(`Migration result failed validation: ${issues}`);
  }

  logger.info("Code migration completed", {
    workspaceId: workspace.id,
    status,
    completedSteps,
    failedSteps,
    totalChanges: allChanges.length,
  });

  return validated.data;
}

// ---------------------------------------------------------------------------
// Step executor
// ---------------------------------------------------------------------------

async function executeStep(
  workspacePath: string,
  workspaceId: string,
  packageName: string,
  sourceVersion: string,
  targetVersion: string,
  objective: string,
  step: ReturnType<typeof codeMigrationInputSchema.parse>["plan"]["steps"][number]
): Promise<{ changes: MigrationChange[]; evidence: MigrationEvidence[] }> {
  const changes: MigrationChange[] = [];
  const evidence: MigrationEvidence[] = [];

  // --- Collect current file contents for authorized files ---
  const fileContexts: Array<{ filePath: string; content: string }> = [];
  for (const filePath of step.affectedFiles) {
    try {
      const content = await readWorkspaceFile(workspacePath, filePath);
      fileContexts.push({ filePath, content });
    } catch (err) {
      if (err instanceof WorkspaceFileNotFoundError) {
        // File may be CREATE target — include with empty content marker
        fileContexts.push({ filePath, content: "(file does not exist yet)" });
      } else if (err instanceof PathTraversalError) {
        throw new MigrationAgentError(
          `Authorized file "${filePath}" in step ${step.id} has an unsafe path: ${err.message}`
        );
      } else {
        throw err;
      }
    }
  }

  // --- Build prompt ---
  const prompt = buildCodeMigrationPrompt(
    objective,
    step,
    fileContexts,
    packageName,
    sourceVersion,
    targetVersion
  );

  // --- Call Bob ---
  const bobResponse = await bobGenerate({ prompt });

  logger.info("Code migration Bob response received", {
    stepId: step.id,
    durationMs: bobResponse.durationMs,
    responseLength: bobResponse.content.length,
  });

  // --- Parse Bob's response ---
  const rawContent = stripMarkdownFences(bobResponse.content);

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawContent);
  } catch {
    logger.error("Bob returned non-JSON response for code migration step", {
      stepId: step.id,
      contentLength: bobResponse.content.length,
    });
    throw new MigrationResponseParseError(
      `Step ${step.id}: Bob returned a response that could not be parsed as JSON`
    );
  }

  // --- Schema-validate Bob's response ---
  const bobParsed = bobMigrationResponseSchema.safeParse(rawJson);
  if (!bobParsed.success) {
    const issues = bobParsed.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    logger.error("Bob migration response failed schema validation", {
      stepId: step.id,
      issues,
    });
    throw new MigrationResponseParseError(
      `Step ${step.id}: Bob response did not match the ProposedMigrationChange schema: ${issues}`
    );
  }

  const proposedChanges = bobParsed.data.changes;

  // --- Apply each proposed change ---
  for (const proposed of proposedChanges) {
    const { filePath, operation, expectedContent, newContent, explanation } = proposed;

    // (a) Validate path authorization — must be in step.affectedFiles
    if (!step.affectedFiles.includes(filePath)) {
      logger.warn("Bob proposed unauthorized file — rejecting", {
        stepId: step.id,
        filePath,
        authorizedFiles: step.affectedFiles,
      });
      evidence.push({
        stepId: step.id,
        filePath,
        operation,
        status: "REJECTED",
        reason: `File "${filePath}" is not authorized by step ${step.id}`,
      });
      throw new MigrationUnauthorizedFileError(filePath, step.id);
    }

    // (b) Validate path safety via P3 safeResolvePath
    try {
      safeResolvePath(workspacePath, filePath);
    } catch {
      evidence.push({
        stepId: step.id,
        filePath,
        operation,
        status: "REJECTED",
        reason: `Path "${filePath}" failed safety check`,
      });
      throw new MigrationAgentError(
        `Step ${step.id}: path "${filePath}" failed safety validation`
      );
    }

    if (operation === "MODIFY") {
      // (c) Read current file content
      let currentContent: string;
      try {
        currentContent = await readWorkspaceFile(workspacePath, filePath);
      } catch (err) {
        if (err instanceof WorkspaceFileNotFoundError) {
          evidence.push({
            stepId: step.id,
            filePath,
            operation,
            status: "FAILED",
            reason: `File "${filePath}" does not exist — cannot MODIFY`,
          });
          throw new MigrationStepExecutionError(
            step.id,
            `File "${filePath}" does not exist for MODIFY operation`
          );
        }
        throw err;
      }

      // (d) Verify expected content matches actual state
      if (currentContent !== expectedContent) {
        logger.warn("Expected content mismatch — refusing to overwrite", {
          stepId: step.id,
          filePath,
          expectedLength: expectedContent.length,
          actualLength: currentContent.length,
        });
        evidence.push({
          stepId: step.id,
          filePath,
          operation,
          status: "REJECTED",
          reason: `Expected content mismatch for "${filePath}" in step ${step.id}`,
        });
        throw new MigrationExpectedStateMismatchError(filePath, step.id);
      }

      // (e) Apply the change
      await writeWorkspaceFile(workspacePath, filePath, newContent);

      changes.push({ stepId: step.id, filePath, operation, explanation });
      evidence.push({
        stepId: step.id,
        filePath,
        operation,
        status: "APPLIED",
        reason: explanation,
      });
    } else {
      // CREATE
      // (c) Check the file does not already exist
      const exists = await workspacePathExists(workspacePath, filePath);
      if (exists) {
        evidence.push({
          stepId: step.id,
          filePath,
          operation,
          status: "REJECTED",
          reason: `File "${filePath}" already exists — refusing CREATE`,
        });
        throw new MigrationStepExecutionError(
          step.id,
          `CREATE failed: file "${filePath}" already exists`
        );
      }

      // (d) Create the file
      await writeWorkspaceFile(workspacePath, filePath, newContent);

      changes.push({ stepId: step.id, filePath, operation, explanation });
      evidence.push({
        stepId: step.id,
        filePath,
        operation,
        status: "APPLIED",
        reason: explanation,
      });
    }
  }

  return { changes, evidence };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch?.[1] !== undefined) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}
