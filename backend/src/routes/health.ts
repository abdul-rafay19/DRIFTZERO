import { Router } from "express";
import type { Router as ExpressRouter } from "express";
import type { HealthResponse, ApiResponse } from "@driftzero/shared";
import { APP_VERSION } from "@driftzero/shared";

const router: ExpressRouter = Router();

router.get("/", (_req, res) => {
  const body: ApiResponse<HealthResponse> = {
    success: true,
    data: {
      status: "ok",
      uptime: process.uptime(),
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
    },
  };
  res.status(200).json(body);
});

export default router;
