import { Router } from "express";
import type { Router as ExpressRouter } from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import type { MigrationJob, ApiResponse } from "@driftzero/shared";
import { ValidationError, NotFoundError } from "@driftzero/shared";

const router: ExpressRouter = Router();

// In-memory store — temporary, Phase 1 only. No database.
const jobs = new Map<string, MigrationJob>();

const createMigrationSchema = z.object({
  repoUrl: z.string().url({ message: "repoUrl must be a valid URL" }),
  sourceVersion: z.literal("express@4", {
    errorMap: () => ({ message: "sourceVersion must be exactly 'express@4'" }),
  }),
  targetVersion: z.literal("express@5", {
    errorMap: () => ({ message: "targetVersion must be exactly 'express@5'" }),
  }),
});

// POST /api/migrations
router.post("/", (req, res, next) => {
  const parsed = createMigrationSchema.safeParse(req.body);

  if (!parsed.success) {
    const message = parsed.error.errors.map((e) => e.message).join("; ");
    return next(new ValidationError(message));
  }

  const { repoUrl, sourceVersion, targetVersion } = parsed.data;
  const id = `mig_${uuidv4().replace(/-/g, "").slice(0, 12)}`;
  const now = new Date().toISOString();

  const job: MigrationJob = {
    id,
    repoUrl,
    sourceVersion,
    targetVersion,
    status: "PENDING",
    currentStage: "PENDING",
    progress: 0,
    createdAt: now,
    updatedAt: now,
  };

  jobs.set(id, job);

  const body: ApiResponse<MigrationJob> = {
    success: true,
    data: job,
  };

  res.status(201).json(body);
});

// GET /api/migrations
router.get("/", (_req, res) => {
  const allJobs = Array.from(jobs.values());
  const body: ApiResponse<MigrationJob[]> = {
    success: true,
    data: allJobs,
  };
  res.status(200).json(body);
});

// GET /api/migrations/:jobId
router.get("/:jobId", (req, res, next) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return next(new NotFoundError("Migration job not found"));
  }

  const body: ApiResponse<MigrationJob> = {
    success: true,
    data: job,
  };

  res.status(200).json(body);
});

export default router;
