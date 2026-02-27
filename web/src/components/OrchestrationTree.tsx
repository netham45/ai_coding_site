import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "@chakra-ui/icons";
import { Badge, Box, Button, Flex, Heading, HStack, Link, Stack, Text } from "@chakra-ui/react";
import { useEffect, useMemo, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import type { HierarchyNode, HierarchyNodeRow, NodeTier, TaskStatus } from "../api/types";

function statusColor(status: TaskStatus) {
  if (status === "queued") return "gray";
  if (status === "in_progress") return "blue";
  if (status === "merge_ready" || status === "merged") return "green";
  if (status === "failed" || status === "cancelled" || status === "merge_conflict") return "red";
  return "purple";
}

function tierColor(tier: NodeTier) {
  if (tier === "epoch") return "orange";
  if (tier === "phase") return "yellow";
  if (tier === "plan") return "purple";
  if (tier === "task") return "cyan";
  return "teal";
}

function nodeRoute(node: HierarchyNode) {
  if (node.tier === "task" || node.tier === "exec" || node.task.mode === "execution") {
    return `/tasks/${node.task.id}?tab=ide`;
  }
  return `/plans/${node.task.id}?tab=ide`;
}

function buildFallbackTree(rows: HierarchyNodeRow[]): HierarchyNode[] {
  const byId = new Map<string, HierarchyNode>();
  rows.forEach((row) => {
    byId.set(row.task.id, { ...row, children: [] });
  });

  const roots: HierarchyNode[] = [];
  rows.forEach((row) => {
    const node = byId.get(row.task.id);
    if (!node) return;
    const parentId = row.task.parentPlanTaskId;
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  });

  return roots;
}

export function OrchestrationTree({
  roots,
  fallbackRows = [],
  selectedNodeId,
  isCollapsed = false,
  onToggleCollapse
}: {
  roots: HierarchyNode[];
  fallbackRows?: HierarchyNodeRow[];
  selectedNodeId?: string | null;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const treeRoots = useMemo(() => (roots.length ? roots : buildFallbackTree(fallbackRows)), [fallbackRows, roots]);
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(() => new Set(treeRoots.map((node) => node.task.id)));

  useEffect(() => {
    setExpandedNodeIds((previous) => {
      const next = new Set(previous);
      treeRoots.forEach((root) => next.add(root.task.id));
      return next;
    });
  }, [treeRoots]);

  function toggleNode(nodeId: string) {
    setExpandedNodeIds((previous) => {
      const next = new Set(previous);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }

  if (isCollapsed) {
    return (
      <Box
        w={{ base: "full", lg: "76px" }}
        bg="white"
        borderRadius="lg"
        p={3}
        boxShadow="sm"
        border="1px solid"
        borderColor="blackAlpha.200"
      >
        <Flex direction={{ base: "row", lg: "column" }} align="center" justify="center" gap={2}>
          <Button
            size="xs"
            variant="ghost"
            onClick={onToggleCollapse}
            leftIcon={<ChevronRightIcon />}
            aria-label="Show orchestration tree"
          >
            Show
          </Button>
          <Text fontSize="xs" color="gray.600" display={{ base: "block", lg: "none" }}>
            Tree hidden
          </Text>
        </Flex>
      </Box>
    );
  }

  return (
    <Box w={{ base: "full", lg: "360px" }} bg="white" borderRadius="lg" p={4} boxShadow="sm" border="1px solid" borderColor="blackAlpha.200">
      <Flex align="center" justify="space-between" mb={3}>
        <Heading size="sm">Orchestration Tree</Heading>
        {onToggleCollapse ? (
          <Button size="xs" variant="ghost" onClick={onToggleCollapse} leftIcon={<ChevronLeftIcon />} aria-label="Collapse orchestration tree">
            Hide
          </Button>
        ) : null}
      </Flex>

      {!treeRoots.length ? (
        <Text color="gray.600">No nodes yet.</Text>
      ) : (
        <Stack spacing={1}>
          {treeRoots.map((root) => (
            <TreeRow
              key={root.task.id}
              node={root}
              depth={0}
              expandedNodeIds={expandedNodeIds}
              onToggle={toggleNode}
              selectedNodeId={selectedNodeId}
            />
          ))}
        </Stack>
      )}
    </Box>
  );
}

function TreeRow({
  node,
  depth,
  expandedNodeIds,
  onToggle,
  selectedNodeId
}: {
  node: HierarchyNode;
  depth: number;
  expandedNodeIds: Set<string>;
  onToggle: (nodeId: string) => void;
  selectedNodeId?: string | null;
}) {
  const hasChildren = node.children.length > 0;
  const isExpanded = hasChildren && expandedNodeIds.has(node.task.id);
  const unresolvedDependencyCount = node.waiting.unresolvedDependencyDetails.length;
  const dependencyCount = node.task.dependencyTaskIds.length;
  const isBlocked = node.task.isBlocked || node.waiting.waiting;

  return (
    <Box>
      <HStack spacing={1} align="start" pl={`${depth * 14}px`}>
        {hasChildren ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => onToggle(node.task.id)}
            aria-label={isExpanded ? `Collapse ${node.task.title}` : `Expand ${node.task.title}`}
            minW="24px"
            px={0}
            mt="4px"
          >
            {isExpanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </Button>
        ) : (
          <Box w="24px" />
        )}

        <Box flex="1" minW={0} border="1px solid" borderColor={selectedNodeId === node.task.id ? "teal.300" : "blackAlpha.200"} borderRadius="md" p={2}>
          <Link
            as={RouterLink}
            to={nodeRoute(node)}
            color="teal.700"
            fontWeight="700"
            display="block"
            onKeyDown={(event) => {
              if (!hasChildren) return;
              if (event.key === "ArrowRight" && !isExpanded) {
                event.preventDefault();
                onToggle(node.task.id);
              }
              if (event.key === "ArrowLeft" && isExpanded) {
                event.preventDefault();
                onToggle(node.task.id);
              }
            }}
          >
            {node.task.title}
          </Link>
          <Flex mt={1} wrap="wrap" gap={1}>
            <Badge colorScheme={tierColor(node.tier)}>{node.tier}</Badge>
            <Badge colorScheme={statusColor(node.task.status)}>{node.task.status}</Badge>
            <Badge colorScheme={node.task.autoMerge ? "green" : "gray"}>auto-merge: {node.task.autoMerge ? "on" : "off"}</Badge>
            {node.task.mode === "plan" ? (
              <Badge colorScheme={node.task.autoMergeOnComplete ? "green" : "gray"}>
                auto-merge on complete: {node.task.autoMergeOnComplete ? "on" : "off"}
              </Badge>
            ) : null}
            {isBlocked ? <Badge colorScheme="orange">blocked</Badge> : null}
            {unresolvedDependencyCount > 0 ? <Badge colorScheme="red">deps {unresolvedDependencyCount}</Badge> : null}
            {unresolvedDependencyCount === 0 && dependencyCount > 0 ? <Badge colorScheme="gray">deps {dependencyCount}</Badge> : null}
          </Flex>
        </Box>
      </HStack>

      {isExpanded ? (
        <Stack spacing={1} mt={1}>
          {node.children.map((child) => (
            <TreeRow
              key={child.task.id}
              node={child}
              depth={depth + 1}
              expandedNodeIds={expandedNodeIds}
              onToggle={onToggle}
              selectedNodeId={selectedNodeId}
            />
          ))}
        </Stack>
      ) : null}
    </Box>
  );
}
