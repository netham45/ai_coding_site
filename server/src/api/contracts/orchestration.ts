import { z } from "zod";

export const nodeTierSchema = z.enum(["epoch", "phase", "plan", "task", "exec"]);

export const replanStateSchema = z.object({
  maxIterations: z.number().int().nonnegative(),
  iterationsUsed: z.number().int().nonnegative(),
  remainingIterations: z.number().int().nonnegative(),
  budgetOverride: z.boolean(),
  gapHashesSeen: z.array(z.string())
});

export const orchestrationControlsSchema = z.object({
  autoMode: z.boolean(),
  replan: replanStateSchema
});

export const dependencyGraphNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  mode: z.enum(["execution", "plan"]),
  status: z.string(),
  tier: nodeTierSchema,
  dependencyCount: z.number().int().nonnegative()
});

export const dependencyGraphEdgeSchema = z.object({
  fromId: z.string(),
  fromTier: nodeTierSchema,
  toId: z.string(),
  toTier: nodeTierSchema,
  toStatus: z.string().nullable(),
  unresolved: z.boolean(),
  reason: z.string().nullable()
});

export const nodeStartInputSchema = z.object({
  autoMode: z.boolean().optional()
});

export const nodeAutoModeInputSchema = z.object({
  enabled: z.boolean()
});

export const nodeAutoMergeInputSchema = z.object({
  enabled: z.boolean(),
  onComplete: z.boolean().optional()
});

export const forceReReviewInputSchema = z.object({
  reason: z.string().min(1).max(1000).optional()
});

export const approveBudgetOverrideInputSchema = z.object({
  reason: z.string().min(1).max(1000).optional(),
  enabled: z.boolean().optional()
});
