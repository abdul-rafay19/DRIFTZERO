/**
 * POST /api/bob/test
 *
 * Internal integration-proof endpoint for IBM Bob.
 * Sends a user-provided prompt to Bob Shell and returns the normalized response.
 *
 * This endpoint is NOT connected to migration jobs.
 * It exists solely to verify that BOB_API_KEY, Bob Shell, and the inference
 * pipeline are correctly wired.
 *
 * Security: BOB_API_KEY is never included in any response body or log.
 */

import { Router } from "express";
import type { Router as ExpressRouter } from "express";
import { z } from "zod";
import type { ApiResponse } from "@driftzero/shared";
import { ValidationError } from "@driftzero/shared";
import { bobGenerate } from "../bob/bob-client.js";
import type { BobResponse } from "../bob/bob-types.js";

const router: ExpressRouter = Router();

const testSchema = z.object({
  prompt: z
    .string()
    .min(1, "prompt must not be empty")
    .max(4000, "prompt must not exceed 4000 characters"),
});

/**
 * POST /api/bob/test
 *
 * Request body:
 *   { "prompt": "Reply with exactly: DRIFTZERO_BOB_OK" }
 *
 * Response 200:
 *   { "success": true, "data": { "content": "...", "durationMs": 1234 } }
 *
 * Response 400: validation error
 * Response 500: BOB_API_KEY not configured
 * Response 502: Bob Shell authentication failure or inference error
 * Response 504: timeout
 */
router.post("/test", async (req, res, next) => {
  const parsed = testSchema.safeParse(req.body);
  if (!parsed.success) {
    const message = parsed.error.errors.map((e) => e.message).join("; ");
    return next(new ValidationError(message));
  }

  try {
    const response = await bobGenerate({ prompt: parsed.data.prompt });

    const body: ApiResponse<BobResponse> = {
      success: true,
      data: response,
    };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
});

export default router;
