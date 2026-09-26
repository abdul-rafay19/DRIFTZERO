/**
 * Test Generation Agent (P10).
 *
 * Consumes the P8 MigrationPlan and P9 CodeMigrationResult, then uses IBM Bob
 * to generate or update test files required by the migration.
 *
 * Execution contract per step:
 *   1. Find relevant test files for this step (P5 affectedTests + affectedFiles TEST category)
 *   2. Read those test files through P3 workspace APIs
 *   3. Build injection-safe prompt with P9 applied changes as context
 *   4. Call IBM Bob (P2 client)
 *   5. Parse + Zod-validate Bob's structured test response
 *   6. For each proposed test change:
 *      a. Validate path (no traversal, must be a test file path)
 *      b. Authorize: must relate to an affected test or be a new test for this step
 *      c. For MODIFY: verify expectedContent matches disk
 *      d. For CREATE: verify file does not already exist
 *      e. Apply via P3 writeWorkspaceFile
 *   7. Record structured TestChangeEvidence
 *   8. Stop cleanly on failure — no silent continuation
 *
 * DOES NOT:
 *   - Execute tests or build commands
 *   - Modify production code (P9's responsibility)
 *   - Implement recovery (P12)
 *   - Commit or push (P20/P21)
 *   - Claim tests pass — only applies test changes
 */

import { ValidationError } from "@driftzero/shared";
import type {
  TestGenerationInput,
  TestGenerationResult,
  TestChange,
  TestChangeEvidence,
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
import { buildTestGenerationPrompt } from "../../prompts/test-generation.js";
import {
  testGenerationInputSchema,
  testGenerationResultSchema,
  bobTestGenerationResponseSchema,
  isTestFilePath,
} from "./test-generation-types.js";
import {
  TestGenerationError,
  TestGenerationParseError,
  UnauthorizedTestFileError,
  TestExpectedStateMismatchError,
  TestChangeApplicationError,
} from "./test-generation-errors.js";

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Execute the test generation agent against a workspace.
 *
 * For each migration step, identifies relevant test files, asks Bob to
 * generate/update tests, validates proposals, and applies them through P3.
 * Execution stops at the first step failure — no silent continuation.
 *
 * @throws {ValidationError}            invalid input
 * @throws {TestGenerationError}        workspace not in READY state
 * @throws {TestChangeApplicationError} a step's test changes could not be applied
 */
export async function runTestGeneration(input: TestGenerationInput): Promise<TestGenerationResult> {
  // 1. Validate the full input at the boundary
  const parsed = testGenerationInputSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
    throw new ValidationError(message);
  }

  const { workspace, plan, migrationResult } = parsed.data;

  // 2. Workspace must be READY
  if (workspace.status !== "READY") {
    throw new TestGenerationError(
      `Workspace ${workspace.id} is not in READY state (current: ${workspace.status})`
    );
  }

  logger.info("Test generation started", {
    workspaceId: workspace.id,
    packageName: plan.packageName,
    sourceVersion: plan.sourceVersion,
    targetVersion: plan.targetVersion,
    planSteps: plan.steps.length,
    p9Changes: migrationResult.changes.length,
  });

  const allChanges: TestChange[] = [];
  const allEvidence: TestChangeEvidence[] = [];
  let appliedTestChanges = 0;
  let failedTestChanges = 0;
  let plannedTestChanges = 0;

  // 3. Execute steps in deterministic order — same as P8/P9
  const sortedSteps = [...plan.steps].sort((a, b) => a.order - b.order);

  for (const step of sortedSteps) {
    // Find P9 changes that belong to this step
    const stepChanges = migrationResult.changes.filter((c) => c.stepId === step.id);

    // Find authorized test files: P5 affectedTests paths + affectedFiles with TEST category
    // The plan doesn't carry P5 data directly, but does carry affectedFiles per step.
    // We rely on: (a) P9 changes already applied for this step, (b) step.affectedFiles
    // which lists the source files affected — tests related to those source files are
    // determined by finding test files that P9 applied changes to (if any are test files),
    // or by letting Bob propose a new test file when no existing one is found.
    //
    // Authorization rule:
    //   MODIFY: filePath must already be a known test file in the workspace that is
    //     related to the step's affected source files (same base name or directory)
    //   CREATE: filePath must match a test file convention and reference the step
    const affectedTestFiles = step.affectedFiles.filter(isTestFilePath);
    const affectedSourceFiles = step.affectedFiles.filter((f) => !isTestFilePath(f));

    // Collect existing test contexts: authorized test files + any step.affectedFiles test paths
    const testFilePathsToRead = [...new Set([
      ...affectedTestFiles,
      // Also find test files by convention for source files (e.g. src/app.ts → src/app.test.ts)
      ...affectedSourceFiles.flatMap(deriveTestCandidates),
    ])];

    const testContexts: Array<{ filePath: string; content: string }> = [];
    for (const tp of testFilePathsToRead) {
      try {
        // Validate path safety before any read
        safeResolvePath(workspace.path, tp);
        const content = await readWorkspaceFile(workspace.path, tp);
        testContexts.push({ filePath: tp, content });
      } catch (err) {
        if (err instanceof WorkspaceFileNotFoundError) {
          testContexts.push({ filePath: tp, content: "(file does not exist yet)" });
        } else if (err instanceof PathTraversalError) {
          // Log and skip unsafe paths from step data
          logger.warn("Skipping unsafe test file path", { filePath: tp, stepId: step.id });
        } else {
          throw err;
        }
      }
    }

    // If no test context at all and no source file changes, skip this step
    if (testContexts.length === 0 && stepChanges.length === 0) {
      logger.debug("Skipping step — no test files and no P9 changes", { stepId: step.id });
      continue;
    }

    logger.info("Executing test generation step", {
      stepId: step.id,
      order: step.order,
      testFiles: testContexts.length,
      p9Changes: stepChanges.length,
    });

    try {
      const { changes, evidence, planned } = await executeTestStep(
        workspace.path,
        workspace.id,
        plan.packageName,
        plan.sourceVersion,
        plan.targetVersion,
        plan.objective,
        step,
        stepChanges,
        testContexts
      );

      allChanges.push(...changes);
      allEvidence.push(...evidence);
      appliedTestChanges += changes.length;
      plannedTestChanges += planned;

      logger.info("Test generation step completed", {
        stepId: step.id,
        changesApplied: changes.length,
      });
    } catch (err) {
      failedTestChanges++;
      const reason = err instanceof Error ? err.message : "Unknown error during test step";

      for (const tc of testContexts) {
        allEvidence.push({
          stepId: step.id,
          filePath: tc.filePath,
          operation: "MODIFY",
          status: "FAILED",
          reason: `Test step execution failed: ${reason}`,
          relatedChangeIds: step.relatedChangeIds,
        });
      }

      logger.error("Test generation step failed — stopping execution", {
        stepId: step.id,
        reason,
      });

      throw new TestChangeApplicationError(step.id, reason);
    }
  }

  const status = failedTestChanges === 0 ? "COMPLETED" : "FAILED";

  const rawResult: TestGenerationResult = {
    workspaceId: workspace.id,
    plannedTestChanges,
    appliedTestChanges,
    failedTestChanges,
    status,
    changes: allChanges,
    evidence: allEvidence,
  };

  const validated = testGenerationResultSchema.safeParse(rawResult);
  if (!validated.success) {
    const issues = validated.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
    logger.error("Test generation result failed schema validation", { issues });
    throw new TestGenerationError(`Test generation result failed validation: ${issues}`);
  }

  logger.info("Test generation completed", {
    workspaceId: workspace.id,
    status,
    appliedTestChanges,
    failedTestChanges,
    plannedTestChanges,
  });

  return validated.data;
}

// ---------------------------------------------------------------------------
// Step executor
// ---------------------------------------------------------------------------

type ParsedPlan = ReturnType<typeof testGenerationInputSchema.parse>["plan"];
type ParsedStep = ParsedPlan["steps"][number];
type ParsedMigrationChange = ReturnType<typeof testGenerationInputSchema.parse>["migrationResult"]["changes"][number];

async function executeTestStep(
  workspacePath: string,
  workspaceId: string,
  packageName: string,
  sourceVersion: string,
  targetVersion: string,
  objective: string,
  step: ParsedStep,
  stepChanges: ParsedMigrationChange[],
  testContexts: Array<{ filePath: string; content: string }>
): Promise<{ changes: TestChange[]; evidence: TestChangeEvidence[]; planned: number }> {
  const changes: TestChange[] = [];
  const evidence: TestChangeEvidence[] = [];

  // Build and send prompt
  const prompt = buildTestGenerationPrompt(
    objective,
    step,
    stepChanges,
    testContexts,
    packageName,
    sourceVersion,
    targetVersion
  );

  const bobResponse = await bobGenerate({ prompt });

  logger.info("Test generation Bob response received", {
    stepId: step.id,
    durationMs: bobResponse.durationMs,
    responseLength: bobResponse.content.length,
  });

  // Parse Bob's response
  const rawContent = stripMarkdownFences(bobResponse.content);

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawContent);
  } catch {
    logger.error("Bob returned non-JSON response for test generation step", {
      stepId: step.id,
      contentLength: bobResponse.content.length,
    });
    throw new TestGenerationParseError(
      `Step ${step.id}: Bob returned a response that could not be parsed as JSON`
    );
  }

  const bobParsed = bobTestGenerationResponseSchema.safeParse(rawJson);
  if (!bobParsed.success) {
    const issues = bobParsed.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
    logger.error("Bob test generation response failed schema validation", { stepId: step.id, issues });
    throw new TestGenerationParseError(
      `Step ${step.id}: Bob test response did not match the ProposedTestChange schema: ${issues}`
    );
  }

  const proposedChanges = bobParsed.data.testChanges;
  const planned = proposedChanges.length;

  // Apply each proposed test change
  for (const proposed of proposedChanges) {
    const { filePath, operation, expectedContent, newContent, explanation, relatedStepId, relatedChangeIds } = proposed;

    // Authorization: must be a recognized test file path (already enforced by proposedTestChangeSchema,
    // but double-checked here in case the schema is ever loosened)
    if (!isTestFilePath(filePath)) {
      logger.warn("Bob proposed non-test file path — rejecting", { stepId: step.id, filePath });
      evidence.push({
        stepId: step.id,
        filePath,
        operation,
        status: "REJECTED",
        reason: `"${filePath}" does not match any recognized test file convention`,
        relatedChangeIds,
      });
      throw new UnauthorizedTestFileError(filePath, step.id);
    }

    // Authorization: must be related to this step's affected files or a step with P9 changes
    const isExistingAffectedTest = testContexts.some((tc) => tc.filePath === filePath);
    const isNewTestForStep = operation === "CREATE" && relatedStepId === step.id && stepChanges.length > 0;
    const isAuthorized = isExistingAffectedTest || isNewTestForStep;

    if (!isAuthorized) {
      logger.warn("Bob proposed test file not related to this step — rejecting", {
        stepId: step.id,
        filePath,
        relatedStepId,
      });
      evidence.push({
        stepId: step.id,
        filePath,
        operation,
        status: "REJECTED",
        reason: `Test file "${filePath}" is not authorized for step ${step.id}`,
        relatedChangeIds,
      });
      throw new UnauthorizedTestFileError(filePath, step.id);
    }

    // Path safety via P3
    try {
      safeResolvePath(workspacePath, filePath);
    } catch {
      evidence.push({
        stepId: step.id,
        filePath,
        operation,
        status: "REJECTED",
        reason: `Path "${filePath}" failed safety check`,
        relatedChangeIds,
      });
      throw new TestGenerationError(`Step ${step.id}: path "${filePath}" failed safety validation`);
    }

    if (operation === "MODIFY") {
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
            reason: `Test file "${filePath}" does not exist — cannot MODIFY`,
            relatedChangeIds,
          });
          throw new TestChangeApplicationError(
            step.id,
            `Test file "${filePath}" does not exist for MODIFY operation`
          );
        }
        throw err;
      }

      if (currentContent !== expectedContent) {
        logger.warn("Expected test content mismatch — refusing to overwrite", {
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
          reason: `Expected content mismatch for test file "${filePath}" in step ${step.id}`,
          relatedChangeIds,
        });
        throw new TestExpectedStateMismatchError(filePath, step.id);
      }

      await writeWorkspaceFile(workspacePath, filePath, newContent);
      changes.push({ stepId: step.id, filePath, operation, explanation, relatedChangeIds });
      evidence.push({ stepId: step.id, filePath, operation, status: "APPLIED", reason: explanation, relatedChangeIds });
    } else {
      // CREATE
      const exists = await workspacePathExists(workspacePath, filePath);
      if (exists) {
        evidence.push({
          stepId: step.id,
          filePath,
          operation,
          status: "REJECTED",
          reason: `Test file "${filePath}" already exists — refusing CREATE`,
          relatedChangeIds,
        });
        throw new TestChangeApplicationError(
          step.id,
          `CREATE failed: test file "${filePath}" already exists`
        );
      }

      await writeWorkspaceFile(workspacePath, filePath, newContent);
      changes.push({ stepId: step.id, filePath, operation, explanation, relatedChangeIds });
      evidence.push({ stepId: step.id, filePath, operation, status: "APPLIED", reason: explanation, relatedChangeIds });
    }
  }

  return { changes, evidence, planned };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive candidate test file paths for a given source file path.
 * E.g. src/app.ts → src/app.test.ts, test/app.test.ts
 */
function deriveTestCandidates(sourcePath: string): string[] {
  const candidates: string[] = [];
  // src/app.ts → src/app.test.ts
  const withTestSuffix = sourcePath.replace(/\.[jt]sx?$/, ".test.ts");
  if (withTestSuffix !== sourcePath) candidates.push(withTestSuffix);
  // src/routes/users.ts → test/routes/users.test.ts
  const inTestDir = `test/${sourcePath.replace(/\.[jt]sx?$/, ".test.ts")}`;
  candidates.push(inTestDir);
  return candidates;
}

function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch?.[1] !== undefined) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}
