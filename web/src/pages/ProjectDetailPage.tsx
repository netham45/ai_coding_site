import {
  Badge,
  Box,
  Button,
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
import { api } from "../api/client";
import type { Project, Task } from "../api/types";
import { TaskSidebar } from "../components/TaskSidebar";

type ProjectResponse = { project: Project };
type TasksResponse = { tasks: Task[] };
type ProjectIdeStartResponse = { launchUrl: string };
type ProjectFilesResponse = { files: string[] };

type CreateTaskForm = {
  title: string;
  taskPrompt: string;
  aiCommand: string;
  dependencyTaskIds: string[];
};

type ProjectInstructionsForm = {
  projectPrompt: string;
  projectRules: string;
  codingStandard: string;
  codingStandardOther: string;
  projectOther: string;
};

const initialForm: CreateTaskForm = {
  title: "",
  taskPrompt: "",
  aiCommand: "codex --yolo {prompt}",
  dependencyTaskIds: []
};

const NON_SELECTABLE_DEPENDENCY_STATUSES = new Set(["merged", "cancelled", "failed"]);

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
  const [form, setForm] = useState<CreateTaskForm>(initialForm);
  const [instructionsForm, setInstructionsForm] = useState<ProjectInstructionsForm>({
    projectPrompt: "",
    projectRules: "",
    codingStandard: "",
    codingStandardOther: "",
    projectOther: ""
  });
  const [loading, setLoading] = useState(false);
  const [savingProjectInstructions, setSavingProjectInstructions] = useState(false);
  const [activePane, setActivePane] = useState<"tasks" | "project" | "ide">("tasks");
  const [projectIdeLaunchUrl, setProjectIdeLaunchUrl] = useState<string | null>(null);
  const [startingProjectIde, setStartingProjectIde] = useState(false);
  const [projectIdeStartFailed, setProjectIdeStartFailed] = useState(false);
  const [projectIdeRetryNonce, setProjectIdeRetryNonce] = useState(0);
  const [expandedIde, setExpandedIde] = useState(false);
  const [isTaskSidebarCollapsed, setIsTaskSidebarCollapsed] = useState(false);
  const projectIdeAutoAttemptedRef = useRef(false);
  const taskPromptRef = useRef<HTMLTextAreaElement | null>(null);
  const suggestionRequestSeqRef = useRef(0);
  const suggestionDebounceRef = useRef<number | null>(null);
  const [fileSuggestions, setFileSuggestions] = useState<string[]>([]);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const [mentionRange, setMentionRange] = useState<{ start: number; end: number } | null>(null);
  const [mentionQuery, setMentionQuery] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [dependencySelections, setDependencySelections] = useState<string[]>([""]);

  const selectableDependencyTasks = useMemo(
    () => tasks.filter((task) => !NON_SELECTABLE_DEPENDENCY_STATUSES.has(task.status)),
    [tasks]
  );

  const canCreate = useMemo(() => {
    return form.title.trim().length >= 2 && form.taskPrompt.trim().length > 0;
  }, [form]);

  const closeSuggestions = () => {
    setShowSuggestions(false);
    setMentionRange(null);
    setMentionQuery("");
    setFileSuggestions([]);
    setActiveSuggestionIndex(0);
  };

  const updateMentionContext = (text: string, cursor: number | null) => {
    if (!projectId || cursor === null || cursor < 0) {
      closeSuggestions();
      return;
    }

    const atPos = text.lastIndexOf("@", cursor - 1);
    if (atPos < 0) {
      closeSuggestions();
      return;
    }

    const token = text.slice(atPos + 1, cursor);
    if (/\s/.test(token)) {
      closeSuggestions();
      return;
    }

    if (token.includes("@")) {
      closeSuggestions();
      return;
    }

    setMentionRange({ start: atPos, end: cursor });
    setMentionQuery(token);
    setShowSuggestions(true);
  };

  const insertSuggestion = (filePath: string) => {
    if (!mentionRange) return;
    const before = form.taskPrompt.slice(0, mentionRange.start + 1);
    const after = form.taskPrompt.slice(mentionRange.end);
    const nextTaskPrompt = `${before}${filePath}${after}`;
    const nextCursorPos = mentionRange.start + 1 + filePath.length;

    setForm((prev) => ({ ...prev, taskPrompt: nextTaskPrompt }));
    closeSuggestions();

    window.requestAnimationFrame(() => {
      const input = taskPromptRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(nextCursorPos, nextCursorPos);
    });
  };

  useEffect(() => {
    if (!showSuggestions || !projectId || !mentionRange) return;

    if (suggestionDebounceRef.current !== null) {
      window.clearTimeout(suggestionDebounceRef.current);
    }

    suggestionDebounceRef.current = window.setTimeout(() => {
      const requestSeq = ++suggestionRequestSeqRef.current;
      api<ProjectFilesResponse>(
        `/api/projects/${projectId}/files?query=${encodeURIComponent(mentionQuery)}&limit=8`
      )
        .then((response) => {
          if (requestSeq !== suggestionRequestSeqRef.current) return;
          setFileSuggestions(response.files);
          setActiveSuggestionIndex(0);
        })
        .catch(() => {
          if (requestSeq !== suggestionRequestSeqRef.current) return;
          setFileSuggestions([]);
        });
    }, 120);

    return () => {
      if (suggestionDebounceRef.current !== null) {
        window.clearTimeout(suggestionDebounceRef.current);
      }
    };
  }, [mentionQuery, mentionRange, projectId, showSuggestions]);

  useEffect(() => {
    return () => {
      if (suggestionDebounceRef.current !== null) {
        window.clearTimeout(suggestionDebounceRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const selectableIds = new Set(selectableDependencyTasks.map((task) => task.id));
    setDependencySelections((prev) => {
      const next = prev.map((id) => (id && selectableIds.has(id) ? id : ""));
      const hasChanged = next.length !== prev.length || next.some((id, index) => id !== prev[index]);
      return hasChanged ? next : prev;
    });
  }, [selectableDependencyTasks]);

  async function loadData() {
    if (!projectId) return;
    const [projectRes, tasksRes] = await Promise.all([
      api<ProjectResponse>(`/api/projects/${projectId}`),
      api<TasksResponse>(`/api/projects/${projectId}/tasks`)
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

    const dependencyTaskIds = [...new Set(dependencySelections.filter((id) => id))];

    setLoading(true);
    try {
      const created = await api<{ task: Task }>(`/api/projects/${projectId}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          title: form.title,
          taskPrompt: form.taskPrompt,
          aiCommand: form.aiCommand,
          dependencyTaskIds
        })
      });
      setForm(initialForm);
      setDependencySelections([""]);
      await loadData();
      toast({ status: "success", title: "Task created" });
      navigate(`/tasks/${created.task.id}?tab=ide`);
    } catch (error: any) {
      toast({ status: "error", title: "Task create failed", description: error.message });
    } finally {
      setLoading(false);
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
          index={activePane === "tasks" ? 0 : activePane === "project" ? 1 : 2}
          onChange={(index) => setActivePane(index === 0 ? "tasks" : index === 1 ? "project" : "ide")}
          colorScheme="teal"
        >
          <TabList>
            <Tab>Tasks</Tab>
            <Tab>Project Prompt</Tab>
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
                  <FormControl>
                    <FormLabel>Dependencies</FormLabel>
                    <Stack spacing={2}>
                      {dependencySelections.map((selectedId, index) => (
                        <Flex key={`dependency-row-${index}`} gap={2}>
                          <Select
                            placeholder="Select dependency"
                            value={selectedId}
                            onChange={(e) => {
                              const value = e.target.value;
                              setDependencySelections((prev) => prev.map((id, rowIndex) => (rowIndex === index ? value : id)));
                            }}
                          >
                            {selectableDependencyTasks.map((task) => {
                              const selectedElsewhere = dependencySelections.includes(task.id) && selectedId !== task.id;
                              return (
                                <option key={task.id} value={task.id} disabled={selectedElsewhere}>
                                  {task.title} ({task.isBlocked ? "blocked" : task.status})
                                </option>
                              );
                            })}
                          </Select>
                          <Button
                            type="button"
                            size="sm"
                            minW="40px"
                            onClick={() => {
                              setDependencySelections((prev) => [...prev, ""]);
                            }}
                          >
                            +
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            minW="40px"
                            onClick={() => {
                              setDependencySelections((prev) => {
                                if (prev.length === 1) return [""];
                                return prev.filter((_, rowIndex) => rowIndex !== index);
                              });
                            }}
                            isDisabled={dependencySelections.length === 1}
                          >
                            -
                          </Button>
                        </Flex>
                      ))}
                    </Stack>
                    <Text mt={1} fontSize="sm" color="gray.600">
                      Add dependencies one row at a time. This task stays blocked until all selected tasks are merged.
                    </Text>
                  </FormControl>
                  <FormControl gridColumn={{ md: "1 / span 2" }} isRequired>
                    <FormLabel>Task Prompt</FormLabel>
                    <Box position="relative">
                      <Textarea
                        ref={taskPromptRef}
                        rows={5}
                        value={form.taskPrompt}
                        onChange={(e) => {
                          const value = e.target.value;
                          const cursor = e.target.selectionStart;
                          setForm((x) => ({ ...x, taskPrompt: value }));
                          updateMentionContext(value, cursor);
                        }}
                        onClick={(e) => {
                          updateMentionContext(e.currentTarget.value, e.currentTarget.selectionStart);
                        }}
                        onKeyUp={(e) => {
                          updateMentionContext(e.currentTarget.value, e.currentTarget.selectionStart);
                        }}
                        onBlur={() => {
                          window.setTimeout(() => {
                            closeSuggestions();
                          }, 100);
                        }}
                        onKeyDown={(e) => {
                          if (!showSuggestions || fileSuggestions.length === 0) return;
                          if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setActiveSuggestionIndex((index) => (index + 1) % fileSuggestions.length);
                            return;
                          }
                          if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setActiveSuggestionIndex((index) => (index - 1 + fileSuggestions.length) % fileSuggestions.length);
                            return;
                          }
                          if (e.key === "Enter" || e.key === "Tab") {
                            e.preventDefault();
                            const picked = fileSuggestions[activeSuggestionIndex];
                            if (picked) {
                              insertSuggestion(picked);
                            }
                            return;
                          }
                          if (e.key === "Escape") {
                            e.preventDefault();
                            closeSuggestions();
                          }
                        }}
                      />
                      {showSuggestions && (
                        <Box
                          position="absolute"
                          top="calc(100% + 6px)"
                          left={0}
                          right={0}
                          zIndex={20}
                          bg="white"
                          border="1px solid"
                          borderColor="blackAlpha.300"
                          borderRadius="md"
                          boxShadow="md"
                          maxH="220px"
                          overflowY="auto"
                          p={1}
                        >
                          {fileSuggestions.length ? (
                            <Stack spacing={1}>
                              {fileSuggestions.map((file, index) => (
                                <Button
                                  key={file}
                                  justifyContent="space-between"
                                  variant={index === activeSuggestionIndex ? "solid" : "ghost"}
                                  colorScheme={index === activeSuggestionIndex ? "teal" : undefined}
                                  onMouseDown={(event) => {
                                    event.preventDefault();
                                    insertSuggestion(file);
                                  }}
                                  size="sm"
                                  fontFamily="mono"
                                  fontWeight="500"
                                >
                                  {file}
                                </Button>
                              ))}
                            </Stack>
                          ) : (
                            <Flex px={2} py={2} align="center" justify="space-between">
                              <Text fontSize="sm" color="gray.600">
                                No file matches
                              </Text>
                              <Badge colorScheme="gray">@{mentionQuery}</Badge>
                            </Flex>
                          )}
                        </Box>
                      )}
                    </Box>
                  </FormControl>
                </Grid>
                <Button mt={4} colorScheme="teal" type="submit" isDisabled={!canCreate} isLoading={loading}>
                  Create Task
                </Button>
              </form>
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
