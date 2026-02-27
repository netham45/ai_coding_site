import { Badge, Box, Button, Code, Flex, Heading, Select, Stack, Text } from "@chakra-ui/react";
import { useEffect, useMemo, useState } from "react";
import type { NodeTier, Task, WorkflowDefinition, WorkflowRunState } from "../api/types";

type WorkflowPanelProps = {
  task: Task;
  workflow: WorkflowRunState | null;
  definitions: WorkflowDefinition[];
  isLoading: boolean;
  actionLoading: {
    assignment: boolean;
    continue: boolean;
    retry: boolean;
    cancel: boolean;
  };
  onSaveAssignment: (mode: "builtin" | "custom", workflowDefinitionId: string | null) => void | Promise<void>;
  onContinue: () => void | Promise<void>;
  onRetry: () => void | Promise<void>;
  onCancel: () => void | Promise<void>;
};

function inferTier(task: Task): NodeTier {
  const metadataTier = task.nodeMetadata?.tier;
  if (metadataTier === "epoch" || metadataTier === "phase" || metadataTier === "plan" || metadataTier === "task" || metadataTier === "exec") {
    return metadataTier;
  }
  if (task.mode === "plan") return "plan";
  return task.parentPlanTaskId ? "exec" : "task";
}

function readWorkflowAssignment(task: Task): { mode: "builtin" | "custom"; workflowDefinitionId: string | null } {
  const root = task.nodeMetadata?.custom;
  if (!root || typeof root !== "object") {
    return { mode: "builtin", workflowDefinitionId: null };
  }
  const assignmentRaw = (root as Record<string, unknown>).workflow_assignment;
  if (!assignmentRaw || typeof assignmentRaw !== "object") {
    return { mode: "builtin", workflowDefinitionId: null };
  }
  const assignment = assignmentRaw as Record<string, unknown>;
  const mode = assignment.mode === "custom" ? "custom" : "builtin";
  const workflowDefinitionId =
    typeof assignment.workflow_definition_id === "string" && assignment.workflow_definition_id.trim().length
      ? assignment.workflow_definition_id
      : null;
  if (mode === "custom" && !workflowDefinitionId) {
    return { mode: "builtin", workflowDefinitionId: null };
  }
  return { mode, workflowDefinitionId };
}

function statusColor(status: string): string {
  if (status === "running") return "blue";
  if (status === "succeeded" || status === "pass") return "green";
  if (status === "failed" || status === "error" || status === "cancelled") return "red";
  if (status === "skipped") return "gray";
  return "yellow";
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function WorkflowPanel({
  task,
  workflow,
  definitions,
  isLoading,
  actionLoading,
  onSaveAssignment,
  onContinue,
  onRetry,
  onCancel
}: WorkflowPanelProps) {
  const tier = inferTier(task);
  const workflowCapable = tier === "epoch" || tier === "phase" || tier === "plan";
  const parsedAssignment = useMemo(() => readWorkflowAssignment(task), [task]);
  const [assignmentMode, setAssignmentMode] = useState<"builtin" | "custom">(parsedAssignment.mode);
  const [assignmentDefinitionId, setAssignmentDefinitionId] = useState<string>(parsedAssignment.workflowDefinitionId ?? "");

  useEffect(() => {
    setAssignmentMode(parsedAssignment.mode);
    setAssignmentDefinitionId(parsedAssignment.workflowDefinitionId ?? "");
  }, [parsedAssignment.mode, parsedAssignment.workflowDefinitionId, task.id]);

  if (!workflowCapable) {
    return (
      <Box>
        <Heading size="sm" mb={2}>
          Workflow
        </Heading>
        <Text color="gray.600">Workflow engine controls are available for epoch, phase, and plan nodes.</Text>
      </Box>
    );
  }

  const failedChecks = workflow?.stages.flatMap((stage) =>
    stage.diagnostics.checks
      .filter((check) => check.status !== "pass")
      .map((check) => ({ stageKey: stage.stageKey, checkName: check.checkName, status: check.status, details: check.details }))
  ) ?? [];
  const running = workflow?.run.status === "running" || workflow?.run.status === "queued";

  return (
    <Stack spacing={4}>
      <Box>
        <Heading size="sm" mb={2}>
          Workflow Assignment
        </Heading>
        <Stack spacing={2}>
          <Select value={assignmentMode} onChange={(event) => setAssignmentMode(event.target.value as "builtin" | "custom")}>
            <option value="builtin">Built-in workflow</option>
            <option value="custom">Custom workflow</option>
          </Select>
          {assignmentMode === "custom" && (
            <Select
              placeholder="Select workflow definition"
              value={assignmentDefinitionId}
              onChange={(event) => setAssignmentDefinitionId(event.target.value)}
            >
              {definitions.map((definition) => (
                <option key={definition.id} value={definition.id}>
                  {definition.name} v{definition.version}
                </option>
              ))}
            </Select>
          )}
          <Button
            size="sm"
            colorScheme="teal"
            variant="outline"
            isLoading={actionLoading.assignment}
            isDisabled={assignmentMode === "custom" && !assignmentDefinitionId}
            onClick={() => onSaveAssignment(assignmentMode, assignmentMode === "custom" ? assignmentDefinitionId : null)}
          >
            Save Workflow Assignment
          </Button>
        </Stack>
      </Box>

      <Box>
        <Heading size="sm" mb={2}>
          Workflow Run
        </Heading>
        {isLoading ? (
          <Text color="gray.600">Loading workflow state...</Text>
        ) : !workflow ? (
          <Text color="gray.600">No workflow run found for this node.</Text>
        ) : (
          <Stack spacing={3}>
            <Flex direction="row" gap={2} wrap="wrap">
              <Badge colorScheme={statusColor(workflow.run.status)}>run: {workflow.run.status}</Badge>
              <Badge colorScheme="purple">definition: {workflow.definition.name} v{workflow.definition.version}</Badge>
            </Flex>
            <Stack direction={{ base: "column", md: "row" }} spacing={2}>
              <Button size="sm" colorScheme="blue" variant="outline" onClick={onContinue} isLoading={actionLoading.continue} isDisabled={!running}>
                Continue (Tick)
              </Button>
              <Button size="sm" colorScheme="orange" variant="outline" onClick={onRetry} isLoading={actionLoading.retry}>
                Retry Run
              </Button>
              <Button size="sm" colorScheme="red" variant="outline" onClick={onCancel} isLoading={actionLoading.cancel} isDisabled={!running}>
                Cancel Run
              </Button>
            </Stack>
            <Stack spacing={2}>
              {workflow.stages.map((stage) => (
                <Box key={stage.id} border="1px solid" borderColor="blackAlpha.200" borderRadius="md" p={3}>
                  <Flex justify="space-between" align="center" gap={2} wrap="wrap">
                    <Text fontWeight="600">{stage.ordinal + 1}. {stage.stageKey}</Text>
                    <Badge colorScheme={statusColor(stage.status)}>{stage.status}</Badge>
                  </Flex>
                  <Text fontSize="sm" color="gray.700">
                    lifecycle: {stage.diagnostics.lifecycleState ?? "n/a"} | attempts: {stage.diagnostics.attemptsStarted}
                  </Text>
                  {!!stage.diagnostics.blockedBy.length && (
                    <Text fontSize="sm" color="orange.700">
                      blocked by: {stage.diagnostics.blockedBy.join(", ")}
                    </Text>
                  )}
                </Box>
              ))}
            </Stack>
            {!!failedChecks.length && (
              <Box border="1px solid" borderColor="red.300" bg="red.50" borderRadius="md" p={3}>
                <Heading size="xs" mb={2} color="red.700">
                  Failure Diagnostics
                </Heading>
                <Stack spacing={2}>
                  {failedChecks.map((check, idx) => (
                    <Box key={`${check.stageKey}-${check.checkName}-${idx}`}>
                      <Text fontSize="sm" color="red.800">
                        {check.stageKey} / {check.checkName} ({check.status})
                      </Text>
                      <Code display="block" whiteSpace="pre-wrap" p={2}>
                        {stringify(check.details)}
                      </Code>
                    </Box>
                  ))}
                </Stack>
              </Box>
            )}
          </Stack>
        )}
      </Box>
    </Stack>
  );
}
