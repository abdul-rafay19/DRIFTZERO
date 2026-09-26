/**
 * IBM Bob client for DriftZero.
 *
 * This is the ONLY place in the codebase that invokes IBM Bob.
 * All other modules must go through this client — never spawn Bob Shell directly.
 *
 * Integration contract (per official IBM Bob documentation):
 *   - Bob Shell CLI (`bob` binary) is the programmatic inference interface.
 *   - Inference API key: set via BOBSHELL_API_KEY; no extra headers needed.
 *   - General API key:   requires --team-id and --instance-id flags.
 *   - Non-interactive:   `bob --auth-method api-key -p "<prompt>"`
 *   - Output:            stdout text response.
 *
 * @see https://bob.ibm.com/docs/ide/account/api-keys
 * @see https://bob.ibm.com/docs/shell/getting-started/start-bobshell-non-interactive
 */

import { spawn } from "child_process";
import { LLM_TIMEOUT_MS } from "@driftzero/shared";
import { logger } from "../utils/logger.js";
import type { BobRequest, BobResponse } from "./bob-types.js";
import {
  BobAuthenticationError,
  BobConfigurationError,
  BobInferenceError,
  BobTimeoutError,
} from "./bob-errors.js";

/**
 * Reads and validates BOB_API_KEY from the environment.
 * Throws BobConfigurationError if absent or empty.
 * Never logs or returns the key value.
 */
function resolveApiKey(): string {
  const key = process.env["BOB_API_KEY"];
  if (!key || key.trim() === "") {
    throw new BobConfigurationError(
      "BOB_API_KEY is not configured. Set it in backend/.env before using IBM Bob."
    );
  }
  return key;
}

/**
 * Builds the Bob Shell argument list for a non-interactive inference call.
 *
 * Inference key  → no instance/team flags required
 * General key    → caller must provide teamId and instanceId in the request
 */
function buildArgs(request: BobRequest): string[] {
  const args = [
    "--auth-method", "api-key",
    "--hide-intermediary-output",
    "-p", request.prompt,
  ];

  if (request.teamId) {
    args.push("--team-id", request.teamId);
  }
  if (request.instanceId) {
    args.push("--instance-id", request.instanceId);
  }

  return args;
}

/**
 * Send a prompt to IBM Bob via Bob Shell and return the normalized response.
 *
 * @throws {BobConfigurationError}   BOB_API_KEY missing
 * @throws {BobAuthenticationError}  Bob Shell rejects credentials
 * @throws {BobTimeoutError}         No response within LLM_TIMEOUT_MS
 * @throws {BobInferenceError}       Non-zero exit or unexpected response
 */
export async function bobGenerate(request: BobRequest): Promise<BobResponse> {
  // Validate configuration before doing anything else
  const apiKey = resolveApiKey();

  const startTime = Date.now();
  logger.info("Bob inference started", {
    promptLength: request.prompt.length,
    hasTeamId: Boolean(request.teamId),
    hasInstanceId: Boolean(request.instanceId),
  });

  const args = buildArgs(request);

  return new Promise<BobResponse>((resolve, reject) => {
    let settled = false;

    const child = spawn("bob", args, {
      env: {
        ...process.env,
        BOBSHELL_API_KEY: apiKey,
        // Prevent Bob Shell from opening interactive prompts
        CI: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    // Enforce the LLM timeout
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      const elapsed = Date.now() - startTime;
      logger.warn("Bob inference timed out", { timeoutMs: LLM_TIMEOUT_MS, elapsedMs: elapsed });
      reject(new BobTimeoutError());
    }, LLM_TIMEOUT_MS);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const elapsed = Date.now() - startTime;

      // ENOENT = bob binary not found
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        logger.error("Bob Shell binary not found — is `bob` installed and in PATH?", {
          durationMs: elapsed,
        });
        reject(
          new BobConfigurationError(
            "Bob Shell (`bob`) is not installed or not in PATH. Install it from https://bob.ibm.com"
          )
        );
      } else {
        logger.error("Bob Shell process error", { durationMs: elapsed });
        reject(new BobInferenceError("Bob Shell process failed to start"));
      }
    });

    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const elapsed = Date.now() - startTime;
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();

      if (exitCode !== 0) {
        // Classify the failure by inspecting stderr content — never leak the key
        const stderrLower = stderr.toLowerCase();
        const isAuthFailure =
          stderrLower.includes("unauthorized") ||
          stderrLower.includes("invalid api key") ||
          stderrLower.includes("authentication") ||
          stderrLower.includes("403") ||
          stderrLower.includes("401");

        logger.error("Bob Shell exited with non-zero code", {
          exitCode,
          durationMs: elapsed,
          isAuthFailure,
        });

        if (isAuthFailure) {
          reject(new BobAuthenticationError("IBM Bob rejected the API key — check BOB_API_KEY"));
        } else {
          reject(
            new BobInferenceError(
              `Bob Shell exited with code ${exitCode}. Check server logs for details.`
            )
          );
        }
        return;
      }

      if (!stdout) {
        logger.warn("Bob Shell returned empty output", { durationMs: elapsed });
        reject(new BobInferenceError("Bob returned an empty response"));
        return;
      }

      logger.info("Bob inference completed", { durationMs: elapsed });

      resolve({
        content: stdout,
        durationMs: elapsed,
      });
    });
  });
}
