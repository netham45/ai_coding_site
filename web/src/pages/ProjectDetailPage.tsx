import {
  Box,
  Button,
  Flex,
  FormControl,
  FormLabel,
  Grid,
  Heading,
  Input,
  Link,
  Stack,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Text,
  Textarea,
  useToast
} from "@chakra-ui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link as RouterLink, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import type { Project, Task } from "../api/types";
import { TaskSidebar } from "../components/TaskSidebar";

type ProjectResponse = { project: Project };
type TasksResponse = { tasks: Task[] };
type ProjectIdeStartResponse = { launchUrl: string };

type CreateTaskForm = {
  title: string;
  taskPrompt: string;
  aiCommand: string;
};

const initialForm: CreateTaskForm = {
  title: "",
  taskPrompt: "",
  aiCommand: "codex --yolo {prompt}"
};

export function ProjectDetailPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [form, setForm] = useState<CreateTaskForm>(initialForm);
  const [loading, setLoading] = useState(false);
  const [activePane, setActivePane] = useState<"tasks" | "ide">("tasks");
  const [projectIdeLaunchUrl, setProjectIdeLaunchUrl] = useState<string | null>(null);
  const [startingProjectIde, setStartingProjectIde] = useState(false);
  const [projectIdeStartFailed, setProjectIdeStartFailed] = useState(false);
  const [projectIdeRetryNonce, setProjectIdeRetryNonce] = useState(0);
  const [expandedIde, setExpandedIde] = useState(false);
  const projectIdeAutoAttemptedRef = useRef(false);

  const canCreate = useMemo(() => {
    return form.title.trim().length >= 2 && form.taskPrompt.trim().length > 0;
  }, [form]);

  async function loadData() {
    if (!projectId) return;
    const [projectRes, tasksRes] = await Promise.all([
      api<ProjectResponse>(`/api/projects/${projectId}`),
      api<TasksResponse>(`/api/projects/${projectId}/tasks`)
    ]);
    setProject(projectRes.project);
    setTasks(tasksRes.tasks);
  }

  useEffect(() => {
    setProjectIdeLaunchUrl(null);
    setActivePane("tasks");
    setExpandedIde(false);
    setProjectIdeStartFailed(false);
    setProjectIdeRetryNonce(0);
    projectIdeAutoAttemptedRef.current = false;
    loadData().catch((error: Error) => {
      toast({ status: "error", title: "Failed to load project", description: error.message });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    if (!projectId || activePane !== "ide" || projectIdeLaunchUrl || startingProjectIde || projectIdeAutoAttemptedRef.current) return;
    projectIdeAutoAttemptedRef.current = true;
    setProjectIdeStartFailed(false);
    setStartingProjectIde(true);
    api<ProjectIdeStartResponse>(`/api/projects/${projectId}/ide/start`, { method: "POST" })
      .then((response) => {
        setProjectIdeLaunchUrl(response.launchUrl);
        setProjectIdeStartFailed(false);
      })
      .catch((error: Error) => {
        setProjectIdeStartFailed(true);
        toast({ status: "error", title: "Failed to start project IDE", description: error.message });
      })
      .finally(() => {
        setStartingProjectIde(false);
      });
  }, [activePane, projectId, projectIdeLaunchUrl, startingProjectIde, projectIdeRetryNonce, toast]);

  useEffect(() => {
    if (activePane !== "ide") {
      setExpandedIde(false);
    }
  }, [activePane]);

  useEffect(() => {
    if (!expandedIde) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [expandedIde]);

  async function onCreateTask(event: React.FormEvent) {
    event.preventDefault();
    if (!projectId) return;

    setLoading(true);
    try {
      const created = await api<{ task: Task }>(`/api/projects/${projectId}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          title: form.title,
          taskPrompt: form.taskPrompt,
          aiCommand: form.aiCommand
        })
      });
      setForm(initialForm);
      await loadData();
      toast({ status: "success", title: "Task created" });
      navigate(`/tasks/${created.task.id}?tab=terminal`);
    } catch (error: any) {
      toast({ status: "error", title: "Task create failed", description: error.message });
    } finally {
      setLoading(false);
    }
  }

  if (!project) {
    return <Text>Loading project...</Text>;
  }

  return (
    <Flex direction={{ base: "column", lg: "row" }} gap={6} align="stretch">
      <TaskSidebar tasks={tasks} />

      <Box flex="1" bg="white" borderRadius="lg" p={6} boxShadow="sm" border="1px solid" borderColor="blackAlpha.200">
        <Box mb={6}>
          <Link as={RouterLink} to="/" color="teal.600" fontWeight="600">
            Back to projects
          </Link>
          <Heading size="lg" mt={2}>
            {project.name}
          </Heading>
          <Text color="gray.600">{project.repoUrl}</Text>
        </Box>

        <Tabs index={activePane === "tasks" ? 0 : 1} onChange={(index) => setActivePane(index === 0 ? "tasks" : "ide")} colorScheme="teal">
          <TabList>
            <Tab>Tasks</Tab>
            <Tab>IDE</Tab>
          </TabList>
          <TabPanels>
            <TabPanel px={0} pt={4}>
              <Heading size="md" mb={4}>
                Create Task
              </Heading>
              <form onSubmit={onCreateTask}>
                <Grid templateColumns={{ base: "1fr", md: "1fr 1fr" }} gap={4}>
                  <FormControl isRequired>
                    <FormLabel>Title</FormLabel>
                    <Input value={form.title} onChange={(e) => setForm((x) => ({ ...x, title: e.target.value }))} />
                  </FormControl>
                  <FormControl isRequired>
                    <FormLabel>AI Command</FormLabel>
                    <Input value={form.aiCommand} onChange={(e) => setForm((x) => ({ ...x, aiCommand: e.target.value }))} />
                  </FormControl>
                  <FormControl gridColumn={{ md: "1 / span 2" }} isRequired>
                    <FormLabel>Task Prompt</FormLabel>
                    <Textarea
                      rows={5}
                      value={form.taskPrompt}
                      onChange={(e) => setForm((x) => ({ ...x, taskPrompt: e.target.value }))}
                    />
                  </FormControl>
                </Grid>
                <Button mt={4} colorScheme="teal" type="submit" isDisabled={!canCreate} isLoading={loading}>
                  Create Task
                </Button>
              </form>
            </TabPanel>
            <TabPanel px={0} pt={4}>
              {projectIdeLaunchUrl ? (
                <Box
                  position={expandedIde ? "fixed" : "relative"}
                  inset={expandedIde ? "0" : "auto"}
                  zIndex={expandedIde ? 2000 : "auto"}
                  bg="white"
                  border={expandedIde ? "none" : "1px solid"}
                  borderColor="blackAlpha.300"
                  borderRadius={expandedIde ? "none" : "md"}
                  overflow="hidden"
                >
                  <Flex h="52px" px={3} align="center" justify="space-between" borderBottom="1px solid" borderColor="blackAlpha.200" bg="white">
                    <Text fontWeight="700">IDE</Text>
                    {expandedIde ? (
                      <Button size="sm" onClick={() => setExpandedIde(false)}>
                        Exit Full View
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => setExpandedIde(true)}>
                        Full View
                      </Button>
                    )}
                  </Flex>
                  <Box p={2}>
                    <Box as="iframe" src={projectIdeLaunchUrl} title="Project IDE" h={expandedIde ? "calc(100vh - 68px)" : "720px"} w="full" border="0" sandbox="allow-same-origin allow-scripts" />
                  </Box>
                </Box>
              ) : (
                <Stack spacing={3}>
                  <Text color="gray.700">
                    {startingProjectIde ? "Starting project IDE..." : projectIdeStartFailed ? "Project IDE failed to start." : "Open IDE tab to start project IDE."}
                  </Text>
                  {!startingProjectIde && projectIdeStartFailed && (
                    <Button
                      alignSelf="flex-start"
                      onClick={() => {
                        projectIdeAutoAttemptedRef.current = false;
                        setProjectIdeStartFailed(false);
                        setProjectIdeRetryNonce((v) => v + 1);
                      }}
                    >
                      Retry IDE Start
                    </Button>
                  )}
                </Stack>
              )}
            </TabPanel>
          </TabPanels>
        </Tabs>
      </Box>
    </Flex>
  );
}
