import type {
  ApproveBudgetOverridePayload,
  AsyncNodeActionResult,
  CreateNodePayload,
  CreateNodeResponse,
  ForceReReviewPayload,
  GetDependencyGraphResponse,
  GetHierarchyResponse,
  NodeMutationResult,
  OrchestrationNodeDetail,
  SetNodeAutoMergePayload,
  SetNodeAutoModePayload,
  StartNodePayload,
  StartNodeResult,
  WorkflowDefinition,
  WorkflowRunState
} from "./types";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    let message = `Request failed: ${response.status}`;
    try {
      const body = await response.json();
      if (body?.error) {
        message = body.error;
      }
    } catch {
      // ignored
    }
    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export function createNode(projectId: string, payload: CreateNodePayload): Promise<CreateNodeResponse> {
  return api<CreateNodeResponse>(`/api/projects/${projectId}/nodes`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getHierarchy(projectId: string): Promise<GetHierarchyResponse> {
  return api<GetHierarchyResponse>(`/api/projects/${projectId}/hierarchy`);
}

export function getDependencyGraph(projectId: string): Promise<GetDependencyGraphResponse> {
  return api<GetDependencyGraphResponse>(`/api/projects/${projectId}/dependency-graph`);
}

export function getNode(nodeId: string): Promise<OrchestrationNodeDetail> {
  return api<OrchestrationNodeDetail>(`/api/nodes/${nodeId}`);
}

export function startNode(nodeId: string, payload?: StartNodePayload): Promise<StartNodeResult> {
  return api<StartNodeResult>(`/api/nodes/${nodeId}/start`, {
    method: "POST",
    body: JSON.stringify(payload ?? {})
  });
}

export function setNodeAutoMode(nodeId: string, payload: SetNodeAutoModePayload): Promise<NodeMutationResult> {
  return api<NodeMutationResult>(`/api/nodes/${nodeId}/auto-mode`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function setNodeAutoMerge(nodeId: string, payload: SetNodeAutoMergePayload): Promise<NodeMutationResult> {
  return api<NodeMutationResult>(`/api/nodes/${nodeId}/auto-merge`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function forceNodeReReview(nodeId: string, payload?: ForceReReviewPayload): Promise<AsyncNodeActionResult> {
  return api<AsyncNodeActionResult>(`/api/nodes/${nodeId}/force-re-review`, {
    method: "POST",
    body: JSON.stringify(payload ?? {})
  });
}

export function approveNodeBudgetOverride(
  nodeId: string,
  payload?: ApproveBudgetOverridePayload
): Promise<NodeMutationResult> {
  return api<NodeMutationResult>(`/api/nodes/${nodeId}/approve-budget-override`, {
    method: "POST",
    body: JSON.stringify(payload ?? {})
  });
}

export function listWorkflowDefinitions(projectId: string): Promise<{ definitions: WorkflowDefinition[] }> {
  return api<{ definitions: WorkflowDefinition[] }>(`/api/projects/${projectId}/workflow-definitions`);
}

export function getNodeWorkflowStatus(nodeId: string): Promise<{ nodeId: string; workflow: WorkflowRunState | null }> {
  return api<{ nodeId: string; workflow: WorkflowRunState | null }>(`/api/nodes/${nodeId}/workflow-status`);
}

export function startWorkflowRun(
  projectId: string,
  payload: { workflowDefinitionId: string; taskId?: string | null }
): Promise<{ workflow: WorkflowRunState }> {
  return api<{ workflow: WorkflowRunState }>(`/api/projects/${projectId}/workflow-runs/start`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function tickWorkflowRun(projectId: string, runId: string): Promise<{ workflow: WorkflowRunState; progressed: boolean }> {
  return api<{ workflow: WorkflowRunState; progressed: boolean }>(`/api/projects/${projectId}/workflow-runs/${runId}/tick`, {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function cancelWorkflowRun(
  projectId: string,
  runId: string,
  payload?: { reason?: string }
): Promise<{ workflow: WorkflowRunState }> {
  return api<{ workflow: WorkflowRunState }>(`/api/projects/${projectId}/workflow-runs/${runId}/cancel`, {
    method: "POST",
    body: JSON.stringify(payload ?? {})
  });
}

export function setNodeWorkflowAssignment(
  nodeId: string,
  payload: { mode: "builtin" | "custom"; workflowDefinitionId?: string | null }
): Promise<{ workflowAssignment: { mode: "builtin" | "custom"; workflowDefinitionId: string | null } }> {
  return api<{ workflowAssignment: { mode: "builtin" | "custom"; workflowDefinitionId: string | null } }>(
    `/api/nodes/${nodeId}/workflow-assignment`,
    {
      method: "POST",
      body: JSON.stringify(payload)
    }
  );
}
