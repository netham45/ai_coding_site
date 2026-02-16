import { Badge, Box, Heading, Link, Stack, Text } from "@chakra-ui/react";
import { Link as RouterLink } from "react-router-dom";
import type { Task } from "../api/types";

function taskStatusColor(status: Task["status"]) {
  if (status === "queued") return "gray";
  if (status === "in_progress") return "blue";
  if (status === "merge_ready") return "green";
  if (status === "failed" || status === "cancelled" || status === "merge_conflict") return "red";
  return "purple";
}

export function TaskSidebar({
  tasks,
  selectedTaskId
}: {
  tasks: Task[];
  selectedTaskId?: string | null;
}) {
  return (
    <Box w={{ base: "full", lg: "320px" }} bg="white" borderRadius="lg" p={4} boxShadow="sm" border="1px solid" borderColor="blackAlpha.200">
      <Heading size="sm" mb={3}>
        Tasks
      </Heading>
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
              <Badge colorScheme={taskStatusColor(task.status)}>{task.status}</Badge>
            </Box>
          </Box>
        ))}
        {!tasks.length && <Text color="gray.600">No tasks yet.</Text>}
      </Stack>
    </Box>
  );
}
