/**
 * Migration Planner (P8) — Zod schemas, types, and constants.
 *
 * Reuses P4/P5/P6/P7 schemas — nothing is duplicated.
 * P8 is deterministic. No IBM Bob calls. No filesystem access.
 */

import { z } from "zod";
import { changeAnalysisResultSchema } from "../../agents/impact-analysis/impact-analysis-types.js";
import { impactAnalysisResultSchema } from "../../agents/impact-analysis/impact-analysis-types.js";
import { riskScoreResultSchema } from "../../intelligence/risk-score/risk-score-types.js";
import { impactPreviewResultSchema } from "../../intelligence/impact-preview/impact-preview-types.js";

// ---------------------------------------------------------------------------
// Input schema — all four upstream results
// ---------------------------------------------------------------------------

export const migrationPlannerInputSchema = z.object({
  changeAnalysis: changeAnalysisResultSchema,
  impactAnalysis: impactAnalysisResultSchema,
  riskScore: riskScoreResultSchema,
  impactPreview: impactPreviewResultSchema,
});

// ---------------------------------------------------------------------------
// Step category
// ---------------------------------------------------------------------------

export const stepCategorySchema = z.enum([
  "DEPENDENCY",
  "API",
  "MIDDLEWARE",
  "ROUTE",
  "CONTROLLER",
  "TEST",
  "CONFIG",
  "OTHER",
]);

// ---------------------------------------------------------------------------
// Migration step schema
// ---------------------------------------------------------------------------

export const migrationStepSchema = z.object({
  /** Deterministic sequential ID, e.g. STEP-001. */
  id: z.string().regex(/^STEP-\d{3}$/, "step id must match STEP-NNN"),
  /** 1-based execution order. */
  order: z.number().int().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  category: stepCategorySchema,
  /** Relative file paths originating from P5. */
  affectedFiles: z.array(z.string()),
  /** IDs of P4 BreakingChanges or BehaviorChanges related to this step. */
  relatedChangeIds: z.array(z.string()),
  /** IDs of P4 MigrationRequirements related to this step. */
  relatedRequirementIds: z.array(z.string()),
  /** Human-readable rationale for this step. */
  reason: z.string().min(1),
  /** Risk level for this individual step, derived from P6/P7 evidence. */
  risk: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  /** IDs of steps that must complete before this one. */
  dependencies: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Prerequisite schema
// ---------------------------------------------------------------------------

export const migrationPrerequisiteSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  /** Traceability reference (P4 requirement ID, P5 file path, etc.). */
  evidence: z.array(z.string()),
  mandatory: z.boolean(),
});

// ---------------------------------------------------------------------------
// Validation requirement schema
// ---------------------------------------------------------------------------

export const validationRequirementSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  /** Which step(s) this validates, by step ID. */
  relatedStepIds: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Migration plan schema
// ---------------------------------------------------------------------------

export const migrationPlanSchema = z
  .object({
    packageName: z.string().min(1),
    sourceVersion: z.string().min(1),
    targetVersion: z.string().min(1),
    objective: z.string().min(1),
    prerequisites: z.array(migrationPrerequisiteSchema),
    steps: z.array(migrationStepSchema),
    validationRequirements: z.array(validationRequirementSchema),
    affectedAreas: z.array(z.string()),
    risk: z.object({
      score: z.number().int().min(0).max(100),
      level: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    }),
    generatedAt: z.string().min(1),
  })
  .superRefine((plan, ctx) => {
    // Validate unique step IDs
    const ids = plan.steps.map((s) => s.id);
    const unique = new Set(ids);
    if (unique.size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Step IDs must be unique", path: ["steps"] });
    }

    // Validate sequential orders (1, 2, 3, …)
    const orders = plan.steps.map((s) => s.order).sort((a, b) => a - b);
    for (let i = 0; i < orders.length; i++) {
      if (orders[i] !== i + 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Step orders must be sequential starting from 1; got ${JSON.stringify(orders)}`, path: ["steps"] });
        break;
      }
    }

    // Validate dependency references — every dep ID must exist
    const idSet = new Set(ids);
    for (const step of plan.steps) {
      for (const dep of step.dependencies) {
        if (!idSet.has(dep)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Step ${step.id} references unknown dependency ${dep}`, path: ["steps"] });
        }
      }
    }

    // Validate no dependency cycles (DAG check via topological sort)
    if (hasCycle(plan.steps)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Migration plan contains a dependency cycle", path: ["steps"] });
    }

    // Validate validationRequirement step references
    for (const vr of plan.validationRequirements) {
      for (const sid of vr.relatedStepIds) {
        if (!idSet.has(sid)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `ValidationRequirement ${vr.id} references unknown step ${sid}`, path: ["validationRequirements"] });
        }
      }
    }
  });

// ---------------------------------------------------------------------------
// DAG cycle detection — Kahn's algorithm
// ---------------------------------------------------------------------------

/**
 * Returns true if the step dependency graph contains a cycle.
 * Uses Kahn's topological sort algorithm (BFS).
 */
export function hasCycle(steps: Array<{ id: string; dependencies: string[] }>): boolean {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>(); // dep → dependents

  for (const step of steps) {
    if (!inDegree.has(step.id)) inDegree.set(step.id, 0);
    if (!adj.has(step.id)) adj.set(step.id, []);
    for (const dep of step.dependencies) {
      inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
      if (!adj.has(dep)) adj.set(dep, []);
      adj.get(dep)!.push(step.id);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  let processed = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    processed++;
    for (const neighbor of adj.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  return processed !== steps.length;
}
