/**
 * IBM Bob integration test script.
 *
 * Usage:
 *   pnpm bob:test
 *   pnpm --filter backend bob:test
 *
 * Requires:
 *   - BOB_API_KEY set in backend/.env (or environment)
 *   - `bob` CLI installed and in PATH
 *
 * This script proves the IBM Bob integration works end-to-end.
 * It is NOT connected to migration logic.
 */

import "dotenv/config";
import { bobGenerate } from "../bob/bob-client.js";
import { BobConfigurationError } from "../bob/bob-errors.js";

const TEST_PROMPT = "Reply with exactly this text and nothing else: DRIFTZERO_BOB_OK";
const EXPECTED_SIGNAL = "DRIFTZERO_BOB_OK";

async function main(): Promise<void> {
  console.log("=== DriftZero — IBM Bob Integration Test ===\n");

  const hasKey = Boolean(process.env["BOB_API_KEY"]?.trim());
  console.log(`BOB_API_KEY present: ${hasKey ? "yes (value hidden)" : "NO — test will fail"}`);
  console.log(`Prompt: "${TEST_PROMPT}"\n`);

  try {
    const response = await bobGenerate({ prompt: TEST_PROMPT });

    console.log("--- Response ---");
    console.log(`Content:    ${response.content}`);
    console.log(`DurationMs: ${response.durationMs}ms`);
    console.log("");

    if (response.content.includes(EXPECTED_SIGNAL)) {
      console.log(`✓ PASS — response contains expected signal "${EXPECTED_SIGNAL}"`);
      process.exit(0);
    } else {
      console.log(`✗ WARN — response did not contain "${EXPECTED_SIGNAL}" but Bob did respond.`);
      console.log("  Integration is working; prompt engineering may need adjustment.");
      process.exit(0);
    }
  } catch (err) {
    if (err instanceof BobConfigurationError) {
      console.error(`\n✗ CONFIGURATION ERROR: ${err.message}`);
      console.error("\nTo fix: set BOB_API_KEY in backend/.env");
      console.error("Create an Inference key at https://bob.ibm.com (Settings > API Keys)");
    } else if (err instanceof Error) {
      console.error(`\n✗ ERROR [${(err as { code?: string }).code ?? err.name}]: ${err.message}`);
    } else {
      console.error("\n✗ Unknown error", err);
    }
    process.exit(1);
  }
}

main();
