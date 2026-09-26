import "dotenv/config";
import express from "express";
import cors from "cors";
import { logger } from "./utils/logger.js";
import { errorHandler } from "./middleware/errorHandler.js";
import healthRouter from "./routes/health.js";
import migrationsRouter from "./routes/migrations.js";
import bobRouter from "./routes/bob.js";
import changeAnalysisRouter from "./routes/change-analysis.js";
import impactAnalysisRouter from "./routes/impact-analysis.js";
import riskScoreRouter from "./routes/risk-score.js";
import impactPreviewRouter from "./routes/impact-preview.js";
import migrationPlanRouter from "./routes/migration-plan.js";
import codeMigrationRouter from "./routes/code-migration.js";
import testGenerationRouter from "./routes/test-generation.js";
import validationRouter from "./routes/validation.js";
import recoveryRouter from "./routes/recovery.js";
import recoveryVerificationRouter from "./routes/recovery-verification.js";

const app = express();
const port = process.env["PORT"] ?? "4000";
const frontendUrl = process.env["FRONTEND_URL"] ?? "http://localhost:3000";

// CORS — restrict to frontend origin only
app.use(
  cors({
    origin: frontendUrl,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Body parsing
app.use(express.json());

// Request logging
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// Routes
app.use("/api/health", healthRouter);
app.use("/api/migrations", migrationsRouter);
app.use("/api/bob", bobRouter);
app.use("/api/change-analysis", changeAnalysisRouter);
app.use("/api/impact-analysis", impactAnalysisRouter);
app.use("/api/risk-score", riskScoreRouter);
app.use("/api/impact-preview", impactPreviewRouter);
app.use("/api/migration-plan", migrationPlanRouter);
app.use("/api/code-migration", codeMigrationRouter);
app.use("/api/test-generation", testGenerationRouter);
app.use("/api/validation", validationRouter);
app.use("/api/recovery", recoveryRouter);
app.use("/api/recovery-verification", recoveryVerificationRouter);

// 404 handler for unknown routes
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found",
    code: "NOT_FOUND",
  });
});

// Centralized error middleware — must be after all routes
app.use(errorHandler);

app.listen(port, () => {
  logger.info(`DriftZero backend running on port ${port}`, {
    port,
    nodeEnv: process.env["NODE_ENV"],
    frontendUrl,
  });
});
