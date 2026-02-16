import { Badge, Box, Button, Flex, Heading, Link, Stack, Text } from "@chakra-ui/react";
import { ChevronLeftIcon, ChevronRightIcon } from "@chakra-ui/icons";
import { Link as RouterLink } from "react-router-dom";
import type { Task } from "../api/types";

function taskStatusColor(status: Task["status"]) {
  if (status === "queued") return "gray";
  if (status === "in_progress") return "blue";
  if (status === "merge_ready") return "green";
  if (status === "failed" || status === "cancelled" || status === "merge_conflict") return "red";
  return "purple";
}

function taskStatusLabel(task: Task): string {
  if (task.isBlocked) return "blocked";
  return task.status;
}

export function TaskSidebar({
  tasks,
  selectedTaskId,
  isCollapsed = false,
  onToggleCollapse
}: {
  tasks: Task[];
  selectedTaskId?: string | null;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
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
            aria-label="Show tasks sidebar"
          >
            Show
          </Button>
          <Text fontSize="xs" color="gray.600" display={{ base: "block", lg: "none" }}>
            Tasks hidden
          </Text>
        </Flex>
      </Box>
    );
  }

  return (
    <Box w={{ base: "full", lg: "320px" }} bg="white" borderRadius="lg" p={4} boxShadow="sm" border="1px solid" borderColor="blackAlpha.200">
      <Flex align="center" justify="space-between" mb={3}>
        <Heading size="sm">Tasks</Heading>
        {onToggleCollapse ? (
          <Button size="xs" variant="ghost" onClick={onToggleCollapse} leftIcon={<ChevronLeftIcon />} aria-label="Collapse tasks sidebar">
            Hide
          </Button>
        ) : null}
      </Flex>
      <Stack spacing={2}>
        {tasks.map((task) => (
          <Box
            key={task.id}
            border="1px solid"
            borderColor={selectedTaskId === task.id ? "teal.400" : "blackAlpha.200"}
            borderRadius="md"
            p={3}
            bg={selectedTaskId === task.id ? "teal.50" : "white"}
          >
            <Link as={RouterLink} to={`/tasks/${task.id}?tab=ide`} color="teal.700" fontWeight="700">
              {task.title}
            </Link>
            <Box mt={1}>
              <Badge colorScheme={task.isBlocked ? "orange" : taskStatusColor(task.status)}>{taskStatusLabel(task)}</Badge>
            </Box>
          </Box>
        ))}
        {!tasks.length && <Text color="gray.600">No tasks yet.</Text>}
      </Stack>
    </Box>
  );
}
