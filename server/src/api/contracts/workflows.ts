import { z } from "zod";

export const workflowRunStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export const workflowStageRunStatusSchema = z.enum(["pending", "running", "succeeded", "failed", "skipped", "cancelled"]);
export const workflowCheckStatusSchema = z.enum(["pass", "fail", "error"]);
export const workflowLifecycleStateSchema = z.enum(["blocked", "ready", "running", "waiting_input", "verifying"]).nullable();

export const workflowDefinitionCreateSchema = z.object({
  name: z.string().min(1).max(200),
  version: z.number().int().positive(),
  definitionYaml: z.string().min(1)
});

export const workflowDefinitionPatchSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    version: z.number().int().positive().optional(),
    definitionYaml: z.string().min(1).optional()
  })
  .refine((value) => value.name !== undefined || value.version !== undefined || value.definitionYaml !== undefined, {
    message: "At least one field is required"
  });

export const workflowRunStartSchema = z.object({
  workflowDefinitionId: z.string().min(1),
  taskId: z.string().uuid().optional().nullable()
});

export const workflowRunCancelSchema = z.object({
  reason: z.string().min(1).max(1000).optional()
});

export const workflowDefinitionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  version: z.number().int().positive(),
  definitionYaml: z.string(),
  createdByUserId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const workflowCheckResultSchema = z.object({
  id: z.string(),
  stageRunId: z.string(),
  checkName: z.string(),
  status: workflowCheckStatusSchema,
  details: z.unknown(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const workflowEventSchema = z.object({
  id: z.string(),
  eventType: z.string(),
  payload: z.unknown(),
  createdAt: z.string()
});

export const workflowStageDiagnosticsSchema = z.object({
  lifecycleState: workflowLifecycleStateSchema,
  attemptsStarted: z.number().int().nonnegative(),
  blockedBy: z.array(z.string()),
  checks: z.array(workflowCheckResultSchema),
  recentEvents: z.array(workflowEventSchema)
});

export const workflowStageStateSchema = z.object({
  id: z.string(),
  workflowRunId: z.string(),
  stageKey: z.string(),
  ordinal: z.number().int().nonnegative(),
  status: workflowStageRunStatusSchema,
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  diagnostics: workflowStageDiagnosticsSchema
});

export const workflowRunStateSchema = z.object({
  run: z.object({
    id: z.string(),
    workflowDefinitionId: z.string(),
    projectId: z.string(),
    taskId: z.string().nullable(),
    status: workflowRunStatusSchema,
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string()
  }),
  definition: workflowDefinitionSchema,
  stages: z.array(workflowStageStateSchema),
  events: z.array(workflowEventSchema)
});
