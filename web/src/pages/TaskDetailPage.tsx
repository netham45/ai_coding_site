import { Badge, Box, Button, Checkbox, Code, Flex, Heading, Link, Stack, Tab, TabList, TabPanel, TabPanels, Tabs, Text, Textarea, useToast } from "@chakra-ui/react";
import { useEffect, useRef, useState } from "react";
import { Link as RouterLink, useSearchParams, useParams } from "react-router-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { api } from "../api/client";
import { TaskSidebar } from "../components/TaskSidebar";
import type { GitStatusSummary, IdeInstance, MergeRecord, PlanRevision, Project, Task, TaskSession, TaskStatus, TaskTransition } from "../api/types";

type TaskDetailResponse = {
  task: Task;
  transitions: TaskTransition[];
  session: TaskSession | null;
  ide: IdeInstance | null;
  gitStatus: GitStatusSummary | null;
  mergeRecords: MergeRecord[];
};

type TasksResponse = {
  tasks: Task[];
};

type ProjectResponse = {
  project: Project;
};

type TerminalTokenResponse = {
  token: string;
  expiresAt: string;
  wsPath: string;
};

type IdeStartResponse = {
  ide: IdeInstance;
  launchUrl: string;
};

type PlanDetailResponse = {
  plan: Task;
  transitions: TaskTransition[];
  revisions: PlanRevision[];
  approvedTasks: Task[];
};

type TerminalMessage =
  | { type: "hello"; taskId: string; sessionId: string }
  | { type: "output"; data: string; reset?: boolean; cursorX?: number; cursorY?: number }
  | { type: "status"; sessionStatus: string; taskStatus?: string }
  | { type: "error"; message: string }
  | { type: "ack" };

const TASK_STATUSES: TaskStatus[] = ["queued", "in_progress", "waiting_input", "merge_ready", "merged", "cancelled", "failed", "merge_conflict"];

function isTaskStatus(status: string): status is TaskStatus {
  return TASK_STATUSES.includes(status as TaskStatus);
}

function statusColor(status: Task["status"]) {
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

export function TaskDetailPage() {
  const { taskId, planId } = useParams();
  const entityId = taskId ?? planId;
  const [searchParams] = useSearchParams();
  const toast = useToast();

  const [task, setTask] = useState<Task | null>(null);
  const [projectName, setProjectName] = useState<string>("");
  const [projectTasks, setProjectTasks] = useState<Task[]>([]);
  const [transitions, setTransitions] = useState<TaskTransition[]>([]);
  const [mergeRecords, setMergeRecords] = useState<MergeRecord[]>([]);
  const [session, setSession] = useState<TaskSession | null>(null);
  const [ide, setIde] = useState<IdeInstance | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatusSummary | null>(null);
  const [ideLaunchUrl, setIdeLaunchUrl] = useState<string | null>(null);
  const [activePane, setActivePane] = useState<"ide" | "terminal" | "info">("ide");
  const [expandedPane, setExpandedPane] = useState<"ide" | "terminal" | null>(null);
  const [terminalState, setTerminalState] = useState<"disconnected" | "connecting" | "connected">("disconnected");
  const [syncingMain, setSyncingMain] = useState(false);
  const [mergingTask, setMergingTask] = useState(false);
  const [markingReady, setMarkingReady] = useState(false);
  const [rerunningTask, setRerunningTask] = useState(false);
  const [cancellingTask, setCancellingTask] = useState(false);
  const [isTaskSidebarCollapsed, setIsTaskSidebarCollapsed] = useState(false);
  const [planRevisions, setPlanRevisions] = useState<PlanRevision[]>([]);
  const [approvedPlanTasks, setApprovedPlanTasks] = useState<Task[]>([]);
  const [planFeedback, setPlanFeedback] = useState("");
  const [extractingPlan, setExtractingPlan] = useState(false);
  const [regeneratingPlan, setRegeneratingPlan] = useState(false);
  const [approvingPlan, setApprovingPlan] = useState(false);
  const [autoMergeItemKeys, setAutoMergeItemKeys] = useState<string[]>([]);

  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const autoStartedForTaskRef = useRef<Set<string>>(new Set());

  async function loadTask() {
    if (!entityId) return;
    const response = await api<TaskDetailResponse>(`/api/tasks/${entityId}`);
    setTask(response.task);
    setTransitions(response.transitions);
    setSession(response.session);
    setIde(response.ide);
    setGitStatus(response.gitStatus);
    setMergeRecords(response.mergeRecords ?? []);
    const planContextId = response.task.mode === "plan" ? response.task.id : response.task.parentPlanTaskId;
    if (planContextId) {
      await loadPlanDetails(planContextId);
    } else {
      setPlanRevisions([]);
      setApprovedPlanTasks([]);
    }
  }

  async function loadPlanDetails(currentPlanId: string) {
    const response = await api<PlanDetailResponse>(`/api/plans/${currentPlanId}`);
    setPlanRevisions(response.revisions ?? []);
    setApprovedPlanTasks(response.approvedTasks ?? []);
  }

  async function loadProjectContext(projectId: string) {
    const [tasksRes, projectRes] = await Promise.all([
      api<TasksResponse>(`/api/projects/${projectId}/tasks`),
      api<ProjectResponse>(`/api/projects/${projectId}`)
    ]);
    setProjectTasks(tasksRes.tasks);
    setProjectName(projectRes.project.name);
  }

  useEffect(() => {
    setIdeLaunchUrl(null);
    const tab = searchParams.get("tab");
    setActivePane(tab === "terminal" ? "terminal" : tab === "info" ? "info" : "ide");
    setExpandedPane(null);
    setIsTaskSidebarCollapsed(false);
    loadTask().catch((error: Error) => {
      toast({ status: "error", title: "Failed to load task", description: error.message });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, searchParams]);

  useEffect(() => {
    if (!task?.projectId) return;
    loadProjectContext(task.projectId).catch((error: Error) => {
      toast({ status: "error", title: "Failed to load task list", description: error.message });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.projectId]);

  useEffect(() => {
    if (!task) return;
    const nextTitle = projectName ? `${projectName} - ${task.title}` : task.title;
    document.title = nextTitle;
    return () => {
      document.title = "AI Coding Web View";
    };
  }, [projectName, task]);

  useEffect(() => {
    if (!entityId || !task) return;
    if (autoStartedForTaskRef.current.has(entityId)) return;
    autoStartedForTaskRef.current.add(entityId);

    (async () => {
      let shouldReload = false;
      const runtimeActive = !!session && ["starting", "running", "waiting_input"].includes(session.status);
      const ideActive = !!ide && ["starting", "running"].includes(ide.status);

      if (!runtimeActive && !task.isBlocked && !["merge_ready", "merged", "cancelled", "failed"].includes(task.status)) {
        try {
          await api(`/api/tasks/${entityId}/start`, { method: "POST" });
          shouldReload = true;
        } catch {
          // best effort autostart
        }
      }

      if (!ideActive) {
        try {
          const response = await api<IdeStartResponse>(`/api/tasks/${entityId}/ide/start`, { method: "POST" });
          setIde(response.ide);
          setIdeLaunchUrl(response.launchUrl);
          shouldReload = true;
        } catch {
          // best effort autostart
        }
      }

      if (shouldReload) {
        await loadTask();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, task?.id, task?.isBlocked]);

  useEffect(() => {
    if (!terminalContainerRef.current || terminalRef.current) {
      return;
    }

    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      theme: {
        background: "#0f1720",
        foreground: "#e7edf3"
      }
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalContainerRef.current);
    fitAddon.fit();
    if (session?.lastOutput) {
      term.write(session.lastOutput);
    }

    term.onData((data) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      ws.send(JSON.stringify({ type: "input", data }));
    });

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    const onResize = () => fitAddon.fit();
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      wsRef.current?.close();
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [session?.lastOutput]);

  useEffect(() => {
    const term = terminalRef.current;
    if (!term || !session?.lastOutput) {
      return;
    }
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }
    term.clear();
    term.write(session.lastOutput);
  }, [session?.id, session?.lastOutput]);

  async function connectTerminal() {
    if (!entityId) return;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      return;
    }

    setTerminalState("connecting");
    const term = terminalRef.current;

    try {
      const tokenData = await api<TerminalTokenResponse>(`/api/tasks/${entityId}/terminal-token`);
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${protocol}://${window.location.host}${tokenData.wsPath}?token=${encodeURIComponent(tokenData.token)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setTerminalState("connected");
      };

      ws.onmessage = (event) => {
        const payload = JSON.parse(String(event.data)) as TerminalMessage;
        if (payload.type === "output") {
          if (payload.reset) {
            term?.clear();
          }
          term?.write(payload.data, () => {
            if (!term) return;
            if (typeof payload.cursorX === "number" && typeof payload.cursorY === "number") {
              const row = Math.max(1, payload.cursorY - 2);
              const col = Math.max(1, payload.cursorX + 1);
              term.write(`\u001b[${row};${col}H`);
              term.scrollToBottom();
            } else {
              term.scrollToBottom();
            }
          });
          return;
        }
        if (payload.type === "error") {
          term?.writeln(`\r\n[error] ${payload.message}\r\n`);
          return;
        }
        if (payload.type === "status") {
          setSession((current) => {
            if (!current || current.status === payload.sessionStatus) {
              return current;
            }
            return { ...current, status: payload.sessionStatus as TaskSession["status"] };
          });
          const nextTaskStatus = payload.taskStatus;
          if (nextTaskStatus && isTaskStatus(nextTaskStatus)) {
            setTask((current) => {
              if (!current || current.status === nextTaskStatus) {
                return current;
              }
              return { ...current, status: nextTaskStatus };
            });
            setProjectTasks((current) =>
              current.map((item) => (item.id === entityId && item.status !== nextTaskStatus ? { ...item, status: nextTaskStatus } : item))
            );
          }
        }
      };

      ws.onclose = () => {
        setTerminalState("disconnected");
        wsRef.current = null;
        if (session && ["starting", "running", "waiting_input"].includes(session.status)) {
          reconnectTimerRef.current = window.setTimeout(() => {
            connectTerminal().catch(() => {
              // no-op
            });
          }, 1500);
        }
      };

      ws.onerror = () => {
        setTerminalState("disconnected");
      };
    } catch (error: any) {
      setTerminalState("disconnected");
      toast({ status: "error", title: "Terminal connect failed", description: error.message });
    }
  }

  useEffect(() => {
    if (session && ["starting", "running", "waiting_input"].includes(session.status)) {
      connectTerminal().catch(() => {
        // handled in connectTerminal
      });
    } else {
      wsRef.current?.close();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, session?.status]);

  useEffect(() => {
    const fit = () => {
      fitAddonRef.current?.fit();
    };
    window.setTimeout(fit, 40);
  }, [activePane, expandedPane]);

  useEffect(() => {
    if (!expandedPane) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [expandedPane]);

  useEffect(() => {
    if (!entityId) return;
    if (!ide || !["starting", "running"].includes(ide.status)) return;
    if (ideLaunchUrl) return;

    api<IdeStartResponse>(`/api/tasks/${entityId}/ide/start`, { method: "POST" })
      .then((response) => {
        setIde(response.ide);
        setIdeLaunchUrl(response.launchUrl);
      })
      .catch(() => {
        // best-effort recovery
      });
  }, [entityId, ide?.id, ide?.status, ideLaunchUrl]);

  async function pullFromMain() {
    if (!entityId) return;
    setSyncingMain(true);
    try {
      const response = await api<{ task: Task; sync: { conflicted: boolean; conflictFiles: string[]; headCommitSha: string } }>(
        `/api/tasks/${entityId}/pull-main`,
        { method: "POST" }
      );
      await loadTask();
      if (task?.projectId) {
        await loadProjectContext(task.projectId);
      }
      if (response.sync.conflicted) {
        const count = response.sync.conflictFiles.length;
        toast({
          status: "warning",
          title: isPlanOwnedExecutionTask ? "Pulled from plan branch with conflicts" : "Pulled from main with conflicts",
          description: count ? `${count} conflict file(s) detected.` : "Conflicts detected."
        });
      } else {
        toast({ status: "success", title: isPlanOwnedExecutionTask ? "Pulled latest plan branch into task workspace" : "Pulled latest main into task workspace" });
      }
    } catch (error: any) {
      toast({ status: "error", title: "Pull from main failed", description: error.message });
    } finally {
      setSyncingMain(false);
    }
  }

  async function markMergeReady() {
    if (!entityId) return;
    setMarkingReady(true);
    try {
      await api<{ task: Task }>(`/api/tasks/${entityId}/mark-merge-ready`, { method: "POST" });
      await loadTask();
      toast({ status: "success", title: "Task marked merge_ready" });
    } catch (error: any) {
      toast({ status: "error", title: "Mark merge-ready failed", description: error.message });
    } finally {
      setMarkingReady(false);
    }
  }

  async function mergeTask() {
    if (!entityId) return;
    setMergingTask(true);
    try {
      await api<{ task: Task; mergeRecords: MergeRecord[] }>(`/api/tasks/${entityId}/merge`, { method: "POST" });
      await loadTask();
      if (task?.projectId) {
        await loadProjectContext(task.projectId);
      }
      toast({ status: "success", title: "Merge action completed" });
    } catch (error: any) {
      toast({ status: "error", title: "Merge failed", description: error.message });
    } finally {
      setMergingTask(false);
    }
  }

  async function cancelTask() {
    if (!entityId) return;
    const reason = window.prompt("Cancel reason:");
    if (!reason || !reason.trim()) return;
    setCancellingTask(true);
    try {
      await api<{ task: Task }>(`/api/tasks/${entityId}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() })
      });
      await loadTask();
      if (task?.projectId) {
        await loadProjectContext(task.projectId);
      }
      toast({ status: "info", title: "Task cancelled" });
    } catch (error: any) {
      toast({ status: "error", title: "Cancel failed", description: error.message });
    } finally {
      setCancellingTask(false);
    }
  }

  async function rerunTask() {
    if (!entityId) return;
    const confirmed = window.confirm(
      "Re-run this task?\n\nThis will reset only this task workspace repo to the current local base snapshot and restart the task.\nAll unpushed task progress will be permanently lost."
    );
    if (!confirmed) return;

    setRerunningTask(true);
    try {
      await api<{ task: Task }>(`/api/tasks/${entityId}/rerun`, { method: "POST" });
      setIdeLaunchUrl(null);
      try {
        await api(`/api/tasks/${entityId}/start`, { method: "POST" });
      } catch {
        // best-effort restart
      }
      try {
        const ideResponse = await api<IdeStartResponse>(`/api/tasks/${entityId}/ide/start`, { method: "POST" });
        setIde(ideResponse.ide);
        setIdeLaunchUrl(ideResponse.launchUrl);
      } catch {
        // best-effort restart
      }
      await loadTask();
      if (task?.projectId) {
        await loadProjectContext(task.projectId);
      }
      toast({ status: "success", title: "Task re-run started" });
    } catch (error: any) {
      toast({ status: "error", title: "Re-run failed", description: error.message });
    } finally {
      setRerunningTask(false);
    }
  }

  async function extractPlanTasks() {
    if (!entityId) return;
    setExtractingPlan(true);
    try {
      await api<{ ok: boolean }>(`/api/plans/${entityId}/extract`, { method: "POST" });
      await loadTask();
      toast({ status: "success", title: "Plan tasks extracted" });
    } catch (error: any) {
      toast({ status: "error", title: "Extract failed", description: error.message });
    } finally {
      setExtractingPlan(false);
    }
  }

  async function regeneratePlanTasks() {
    if (!entityId || !planFeedback.trim()) return;
    setRegeneratingPlan(true);
    try {
      await api<{ ok: boolean }>(`/api/plans/${entityId}/regenerate`, {
        method: "POST",
        body: JSON.stringify({ feedback: planFeedback.trim() })
      });
      setPlanFeedback("");
      await loadTask();
      toast({ status: "info", title: "Feedback sent to plan runtime" });
    } catch (error: any) {
      toast({ status: "error", title: "Regenerate failed", description: error.message });
    } finally {
      setRegeneratingPlan(false);
    }
  }

  async function approvePlanTasks() {
    if (!entityId) return;
    const confirmed = window.confirm(
      `Approve all tasks from the latest proposed plan revision?\n\nAuto-merge enabled for ${autoMergeItemKeys.length} task(s).`
    );
    if (!confirmed) return;
    setApprovingPlan(true);
    try {
      await api<{ approvedTasks: Task[] }>(`/api/plans/${entityId}/approve`, {
        method: "POST",
        body: JSON.stringify({ autoMergeItemKeys })
      });
      await loadTask();
      if (task?.projectId) {
        await loadProjectContext(task.projectId);
      }
      toast({ status: "success", title: "Plan approved and tasks created" });
    } catch (error: any) {
      toast({ status: "error", title: "Approve failed", description: error.message });
    } finally {
      setApprovingPlan(false);
    }
  }

  const latestProposedRevision = planRevisions.find((revision) => revision.status === "proposed");
  const latestProposedItemKeys = (latestProposedRevision?.items ?? []).map((item) => item.itemKey);
  const allAutoMergeSelected = latestProposedItemKeys.length > 0 && latestProposedItemKeys.every((itemKey) => autoMergeItemKeys.includes(itemKey));
  const someAutoMergeSelected = autoMergeItemKeys.length > 0 && !allAutoMergeSelected;

  useEffect(() => {
    if (!latestProposedItemKeys.length) {
      setAutoMergeItemKeys([]);
      return;
    }
    setAutoMergeItemKeys((current) => current.filter((itemKey) => latestProposedItemKeys.includes(itemKey)));
  }, [latestProposedRevision?.id]);

  if (!task) {
    return <Text>Loading task...</Text>;
  }
  const inPlanContext = task.mode === "plan" || !!task.parentPlanTaskId;
  const sidebarTasks = inPlanContext ? approvedPlanTasks : projectTasks;
  const backLinkTo = task.parentPlanTaskId ? `/plans/${task.parentPlanTaskId}?tab=ide` : `/projects/${task.projectId}`;
  const backLinkLabel = task.parentPlanTaskId ? "Back to plan" : "Back to project";
  const dependencyTitles = task.dependencyTaskIds.map((id) => projectTasks.find((x) => x.id === id)?.title || id);
  const blockedByTitles = task.blockedByTaskIds.map((id) => projectTasks.find((x) => x.id === id)?.title || id);
  const isPlanOwnedExecutionTask = task.mode === "execution" && !!task.parentPlanTaskId;

  const renderIdePanel = (height: string) => {
    if (ideLaunchUrl) {
      return (
        <Box border="1px solid" borderColor="blackAlpha.300" borderRadius="md" overflow="hidden">
          <Box as="iframe" src={ideLaunchUrl} title="Task IDE" h={height} w="full" border="0" sandbox="allow-same-origin allow-scripts" />
        </Box>
      );
    }
    return <Text color="gray.700">Starting IDE session...</Text>;
  };

  const renderTerminalPanel = (height: string) => (
    task.isBlocked ? (
      <Text color="orange.700">Task is blocked by unmerged dependencies. Runtime start is disabled.</Text>
    ) : (
    <Box border="1px solid" borderColor="blackAlpha.300" borderRadius="md" p={2} bg="#0f1720">
      <Box ref={terminalContainerRef} h={height} />
    </Box>
    )
  );

  return (
    <Flex direction={{ base: "column", lg: "row" }} gap={6} align="stretch">
      {!expandedPane && (
        <TaskSidebar
          tasks={sidebarTasks}
          selectedTaskId={task.id}
          isCollapsed={isTaskSidebarCollapsed}
          onToggleCollapse={() => setIsTaskSidebarCollapsed((value) => !value)}
        />
      )}

      <Box flex="1" bg="white" borderRadius={expandedPane ? "none" : "lg"} p={expandedPane ? 0 : 6} boxShadow={expandedPane ? "none" : "sm"} border={expandedPane ? "none" : "1px solid"} borderColor="blackAlpha.200">
        <Box mb={4}>
          <Link as={RouterLink} to={backLinkTo} color="teal.600" fontWeight="600">
            {backLinkLabel}
          </Link>
          <Heading size="lg" mt={2}>
            {projectName ? `${projectName} - ${task.title}` : task.title}
          </Heading>
          <Stack direction="row" mt={2} align="center">
            <Badge colorScheme={task.mode === "plan" ? "purple" : "cyan"}>{task.mode}</Badge>
            <Badge colorScheme={task.isBlocked ? "orange" : statusColor(task.status)}>{taskStatusLabel(task)}</Badge>
            <Badge colorScheme={terminalState === "connected" ? "green" : terminalState === "connecting" ? "blue" : "gray"}>
              terminal: {terminalState}
            </Badge>
            <Badge colorScheme={ide?.status === "running" ? "green" : ide?.status === "starting" ? "blue" : "gray"}>
              ide: {ide?.status ?? "stopped"}
            </Badge>
          </Stack>
        </Box>

        <Tabs index={activePane === "ide" ? 0 : activePane === "terminal" ? 1 : 2} onChange={(next) => setActivePane(next === 0 ? "ide" : next === 1 ? "terminal" : "info")} colorScheme="teal">
          <TabList>
            <Tab>IDE</Tab>
            <Tab>Terminal</Tab>
            <Tab>Task Info</Tab>
          </TabList>
          <TabPanels>
            <TabPanel px={0} pt={4}>
              <Box
                position={expandedPane === "ide" ? "fixed" : "relative"}
                inset={expandedPane === "ide" ? "0" : "auto"}
                zIndex={expandedPane === "ide" ? 2000 : "auto"}
                bg="white"
              >
                <Flex h="44px" px={3} borderBottom="1px solid" borderColor="blackAlpha.300" align="center" justify="space-between">
                  <Text fontWeight="700">IDE</Text>
                  {expandedPane === "ide" ? (
                    <Button size="sm" onClick={() => setExpandedPane(null)}>
                      Exit Full View
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => setExpandedPane("ide")}>
                      Expand
                    </Button>
                  )}
                </Flex>
                <Box p={2}>{renderIdePanel(expandedPane === "ide" ? "calc(100vh - 60px)" : "640px")}</Box>
              </Box>
              <Text mt={3} fontSize="sm" color="gray.600">
                Git snapshot:{" "}
                {gitStatus
                  ? `${gitStatus.branch} | +${gitStatus.ahead}/-${gitStatus.behind} | staged ${gitStatus.staged} | unstaged ${gitStatus.unstaged} | untracked ${gitStatus.untracked}`
                  : "unavailable"}
              </Text>
            </TabPanel>

            <TabPanel px={0} pt={4}>
              <Box
                position={expandedPane === "terminal" ? "fixed" : "relative"}
                inset={expandedPane === "terminal" ? "0" : "auto"}
                zIndex={expandedPane === "terminal" ? 2000 : "auto"}
                bg="white"
              >
                <Flex h="44px" px={3} borderBottom="1px solid" borderColor="blackAlpha.300" align="center" justify="space-between">
                  <Text fontWeight="700">Terminal</Text>
                  {expandedPane === "terminal" ? (
                    <Button size="sm" onClick={() => setExpandedPane(null)}>
                      Exit Full View
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => setExpandedPane("terminal")}>
                      Expand
                    </Button>
                  )}
                </Flex>
                <Box p={2}>{renderTerminalPanel(expandedPane === "terminal" ? "calc(100vh - 60px)" : "520px")}</Box>
              </Box>
            </TabPanel>

            <TabPanel px={0} pt={4}>
              <Stack spacing={5}>
                <Flex justify="flex-end">
                  {task.mode === "plan" ? (
                    <Stack direction={{ base: "column", md: "row" }} spacing={2}>
                      <Button colorScheme="purple" variant="outline" size="sm" onClick={extractPlanTasks} isLoading={extractingPlan}>
                        Extract Proposed Tasks
                      </Button>
                      <Button colorScheme="green" size="sm" onClick={approvePlanTasks} isLoading={approvingPlan} isDisabled={!latestProposedRevision}>
                        Approve All Tasks
                      </Button>
                      <Button
                        colorScheme="blue"
                        variant="outline"
                        size="sm"
                        onClick={markMergeReady}
                        isLoading={markingReady}
                        isDisabled={!["in_progress", "waiting_input", "merge_conflict", "merged"].includes(task.status)}
                      >
                        Mark Merge Ready
                      </Button>
                      <Button colorScheme="green" size="sm" onClick={mergeTask} isLoading={mergingTask} isDisabled={task.status !== "merge_ready"}>
                        Merge Plan To Base
                      </Button>
                      <Button colorScheme="orange" variant="outline" size="sm" onClick={rerunTask} isLoading={rerunningTask}>
                        Re-run Plan
                      </Button>
                      <Button
                        colorScheme="red"
                        variant="outline"
                        size="sm"
                        onClick={cancelTask}
                        isLoading={cancellingTask}
                        isDisabled={!["queued", "in_progress", "waiting_input", "merge_ready", "merge_conflict"].includes(task.status)}
                      >
                        Cancel Plan
                      </Button>
                    </Stack>
                  ) : (
                    <Stack direction={{ base: "column", md: "row" }} spacing={2}>
                      <Button colorScheme="teal" variant="outline" size="sm" onClick={pullFromMain} isLoading={syncingMain} isDisabled={task.isBlocked}>
                        {isPlanOwnedExecutionTask ? "Pull From Plan Branch" : "Pull From Main Repo"}
                      </Button>
                      <Button
                        colorScheme="blue"
                        variant="outline"
                        size="sm"
                        onClick={markMergeReady}
                        isLoading={markingReady}
                        isDisabled={task.isBlocked || !["in_progress", "waiting_input", "merge_conflict", "merged"].includes(task.status)}
                      >
                        Mark Merge Ready
                      </Button>
                      <Button colorScheme="green" size="sm" onClick={mergeTask} isLoading={mergingTask} isDisabled={task.status !== "merge_ready"}>
                        {isPlanOwnedExecutionTask ? "Merge Task Into Plan" : "Merge Task"}
                      </Button>
                      <Button colorScheme="orange" variant="outline" size="sm" onClick={rerunTask} isLoading={rerunningTask}>
                        Re-run Task
                      </Button>
                      <Button
                        colorScheme="red"
                        variant="outline"
                        size="sm"
                        onClick={cancelTask}
                        isLoading={cancellingTask}
                        isDisabled={!["queued", "in_progress", "waiting_input", "merge_ready", "merge_conflict"].includes(task.status)}
                      >
                        Cancel Task
                      </Button>
                    </Stack>
                  )}
                </Flex>

                <Box>
                  <Heading size="sm" mb={2}>
                    Task Folder (Disk Path)
                  </Heading>
                  <Code display="block" whiteSpace="pre-wrap" width="full" p={4} borderRadius="md">
                    {task.workspacePath}
                  </Code>
                </Box>

                {task.mode === "plan" && (
                  <Box>
                    <Heading size="sm" mb={2}>
                      Plan Review
                    </Heading>
                    <Stack spacing={3}>
                      <Box>
                        <Text mb={2} fontSize="sm" color="gray.700">
                          Feedback for re-generation
                        </Text>
                        <Textarea
                          rows={3}
                          value={planFeedback}
                          onChange={(e) => setPlanFeedback(e.target.value)}
                          placeholder="Tell the planner what to change, then regenerate."
                        />
                        <Button mt={2} colorScheme="purple" variant="outline" size="sm" onClick={regeneratePlanTasks} isLoading={regeneratingPlan} isDisabled={!planFeedback.trim()}>
                          Regenerate From Feedback
                        </Button>
                      </Box>

                      <Box>
                        <Text fontSize="sm" color="gray.700" mb={2}>
                          Latest proposed tasks: {latestProposedRevision?.items.length ?? 0}
                        </Text>
                        {!!latestProposedRevision?.items.length && (
                          <Checkbox
                            mb={2}
                            isChecked={allAutoMergeSelected}
                            isIndeterminate={someAutoMergeSelected}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setAutoMergeItemKeys(latestProposedItemKeys);
                                return;
                              }
                              setAutoMergeItemKeys([]);
                            }}
                          >
                            Select/Deselect all for Auto-merge
                          </Checkbox>
                        )}
                        <Stack spacing={2}>
                          {(latestProposedRevision?.items ?? []).map((item) => (
                            <Box key={item.id} border="1px solid" borderColor="blackAlpha.200" borderRadius="md" p={3}>
                              <Text fontWeight="700">
                                {item.ordinal}. {item.title} ({item.itemKey})
                              </Text>
                              <Checkbox
                                mt={2}
                                isChecked={autoMergeItemKeys.includes(item.itemKey)}
                                onChange={(e) => {
                                  setAutoMergeItemKeys((current) => {
                                    if (e.target.checked) {
                                      return current.includes(item.itemKey) ? current : [...current, item.itemKey];
                                    }
                                    return current.filter((value) => value !== item.itemKey);
                                  });
                                }}
                              >
                                Enable Auto-merge
                              </Checkbox>
                              <Text fontSize="sm" color="gray.700" whiteSpace="pre-wrap">
                                {item.prompt}
                              </Text>
                              <Text fontSize="sm" color="gray.600">
                                depends on: {item.dependsOnItemKeys.length ? item.dependsOnItemKeys.join(", ") : "none"}
                              </Text>
                            </Box>
                          ))}
                          {!latestProposedRevision?.items.length && <Text color="gray.600">No proposed plan tasks extracted yet.</Text>}
                        </Stack>
                      </Box>

                      <Box>
                        <Text fontSize="sm" color="gray.700" mb={2}>
                          Approved tasks from this plan: {approvedPlanTasks.length}
                        </Text>
                        <Stack spacing={1}>
                          {approvedPlanTasks.map((approvedTask) => (
                            <Link key={approvedTask.id} as={RouterLink} color="teal.700" fontWeight="600" to={`/tasks/${approvedTask.id}?tab=info`}>
                              {approvedTask.title}
                            </Link>
                          ))}
                          {!approvedPlanTasks.length && <Text color="gray.600">No approved tasks yet.</Text>}
                        </Stack>
                      </Box>
                    </Stack>
                  </Box>
                )}
                <Box>
                  <Heading size="sm" mb={2}>
                    Dependencies
                  </Heading>
                  <Stack spacing={2}>
                    <Text>depends on: {task.dependencyTaskIds.length}</Text>
                    {dependencyTitles.map((title, index) => (
                      <Text key={`${task.dependencyTaskIds[index]}-${index}`} fontSize="sm" color="gray.700">
                        {title}
                      </Text>
                    ))}
                    {!!task.blockedByTaskIds.length && (
                      <Text color="orange.700">blocked by {task.blockedByTaskIds.length} unmerged task(s)</Text>
                    )}
                    {blockedByTitles.map((title, index) => (
                      <Text key={`${task.blockedByTaskIds[index]}-${index}`} fontSize="sm" color="orange.700">
                        {title}
                      </Text>
                    ))}
                    {!task.dependencyTaskIds.length && <Text color="gray.600">No dependencies.</Text>}
                  </Stack>
                </Box>

                <Box>
                  <Heading size="sm" mb={2}>
                    Effective Prompt
                  </Heading>
                  <Code whiteSpace="pre-wrap" width="full" p={4} borderRadius="md">
                    {task.effectivePrompt}
                  </Code>
                </Box>

                <Box>
                  <Heading size="sm" mb={2}>
                    Task Prompt
                  </Heading>
                  <Code whiteSpace="pre-wrap" width="full" p={4} borderRadius="md">
                    {task.taskPrompt}
                  </Code>
                </Box>

                {(task.mode === "execution" || task.mode === "plan") && (
                  <Box>
                    <Heading size="sm" mb={3}>
                      {task.mode === "plan" ? "Plan Merge Audit" : "Merge Audit"}
                    </Heading>
                    <Stack spacing={3} mb={2}>
                      {mergeRecords.map((record) => (
                        <Box key={record.id} border="1px solid" borderColor="blackAlpha.200" borderRadius="md" p={3}>
                          <Stack direction={{ base: "column", md: "row" }} justify="space-between" align={{ base: "start", md: "center" }}>
                            <Badge
                              colorScheme={
                                record.status === "merged"
                                  ? "green"
                                  : record.status === "conflict"
                                    ? "orange"
                                    : record.status === "failed"
                                      ? "red"
                                      : "blue"
                              }
                            >
                              {record.status}
                            </Badge>
                            <Text fontSize="sm" color="gray.600">
                              {new Date(record.createdAt).toLocaleString()}
                            </Text>
                          </Stack>
                          <Text fontSize="sm" mt={1}>
                            source: {record.sourceCommitSha.slice(0, 12)} target: {record.targetBaseCommitSha.slice(0, 12)}
                          </Text>
                          {!!record.mergeCommitSha && (
                            <Text fontSize="sm" color="green.700">
                              merge commit: {record.mergeCommitSha.slice(0, 12)}
                            </Text>
                          )}
                          {!!record.conflictSummary && (
                            <Text fontSize="sm" color="orange.700" whiteSpace="pre-wrap">
                              conflicts: {record.conflictSummary}
                            </Text>
                          )}
                          {!!record.errorMessage && (
                            <Text fontSize="sm" color="red.700">
                              error: {record.errorMessage}
                            </Text>
                          )}
                        </Box>
                      ))}
                      {!mergeRecords.length && <Text color="gray.600">No merge records yet.</Text>}
                    </Stack>
                  </Box>
                )}

                <Box>
                  <Heading size="sm" mb={3}>
                    History
                  </Heading>
                  <Stack spacing={3}>
                    {transitions.map((item) => (
                      <Box key={item.id} border="1px solid" borderColor="blackAlpha.200" borderRadius="md" p={3}>
                        <Text fontWeight="600">
                          {item.fromStatus} -&gt; {item.toStatus}
                        </Text>
                        <Text fontSize="sm" color="gray.700">
                          reason: {item.reason}
                        </Text>
                        <Text fontSize="sm" color="gray.600">
                          {new Date(item.createdAt).toLocaleString()}
                        </Text>
                      </Box>
                    ))}
                    {!transitions.length && <Text color="gray.600">No transitions recorded.</Text>}
                  </Stack>
                </Box>
              </Stack>
            </TabPanel>
          </TabPanels>
        </Tabs>
      </Box>
    </Flex>
  );
}
