import {
  Badge,
  Box,
  Button,
  Checkbox,
  Code,
  Flex,
  Heading,
  Input,
  Link,
  Stack,
  Text
} from "@chakra-ui/react";
import { useEffect, useMemo, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import type { NodeTier, OrchestrationNodeDetail, Task } from "../api/types";

export type NodeActionLoadingState = {
  start: boolean;
  autoMode: boolean;
  autoMerge: boolean;
  autoMergeOnComplete: boolean;
  reReview: boolean;
  budgetOverride: boolean;
};

type NodeActionsPanelProps = {
  nodeDetail: OrchestrationNodeDetail | null;
  isLoading: boolean;
  loadError: string | null;
  actionLoading: NodeActionLoadingState;
  onStartNode: (autoMode: boolean) => void | Promise<void>;
  onSetAutoMode: (enabled: boolean) => void | Promise<void>;
  onSetAutoMerge: (enabled: boolean, onComplete?: boolean) => void | Promise<void>;
  onForceReReview: (reason?: string) => void | Promise<void>;
  onApproveBudgetOverride: (enabled: boolean, reason?: string) => void | Promise<void>;
};

type UnresolvedDependencyDetail = {
  id: string;
  tier: NodeTier;
  reason: string | null;
  status: string | null;
};

type BlockingDependency = {
  id: string;
  title: string;
  status: string;
  mode: string;
};

type WaitingDiagnostics = {
  waiting: boolean;
  reasonCode: string;
  reason: string;
  dependencyBlockerTaskId: string | null;
  unresolvedDependencyIds: string[];
  unresolvedDependencyDetails: UnresolvedDependencyDetail[];
  blockingDependencies: BlockingDependency[];
  pendingChildren: BlockingDependency[];
};

type DependencyDiagnostics = {
  node: { id: string; tier: NodeTier };
  unresolved: UnresolvedDependencyDetail[];
};

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function toUnresolvedDependencyDetail(value: unknown): UnresolvedDependencyDetail | null {
  const row = asObject(value);
  if (!row) return null;
  const id = asString(row.id);
  const tierRaw = asString(row.tier);
  const tier = tierRaw && ["epoch", "phase", "plan", "task", "exec"].includes(tierRaw) ? (tierRaw as NodeTier) : null;
  if (!id || !tier) return null;
  const reason = asString(row.reason);
  const status = asString(row.status);
  return { id, tier, reason, status };
}

function toBlockingDependency(value: unknown): BlockingDependency | null {
  const row = asObject(value);
  if (!row) return null;
  const id = asString(row.id);
  const title = asString(row.title);
  const status = asString(row.status);
  const mode = asString(row.mode);
  if (!id || !title || !status || !mode) return null;
  return { id, title, status, mode };
}

function parseWaitingDiagnostics(input: unknown): WaitingDiagnostics | null {
  const row = asObject(input);
  if (!row) return null;

  const waiting = asBoolean(row.waiting);
  const reasonCode = asString(row.reasonCode);
  const reason = asString(row.reason);
  if (waiting === null || !reasonCode || !reason) return null;

  const dependencyBlockerTaskId = asString(row.dependencyBlockerTaskId);
  const unresolvedDependencyIds = Array.isArray(row.unresolvedDependencyIds)
    ? row.unresolvedDependencyIds.map((item) => asString(item)).filter((item): item is string => !!item)
    : [];

  const unresolvedDependencyDetails = Array.isArray(row.unresolvedDependencyDetails)
    ? row.unresolvedDependencyDetails.map((item) => toUnresolvedDependencyDetail(item)).filter((item): item is UnresolvedDependencyDetail => !!item)
    : [];

  const blockingDependencies = Array.isArray(row.blockingDependencies)
    ? row.blockingDependencies.map((item) => toBlockingDependency(item)).filter((item): item is BlockingDependency => !!item)
    : [];

  const pendingChildren = Array.isArray(row.pendingChildren)
    ? row.pendingChildren.map((item) => toBlockingDependency(item)).filter((item): item is BlockingDependency => !!item)
    : [];

  return {
    waiting,
    reasonCode,
    reason,
    dependencyBlockerTaskId: dependencyBlockerTaskId ?? null,
    unresolvedDependencyIds,
    unresolvedDependencyDetails,
    blockingDependencies,
    pendingChildren
  };
}

function parseDependencyDiagnostics(input: unknown): DependencyDiagnostics | null {
  const row = asObject(input);
  if (!row) return null;
  const node = asObject(row.node);
  if (!node) return null;
  const id = asString(node.id);
  const tierRaw = asString(node.tier);
  const tier = tierRaw && ["epoch", "phase", "plan", "task", "exec"].includes(tierRaw) ? (tierRaw as NodeTier) : null;
  if (!id || !tier) return null;
  const unresolved = Array.isArray(row.unresolved)
    ? row.unresolved.map((item) => toUnresolvedDependencyDetail(item)).filter((item): item is UnresolvedDependencyDetail => !!item)
    : [];
  return { node: { id, tier }, unresolved };
}

function inferTier(node: Task): NodeTier {
  if (node.mode === "plan") return "plan";
  return node.parentPlanTaskId ? "exec" : "task";
}

function taskLink(task: Task): string {
  return task.mode === "plan" ? `/plans/${task.id}?tab=info` : `/tasks/${task.id}?tab=info`;
}

export function NodeActionsPanel({
  nodeDetail,
  isLoading,
  loadError,
  actionLoading,
  onStartNode,
  onSetAutoMode,
  onSetAutoMerge,
  onForceReReview,
  onApproveBudgetOverride
}: NodeActionsPanelProps) {
  const waiting = useMemo(() => parseWaitingDiagnostics(nodeDetail?.waiting), [nodeDetail?.waiting]);
  const diagnostics = useMemo(() => parseDependencyDiagnostics(nodeDetail?.dependencyDiagnostics), [nodeDetail?.dependencyDiagnostics]);

  const [startAutoMode, setStartAutoMode] = useState(true);
  const [reReviewReason, setReReviewReason] = useState("");
  const [budgetOverrideReason, setBudgetOverrideReason] = useState("");
  const [budgetOverrideEnabled, setBudgetOverrideEnabled] = useState(true);

  useEffect(() => {
    if (!nodeDetail) return;
    setStartAutoMode(nodeDetail.node.autoStart);

    const root = asObject(nodeDetail.node);
    const controls = asObject(root?.orchestrationControls);
    const replan = asObject(controls?.replan);
    const currentBudgetOverride = asBoolean(replan?.budgetOverride);
    setBudgetOverrideEnabled(currentBudgetOverride ?? true);
  }, [nodeDetail]);

  if (isLoading) {
    return (
      <Box>
        <Heading size="sm" mb={2}>
          Node Orchestration
        </Heading>
        <Text color="gray.600">Loading orchestration details...</Text>
      </Box>
    );
  }

  if (!nodeDetail) {
    return (
      <Box>
        <Heading size="sm" mb={2}>
          Node Orchestration
        </Heading>
        <Text color="gray.600">{loadError || "Node orchestration details are unavailable."}</Text>
      </Box>
    );
  }

  const node = nodeDetail.node;
  const tier = diagnostics?.node.tier ?? inferTier(node);

  return (
    <Stack spacing={4}>
      <Box>
        <Heading size="sm" mb={2}>
          Node Orchestration
        </Heading>
        <Stack spacing={2}>
          <Flex direction="row" align="center" gap={2} wrap="wrap">
            <Badge colorScheme="blue">tier: {tier}</Badge>
            <Badge colorScheme={node.mode === "plan" ? "purple" : "cyan"}>mode: {node.mode}</Badge>
          </Flex>
          <Text fontSize="sm" color="gray.700">parent: {nodeDetail.parent ? nodeDetail.parent.title : "none"}</Text>
          {nodeDetail.parent && (
            <Text fontSize="sm" color="gray.700">
              parent link:{" "}
              <Link as={RouterLink} to={taskLink(nodeDetail.parent)} color="teal.700" fontWeight="600">
                {nodeDetail.parent.id}
              </Link>
            </Text>
          )}
          <Text fontSize="sm" color="gray.700">children: {nodeDetail.children.length}</Text>
          {nodeDetail.children.map((child) => (
            <Text key={child.id} fontSize="sm" color="gray.700">
              <Link as={RouterLink} to={taskLink(child)} color="teal.700" fontWeight="600">
                {child.title}
              </Link>{" "}
              ({child.mode})
            </Text>
          ))}
        </Stack>
      </Box>

      <Box>
        <Heading size="sm" mb={2}>
          Blocked Diagnostics
        </Heading>
        <Stack spacing={2}>
          <Text color={waiting?.waiting ? "orange.700" : "gray.700"}>
            {waiting ? `${waiting.reasonCode}: ${waiting.reason}` : node.isBlocked ? "blocked" : "not blocked"}
          </Text>
          {waiting?.dependencyBlockerTaskId && (
            <Text fontSize="sm" color="orange.700">blocking task id: {waiting.dependencyBlockerTaskId}</Text>
          )}
          {!!waiting?.blockingDependencies.length && (
            <Stack spacing={1}>
              {waiting.blockingDependencies.map((dep) => (
                <Text key={dep.id} fontSize="sm" color="orange.700">
                  {dep.title} ({dep.mode}, {dep.status})
                </Text>
              ))}
            </Stack>
          )}
          {!!waiting?.pendingChildren.length && (
            <Stack spacing={1}>
              {waiting.pendingChildren.map((child) => (
                <Text key={child.id} fontSize="sm" color="orange.700">
                  pending child: {child.title} ({child.status})
                </Text>
              ))}
            </Stack>
          )}
          {!!(waiting?.unresolvedDependencyDetails.length || diagnostics?.unresolved.length) && (
            <Stack spacing={1}>
              {(waiting?.unresolvedDependencyDetails.length ? waiting.unresolvedDependencyDetails : diagnostics?.unresolved ?? []).map((dep) => (
                <Code key={`${dep.id}-${dep.tier}`} p={2} whiteSpace="pre-wrap">
                  {dep.id} | {dep.tier} | {dep.status ?? "unknown"} | {dep.reason ?? "unresolved dependency"}
                </Code>
              ))}
            </Stack>
          )}
          {!waiting?.unresolvedDependencyDetails.length && !diagnostics?.unresolved.length && (
            <Text fontSize="sm" color="gray.600">No unresolved dependency reasons.</Text>
          )}
        </Stack>
      </Box>

      <Box>
        <Heading size="sm" mb={2}>
          Orchestration Controls
        </Heading>
        <Stack spacing={3}>
          <Box border="1px solid" borderColor="blackAlpha.200" borderRadius="md" p={3}>
            <Stack spacing={2}>
              <Checkbox isChecked={startAutoMode} onChange={(event) => setStartAutoMode(event.target.checked)}>
                Start with auto-mode
              </Checkbox>
              <Button colorScheme="blue" size="sm" onClick={() => onStartNode(startAutoMode)} isLoading={actionLoading.start}>
                Start Node
              </Button>
            </Stack>
          </Box>

          <Box border="1px solid" borderColor="blackAlpha.200" borderRadius="md" p={3}>
            <Stack direction={{ base: "column", md: "row" }} spacing={2}>
              <Button
                size="sm"
                variant="outline"
                colorScheme="blue"
                onClick={() => onSetAutoMode(!node.autoStart)}
                isLoading={actionLoading.autoMode}
              >
                {node.autoStart ? "Disable Auto Mode" : "Enable Auto Mode"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                colorScheme="green"
                onClick={() => onSetAutoMerge(!(node.mode === "plan" ? node.autoMergeOnComplete : node.autoMerge), node.mode === "plan")}
                isLoading={actionLoading.autoMerge}
              >
                {node.mode === "plan"
                  ? node.autoMergeOnComplete
                    ? "Disable Auto-Merge On Complete"
                    : "Enable Auto-Merge On Complete"
                  : node.autoMerge
                    ? "Disable Auto-Merge"
                    : "Enable Auto-Merge"}
              </Button>
              {node.mode === "plan" && (
                <Button
                  size="sm"
                  variant="outline"
                  colorScheme="green"
                  onClick={() => onSetAutoMerge(!node.autoMerge, false)}
                  isLoading={actionLoading.autoMergeOnComplete}
                >
                  {node.autoMerge ? "Disable Child Auto-Merge" : "Enable Child Auto-Merge"}
                </Button>
              )}
            </Stack>
          </Box>

          <Box border="1px solid" borderColor="blackAlpha.200" borderRadius="md" p={3}>
            <Stack spacing={2}>
              <Input
                value={reReviewReason}
                onChange={(event) => setReReviewReason(event.target.value)}
                placeholder="Reason for re-review (optional)"
              />
              <Button
                size="sm"
                variant="outline"
                colorScheme="purple"
                onClick={() => onForceReReview(reReviewReason.trim() || undefined)}
                isLoading={actionLoading.reReview}
              >
                Force Re-Review
              </Button>
            </Stack>
          </Box>

          <Box border="1px solid" borderColor="blackAlpha.200" borderRadius="md" p={3}>
            <Stack spacing={2}>
              <Checkbox isChecked={budgetOverrideEnabled} onChange={(event) => setBudgetOverrideEnabled(event.target.checked)}>
                Budget override enabled
              </Checkbox>
              <Input
                value={budgetOverrideReason}
                onChange={(event) => setBudgetOverrideReason(event.target.value)}
                placeholder="Reason for budget override (optional)"
              />
              <Button
                size="sm"
                variant="outline"
                colorScheme="orange"
                onClick={() => onApproveBudgetOverride(budgetOverrideEnabled, budgetOverrideReason.trim() || undefined)}
                isLoading={actionLoading.budgetOverride}
              >
                Apply Budget Override
              </Button>
            </Stack>
          </Box>
        </Stack>
      </Box>
    </Stack>
  );
}
