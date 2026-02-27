import {
  Badge,
  Box,
  Button,
  Code,
  Flex,
  FormControl,
  FormLabel,
  Grid,
  Heading,
  Input,
  Link,
  Select,
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
import { api, createNode, getHierarchy } from "../api/client";
import type { HierarchyNodeRow, NodeTier, Project, Task, UserSettings } from "../api/types";
import { NodeCreateForm } from "../components/NodeCreateForm";
import { TaskSidebar } from "../components/TaskSidebar";

type ProjectResponse = { project: Project };
type TasksResponse = { tasks: Task[] };
type ProjectIdeStartResponse = { launchUrl: string };
type SettingsResponse = { settings: UserSettings };

type ProjectInstructionsForm = {
  projectPrompt: string;
  projectRules: string;
  codingStandard: string;
  codingStandardOther: string;
  projectOther: string;
};

const CODING_STANDARD_OPTIONS = [
  { value: "", label: "None selected" },
  { value: "Airbnb JavaScript Style Guide", label: "Airbnb JavaScript Style Guide" },
  { value: "Google JavaScript Style Guide", label: "Google JavaScript Style Guide" },
  { value: "PEP 8", label: "PEP 8 (Python)" },
  { value: "PSR-12", label: "PSR-12 (PHP)" },
  { value: "Standard Go Formatting", label: "Standard Go Formatting (gofmt)" },
  { value: "Rust Style Guide", label: "Rust Style Guide" },
  { value: "Other", label: "Other" }
];

export function ProjectDetailPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [hierarchyNodes, setHierarchyNodes] = useState<HierarchyNodeRow[]>([]);
  const [taskAiCommandOptions, setTaskAiCommandOptions] = useState<string[]>(["codex --yolo {prompt}"]);
  const [instructionsForm, setInstructionsForm] = useState<ProjectInstructionsForm>({
    projectPrompt: "",
    projectRules: "",
    codingStandard: "",
    codingStandardOther: "",
    projectOther: ""
  });
  const [creatingNode, setCreatingNode] = useState(false);
  const [savingProjectInstructions, setSavingProjectInstructions] = useState(false);
  const [activePane, setActivePane] = useState<"tasks" | "plans" | "project" | "ide">("tasks");
  const [projectIdeLaunchUrl, setProjectIdeLaunchUrl] = useState<string | null>(null);
  const [startingProjectIde, setStartingProjectIde] = useState(false);
  const [projectIdeStartFailed, setProjectIdeStartFailed] = useState(false);
  const [projectIdeRetryNonce, setProjectIdeRetryNonce] = useState(0);
  const [expandedIde, setExpandedIde] = useState(false);
  const [isTaskSidebarCollapsed, setIsTaskSidebarCollapsed] = useState(false);
  const projectIdeAutoAttemptedRef = useRef(false);

  const nodeOptions = useMemo(() => {
    const rows = hierarchyNodes.length
      ? hierarchyNodes
      : tasks.map((task) => ({
          task,
          tier: (task.mode === "execution" ? "task" : "plan") as NodeTier,
          waiting: {
            waiting: false,
            reasonCode: "",
            reason: "",
            dependencyBlockerTaskId: null,
            unresolvedDependencyIds: [],
            unresolvedDependencyDetails: []
          }
        }));
    return rows.map((row) => ({
      id: row.task.id,
      title: row.task.title,
      tier: row.tier,
      status: row.task.status,
      isBlocked: row.task.isBlocked
    }));
  }, [hierarchyNodes, tasks]);

  const nodeTierById = useMemo(() => new Map(nodeOptions.map((node) => [node.id, node.tier])), [nodeOptions]);

  const planTasks = useMemo(
    () => tasks.filter((task) => nodeTierById.get(task.id) === "plan" || (!nodeTierById.has(task.id) && task.mode === "plan")),
    [nodeTierById, tasks]
  );

  async function loadData() {
    if (!projectId) return;
    const [projectRes, tasksRes, settingsRes, hierarchyRes] = await Promise.all([
      api<ProjectResponse>(`/api/projects/${projectId}`),
      api<TasksResponse>(`/api/projects/${projectId}/tasks`),
      api<SettingsResponse>("/api/users/me/settings"),
      getHierarchy(projectId).catch(() => null)
    ]);
    setProject(projectRes.project);
    setInstructionsForm({
      projectPrompt: projectRes.project.projectPrompt ?? "",
      projectRules: projectRes.project.projectRules ?? "",
      codingStandard: projectRes.project.codingStandard ?? "",
      codingStandardOther: projectRes.project.codingStandardOther ?? "",
      projectOther: projectRes.project.projectOther ?? ""
    });
    setTasks(tasksRes.tasks);
    setHierarchyNodes(hierarchyRes?.hierarchy.nodes ?? []);
    const commandOptions = settingsRes.settings.defaultAiCommands?.length
      ? settingsRes.settings.defaultAiCommands
      : [settingsRes.settings.defaultAiCommand || "codex --yolo {prompt}"];
    setTaskAiCommandOptions(commandOptions);
  }

  useEffect(() => {
    setProjectIdeLaunchUrl(null);
    setActivePane("tasks");
    setExpandedIde(false);
    setIsTaskSidebarCollapsed(false);
    setProjectIdeStartFailed(false);
    setProjectIdeRetryNonce(0);
    projectIdeAutoAttemptedRef.current = false;
    loadData().catch((error: Error) => {
      toast({ status: "error", title: "Failed to load project", description: error.message });
    });

    const interval = setInterval(() => {
      loadData().catch((error: Error) => {
        console.error("Failed to poll project data", error);
      });
    }, 3000);

    return () => clearInterval(interval);
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

  async function onCreateNode(payload: {
    title: string;
    taskPrompt: string;
    nodeTier: "epoch" | "phase" | "plan" | "task";
    aiCommand?: string;
    autoMerge?: boolean;
    parentNodeId?: string;
    dependencyNodeRefs?: Array<{ id: string; tier?: NodeTier }>;
  }) {
    if (!projectId) return;
    setCreatingNode(true);
    try {
      const created = await createNode(projectId, payload);
      await loadData();
      toast({ status: "success", title: `${payload.nodeTier} created` });
      const detailRoute = created.node.mode === "execution" ? `/tasks/${created.node.id}?tab=ide` : `/plans/${created.node.id}?tab=ide`;
      navigate(detailRoute);
    } catch (error: unknown) {
      const description = error instanceof Error ? error.message : "Node create failed";
      toast({ status: "error", title: "Node create failed", description });
    } finally {
      setCreatingNode(false);
    }
  }

  async function onSaveProjectInstructions(event: React.FormEvent) {
    event.preventDefault();
    if (!projectId) return;

    setSavingProjectInstructions(true);
    try {
      const response = await api<{ project: Project }>(`/api/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify({
          projectPrompt: instructionsForm.projectPrompt,
          projectRules: instructionsForm.projectRules,
          codingStandard: instructionsForm.codingStandard,
          codingStandardOther: instructionsForm.codingStandardOther,
          projectOther: instructionsForm.projectOther
        })
      });
      setProject(response.project);
      setInstructionsForm({
        projectPrompt: response.project.projectPrompt ?? "",
        projectRules: response.project.projectRules ?? "",
        codingStandard: response.project.codingStandard ?? "",
        codingStandardOther: response.project.codingStandardOther ?? "",
        projectOther: response.project.projectOther ?? ""
      });
      toast({ status: "success", title: "Project instructions updated" });
    } catch (error: any) {
      toast({ status: "error", title: "Failed to update project instructions", description: error.message });
    } finally {
      setSavingProjectInstructions(false);
    }
  }

  if (!project) {
    return <Text>Loading project...</Text>;
  }

  return (
    <Flex direction={{ base: "column", lg: "row" }} gap={6} align="stretch">
      <TaskSidebar tasks={tasks} isCollapsed={isTaskSidebarCollapsed} onToggleCollapse={() => setIsTaskSidebarCollapsed((value) => !value)} />

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

        <Tabs
          index={activePane === "tasks" ? 0 : activePane === "plans" ? 1 : activePane === "project" ? 2 : 3}
          onChange={(index) => setActivePane(index === 0 ? "tasks" : index === 1 ? "plans" : index === 2 ? "project" : "ide")}
          colorScheme="teal"
        >
          <TabList>
            <Tab>Tasks</Tab>
            <Tab>Plans</Tab>
            <Tab>Project Prompt</Tab>
            <Tab>IDE</Tab>
          </TabList>
          <TabPanels>
            <TabPanel px={0} pt={4}>
              <Heading size="md" mb={4}>
                Create Node
              </Heading>
              <NodeCreateForm
                aiCommandOptions={taskAiCommandOptions}
                nodeOptions={nodeOptions}
                presetTier="task"
                submitLabel="Create Node"
                submitColorScheme="teal"
                submitting={creatingNode}
                helperText="Task preset active. Use Node Tier to switch to epoch/phase/plan/task."
                onCreate={onCreateNode}
              />
            </TabPanel>
            <TabPanel px={0} pt={4}>
              <Heading size="md" mb={2}>
                Create Node
              </Heading>
              <Text color="gray.600" mb={4}>
                Plan mode creates a planning runtime (IDE + terminal) that outputs a task graph for approval.
              </Text>
              <Text color="gray.600" mb={4}>
                YAML format is required and automatically enforced. The planner is instructed to write output to <Code>.ai-plan/latest-plan.yaml</Code>.
              </Text>
              <NodeCreateForm
                aiCommandOptions={taskAiCommandOptions}
                nodeOptions={nodeOptions}
                presetTier="plan"
                submitLabel="Create Node"
                submitColorScheme="purple"
                submitting={creatingNode}
                helperText="Plan preset active. Use Node Tier to switch to epoch/phase/plan/task."
                onCreate={onCreateNode}
              />

              <Heading size="sm" mt={8} mb={3}>
                Existing Plans
              </Heading>
              <Stack spacing={2}>
                {planTasks.map((planTask) => (
                  <Box key={planTask.id} border="1px solid" borderColor="blackAlpha.200" borderRadius="md" p={3}>
                    <Flex align="center" justify="space-between" gap={3}>
                      <Link as={RouterLink} to={`/plans/${planTask.id}?tab=ide`} color="teal.700" fontWeight="700">
                        {planTask.title}
                      </Link>
                      <Badge colorScheme={planTask.isBlocked ? "orange" : "purple"}>{planTask.isBlocked ? "blocked" : planTask.status}</Badge>
                    </Flex>
                  </Box>
                ))}
                {!planTasks.length && <Text color="gray.600">No plans yet.</Text>}
              </Stack>
            </TabPanel>
            <TabPanel px={0} pt={4}>
              <Heading size="md" mb={2}>
                Project Prompt Builder
              </Heading>
              <Text color="gray.600" mb={4}>
                These fields are combined with each new task prompt to generate the full runtime prompt.
              </Text>
              <form onSubmit={onSaveProjectInstructions}>
                <Grid templateColumns={{ base: "1fr", md: "1fr 1fr" }} gap={4}>
                  <FormControl gridColumn={{ md: "1 / span 2" }}>
                    <FormLabel>Prompt</FormLabel>
                    <Textarea
                      rows={4}
                      value={instructionsForm.projectPrompt}
                      onChange={(e) => setInstructionsForm((x) => ({ ...x, projectPrompt: e.target.value }))}
                    />
                  </FormControl>
                  <FormControl gridColumn={{ md: "1 / span 2" }}>
                    <FormLabel>Rules</FormLabel>
                    <Textarea
                      rows={4}
                      value={instructionsForm.projectRules}
                      onChange={(e) => setInstructionsForm((x) => ({ ...x, projectRules: e.target.value }))}
                    />
                  </FormControl>
                  <FormControl>
                    <FormLabel>Coding Standard</FormLabel>
                    <Select
                      value={instructionsForm.codingStandard}
                      onChange={(e) => setInstructionsForm((x) => ({ ...x, codingStandard: e.target.value }))}
                    >
                      {CODING_STANDARD_OPTIONS.map((option) => (
                        <option key={option.value || "none"} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  </FormControl>
                  <FormControl isDisabled={instructionsForm.codingStandard !== "Other"}>
                    <FormLabel>Coding Standard (Other)</FormLabel>
                    <Input
                      value={instructionsForm.codingStandardOther}
                      onChange={(e) => setInstructionsForm((x) => ({ ...x, codingStandardOther: e.target.value }))}
                    />
                  </FormControl>
                  <FormControl gridColumn={{ md: "1 / span 2" }}>
                    <FormLabel>Other</FormLabel>
                    <Textarea
                      rows={4}
                      value={instructionsForm.projectOther}
                      onChange={(e) => setInstructionsForm((x) => ({ ...x, projectOther: e.target.value }))}
                    />
                  </FormControl>
                </Grid>
                <Button mt={4} colorScheme="teal" type="submit" isLoading={savingProjectInstructions}>
                  Save Project Prompt
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
