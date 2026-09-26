/**
 * POST /api/security
 *
 * Executes the P15 Security Engine.
 * Runs deterministic secret scanning, dependency audit, code/config analysis,
 * and an optional IBM Bob security review.
 *
 * P15 produces findings — it does NOT block the migration (that is P16's job).
 */

import { Router } from "express";
import type { Router as ExpressRouter } from "express";
import type { ApiResponse, SecurityScanResult } from "@driftzero/shared";
import { ValidationError } from "@driftzero/shared";
import {
  runSecurityScan,
  securityScanInputSchema,
} from "../security/index.js";

const router: ExpressRouter = Router();

/**
 * POST /api/security
 *
 * Request:  SecurityScanInput
 * Response 201: { success: true, data: SecurityScanResult }
 * Response 400: validation error
 * Response 422: workspace not READY
 */
router.post("/", async (req, res, next) => {
  const parsed = securityScanInputSchema.safeParse(req.body);
  if (!parsed.success) {
    const message = parsed.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    return next(new ValidationError(message));
  }

  try {
    const result = await runSecurityScan(parsed.data);
    const body: ApiResponse<SecurityScanResult> = { success: true, data: result };
    res.status(201).json(body);
  } catch (err) {
    next(err);
  }
});

export default router;
