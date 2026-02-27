import {
  Accordion,
  AccordionButton,
  AccordionIcon,
  AccordionItem,
  AccordionPanel,
  Badge,
  Box,
  Button,
  Checkbox,
  Code,
  Flex,
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
import { useEffect, useRef, useState } from "react";
import { Link as RouterLink, useSearchParams, useParams } from "react-router-dom";
import {
  api,
  cancelWorkflowRun,
  approveNodeBudgetOverride,
  forceNodeReReview,
  getNode,
  getNodeWorkflowStatus,
  listWorkflowDefinitions,
  setNodeAutoMerge,
  setNodeAutoMode,
  setNodeWorkflowAssignment,
  startWorkflowRun,
  startNode,
  tickWorkflowRun
} from "../api/client";
import { NodeActionsPanel, type NodeActionLoadingState } from "../components/NodeActionsPanel";
import { TaskSidebar } from "../components/TaskSidebar";
import { WorkflowPanel } from "../components/WorkflowPanel";
import type {
  GitStatusSummary,
  IdeInstance,
  MergeRecord,
  OrchestrationNodeDetail,
  PlanRevision,
  Project,
  Task,
  TaskSession,
  TaskTransition,
  UserSettings,
  WorkflowDefinition,
  WorkflowRunState
} from "../api/types";

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

type SettingsResponse = {
  settings: UserSettings;
};

type PlanItemDraft = {
  title: string;
  description: string;
  prompt: string;
  aiCommandSelection: string;
  aiCommandOverride: string;
};

const AI_COMMAND_OTHER = "__other__";
const DEFAULT_AI_COMMAND = "codex --yolo {prompt}";

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
  const [activePane, setActivePane] = useState<"ide" | "info">("ide");
  const [expandedPane, setExpandedPane] = useState<"ide" | null>(null);
  const [syncingMain, setSyncingMain] = useState(false);
  const [mergingTask, setMergingTask] = useState(false);
  const [markingReady, setMarkingReady] = useState(false);
  const [markingInProgress, setMarkingInProgress] = useState(false);
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
  const [planItemDrafts, setPlanItemDrafts] = useState<Record<string, PlanItemDraft>>({});
  const [taskAiCommandOptions, setTaskAiCommandOptions] = useState<string[]>([DEFAULT_AI_COMMAND]);
  const [nodeDetail, setNodeDetail] = useState<OrchestrationNodeDetail | null>(null);
  const [nodeDetailLoading, setNodeDetailLoading] = useState(false);
  const [nodeDetailError, setNodeDetailError] = useState<string | null>(null);
  const [workflowDefinitions, setWorkflowDefinitions] = useState<WorkflowDefinition[]>([]);
  const [workflowState, setWorkflowState] = useState<WorkflowRunState | null>(null);
  const [workflowLoading, setWorkflowLoading] = useState(false);
  const [workflowActionLoading, setWorkflowActionLoading] = useState({
    assignment: false,
    continue: false,
    retry: false,
    cancel: false
  });
  const [nodeActionLoading, setNodeActionLoading] = useState<NodeActionLoadingState>({
    start: false,
    autoMode: false,
    autoMerge: false,
    autoMergeOnComplete: false,
    reReview: false,
    budgetOverride: false
  });

  const autoStartedForTaskRef = useRef<Set<string>>(new Set());
  const latestFailedTransition = transitions.find((item) => item.toStatus === "failed");
  const runtimeFailureReason = session?.failureReason || latestFailedTransition?.reason || null;

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

  async function loadAiCommandOptions() {
    const settingsRes = await api<SettingsResponse>("/api/users/me/settings");
    const commandOptions = settingsRes.settings.defaultAiCommands?.length
      ? settingsRes.settings.defaultAiCommands
      : [settingsRes.settings.defaultAiCommand || DEFAULT_AI_COMMAND];
    setTaskAiCommandOptions(commandOptions);
  }

  async function loadNodeDetails(currentNodeId: string, suppressError = false) {
    setNodeDetailLoading(true);
    try {
      const response = await getNode(currentNodeId);
      setNodeDetail(response);
      setNodeDetailError(null);
    } catch (error: any) {
      setNodeDetail(null);
      setNodeDetailError(error.message || "Failed to load node orchestration details.");
      if (!suppressError) {
        toast({ status: "warning", title: "Node orchestration unavailable", description: error.message });
      }
    } finally {
      setNodeDetailLoading(false);
    }
  }

  async function loadWorkflowDefinitions(currentProjectId: string) {
    const response = await listWorkflowDefinitions(currentProjectId);
    setWorkflowDefinitions(response.definitions ?? []);
  }

  async function loadWorkflowStatus(currentNodeId: string, suppressError = false) {
    setWorkflowLoading(true);
    try {
      const response = await getNodeWorkflowStatus(currentNodeId);
      setWorkflowState(response.workflow ?? null);
    } catch (error: any) {
      setWorkflowState(null);
      if (!suppressError) {
        toast({ status: "warning", title: "Workflow status unavailable", description: error.message });
      }
    } finally {
      setWorkflowLoading(false);
    }
  }

  function updatePlanItemDraft(itemKey: string, updates: Partial<PlanItemDraft>, defaults: Pick<PlanItemDraft, "title" | "description">) {
    setPlanItemDrafts((current) => {
      const key = itemKey.toLowerCase();
      const existing = current[key];
      const fallbackCommand = taskAiCommandOptions[0] || DEFAULT_AI_COMMAND;
      return {
        ...current,
        [key]: {
          title: existing?.title ?? defaults.title,
          description: existing?.description ?? defaults.description,
          prompt: existing?.prompt ?? "",
          aiCommandSelection: existing?.aiCommandSelection ?? fallbackCommand,
          aiCommandOverride: existing?.aiCommandOverride ?? "",
          ...updates
        }
      };
    });
  }

  useEffect(() => {
    setIdeLaunchUrl(null);
    const tab = searchParams.get("tab");
    setActivePane(tab === "info" ? "info" : "ide");
    setExpandedPane(null);
    setIsTaskSidebarCollapsed(false);
    loadTask().catch((error: Error) => {
      toast({ status: "error", title: "Failed to load task", description: error.message });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, searchParams]);

  useEffect(() => {
    if (!entityId) {
      setNodeDetail(null);
      setNodeDetailError(null);
      return;
    }
    loadNodeDetails(entityId).catch(() => {
      // handled in helper
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId]);

  useEffect(() => {
    if (!entityId || !task?.projectId) return;
    loadWorkflowDefinitions(task.projectId).catch((error: Error) => {
      toast({ status: "error", title: "Failed to load workflow definitions", description: error.message });
    });
    loadWorkflowStatus(entityId).catch(() => {
      // handled in helper
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, task?.projectId]);

  useEffect(() => {
    if (!task?.projectId) return;
    loadProjectContext(task.projectId).catch((error: Error) => {
      toast({ status: "error", title: "Failed to load task list", description: error.message });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.projectId]);

  useEffect(() => {
    loadAiCommandOptions().catch((error: Error) => {
      toast({ status: "error", title: "Failed to load settings", description: error.message });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      Promise.all([
        loadTask(),
        entityId ? loadNodeDetails(entityId, true) : Promise.resolve(),
        entityId ? loadWorkflowStatus(entityId, true) : Promise.resolve()
      ]).catch((error: Error) => {
        console.error("Failed to poll task", error);
      });
    }, 3000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId]);

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
        const conflictTitle = task?.mode === "plan"
          ? "Pulled from base with conflicts"
          : isPlanOwnedExecutionTask
            ? "Pulled from plan branch with conflicts"
            : "Pulled from main with conflicts";
        toast({
          status: "warning",
          title: conflictTitle,
          description: count ? `${count} conflict file(s) detected.` : "Conflicts detected."
        });
      } else {
        const successTitle = task?.mode === "plan"
          ? "Pulled latest base into plan workspace"
          : isPlanOwnedExecutionTask
            ? "Pulled latest plan branch into task workspace"
            : "Pulled latest main into task workspace";
        toast({ status: "success", title: successTitle });
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

  async function markInProgress() {
    if (!entityId) return;
    setMarkingInProgress(true);
    try {
      await api<{ task: Task }>(`/api/tasks/${entityId}/in-progress`, { method: "POST" });
      await loadTask();
      if (task?.projectId) {
        await loadProjectContext(task.projectId);
      }
      toast({ status: "success", title: "Task moved to waiting_input" });
    } catch (error: any) {
      toast({ status: "error", title: "Move to waiting_input failed", description: error.message });
    } finally {
      setMarkingInProgress(false);
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
      "Re-run this task?\n\nThis will clear this task workspace and reset the task state to queued.\nAll unpushed task progress will be permanently lost."
    );
    if (!confirmed) return;

    setRerunningTask(true);
    try {
      await api<{ task: Task }>(`/api/tasks/${entityId}/rerun`, { method: "POST" });
      setIdeLaunchUrl(null);
      await loadTask();
      if (task?.projectId) {
        await loadProjectContext(task.projectId);
      }
      toast({ status: "success", title: "Task reset to queued" });
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
    const proposedItems = latestProposedRevision?.items ?? [];
    const taskEdits = proposedItems.map((item) => {
      const draft = planItemDrafts[item.itemKey.toLowerCase()] ?? {
        title: item.title,
        description: item.prompt,
        prompt: "",
        aiCommandSelection: taskAiCommandOptions[0] || DEFAULT_AI_COMMAND,
        aiCommandOverride: ""
      };
      const aiCommand = draft.aiCommandSelection === AI_COMMAND_OTHER ? draft.aiCommandOverride.trim() : draft.aiCommandSelection.trim();
      return {
        itemKey: item.itemKey,
        title: draft.title.trim(),
        description: draft.description.trim(),
        prompt: draft.prompt.trim(),
        aiCommand
      };
    });

    const invalidTitle = taskEdits.find((item) => item.title.length < 2);
    if (invalidTitle) {
      toast({
        status: "warning",
        title: "Title is too short",
        description: `Task ${invalidTitle.itemKey} needs a title with at least 2 characters.`
      });
      return;
    }

    const invalidDescription = taskEdits.find((item) => item.description.length < 1);
    if (invalidDescription) {
      toast({
        status: "warning",
        title: "Description is required",
        description: `Task ${invalidDescription.itemKey} needs a description before approval.`
      });
      return;
    }
    const invalidAiCommand = taskEdits.find((item) => item.aiCommand.length < 1);
    if (invalidAiCommand) {
      toast({
        status: "warning",
        title: "AI command is required",
        description: `Task ${invalidAiCommand.itemKey} needs an AI command before approval.`
      });
      return;
    }

    const confirmed = window.confirm(
      `Approve all tasks from the latest proposed plan revision?\n\nAuto-merge enabled for ${autoMergeItemKeys.length} task(s).`
    );
    if (!confirmed) return;
    setApprovingPlan(true);
    try {
      await api<{ approvedTasks: Task[] }>(`/api/plans/${entityId}/approve`, {
        method: "POST",
        body: JSON.stringify({ autoMergeItemKeys, taskEdits })
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

  async function runNodeAction(action: keyof NodeActionLoadingState, actionFn: () => Promise<void>, successTitle: string) {
    setNodeActionLoading((current) => ({ ...current, [action]: true }));
    try {
      await actionFn();
      if (entityId) {
        await Promise.all([loadTask(), loadNodeDetails(entityId, true)]);
      }
      toast({ status: "success", title: successTitle });
    } catch (error: any) {
      toast({ status: "error", title: "Node action failed", description: error.message });
    } finally {
      setNodeActionLoading((current) => ({ ...current, [action]: false }));
    }
  }

  function handleStartNode(autoMode: boolean) {
    if (!entityId) return;
    runNodeAction("start", async () => {
      await startNode(entityId, { autoMode });
    }, "Node start requested");
  }

  function handleSetNodeAutoMode(enabled: boolean) {
    if (!entityId) return;
    runNodeAction("autoMode", async () => {
      await setNodeAutoMode(entityId, { enabled });
    }, "Auto mode updated");
  }

  function handleSetNodeAutoMerge(enabled: boolean, onComplete?: boolean) {
    if (!entityId) return;
    const action: keyof NodeActionLoadingState = onComplete === false ? "autoMergeOnComplete" : "autoMerge";
    runNodeAction(action, async () => {
      await setNodeAutoMerge(entityId, { enabled, onComplete });
    }, "Auto-merge updated");
  }

  function handleForceNodeReReview(reason?: string) {
    if (!entityId) return;
    runNodeAction("reReview", async () => {
      await forceNodeReReview(entityId, reason?.trim() ? { reason: reason.trim() } : undefined);
    }, "Re-review queued");
  }

  function handleApproveNodeBudgetOverride(enabled: boolean, reason?: string) {
    if (!entityId) return;
    runNodeAction("budgetOverride", async () => {
      await approveNodeBudgetOverride(entityId, {
        enabled,
        ...(reason?.trim() ? { reason: reason.trim() } : {})
      });
    }, "Budget override updated");
  }

  async function runWorkflowAction(
    action: keyof typeof workflowActionLoading,
    actionFn: () => Promise<void>,
    successTitle: string
  ) {
    setWorkflowActionLoading((current) => ({ ...current, [action]: true }));
    try {
      await actionFn();
      if (entityId) {
        await Promise.all([loadTask(), loadNodeDetails(entityId, true), loadWorkflowStatus(entityId, true)]);
      }
      toast({ status: "success", title: successTitle });
    } catch (error: any) {
      toast({ status: "error", title: "Workflow action failed", description: error.message });
    } finally {
      setWorkflowActionLoading((current) => ({ ...current, [action]: false }));
    }
  }

  function handleSaveWorkflowAssignment(mode: "builtin" | "custom", workflowDefinitionId: string | null) {
    if (!entityId) return;
    runWorkflowAction("assignment", async () => {
      await setNodeWorkflowAssignment(entityId, { mode, workflowDefinitionId });
    }, "Workflow assignment saved");
  }

  function handleContinueWorkflow() {
    if (!task?.projectId || !workflowState) return;
    runWorkflowAction("continue", async () => {
      await tickWorkflowRun(task.projectId, workflowState.run.id);
    }, "Workflow tick requested");
  }

  function handleRetryWorkflow() {
    if (!task?.projectId || !entityId || !workflowState?.definition?.id) return;
    runWorkflowAction("retry", async () => {
      await startWorkflowRun(task.projectId, {
        workflowDefinitionId: workflowState.definition.id,
        taskId: entityId
      });
    }, "Workflow run restarted");
  }

  function handleCancelWorkflow() {
    if (!task?.projectId || !workflowState) return;
    const reason = window.prompt("Cancel workflow reason (optional):");
    runWorkflowAction("cancel", async () => {
      await cancelWorkflowRun(task.projectId, workflowState.run.id, reason?.trim() ? { reason: reason.trim() } : {});
    }, "Workflow run cancelled");
  }

  const latestProposedRevision = planRevisions.find((revision) => revision.status === "proposed");
  const latestProposedItemKeys = (latestProposedRevision?.items ?? []).map((item) => item.itemKey);
  const allAutoMergeSelected = latestProposedItemKeys.length > 0 && latestProposedItemKeys.every((itemKey) => autoMergeItemKeys.includes(itemKey));
  const someAutoMergeSelected = autoMergeItemKeys.length > 0 && !allAutoMergeSelected;
  const getPlanItemDraft = (itemKey: string): PlanItemDraft | undefined => planItemDrafts[itemKey.toLowerCase()];

  useEffect(() => {
    const items = latestProposedRevision?.items ?? [];
    if (!items.length) {
      setPlanItemDrafts({});
      return;
    }
    const next: Record<string, PlanItemDraft> = {};
    const defaultCommand = taskAiCommandOptions[0] || DEFAULT_AI_COMMAND;
    for (const item of items) {
      next[item.itemKey.toLowerCase()] = {
        title: item.title,
        description: item.prompt,
        prompt: "",
        aiCommandSelection: defaultCommand,
        aiCommandOverride: ""
      };
    }
    setPlanItemDrafts(next);
  }, [latestProposedRevision?.id, taskAiCommandOptions]);

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
  const completionSummary = task.completion?.summary?.trim() || task.result.trim();
  const synthesisArtifact = task.completion?.synthesisArtifact;
  const verificationArtifact = task.completion?.verificationArtifact;
  const deltaLoopHistory = task.completion?.deltaLoopHistory ?? [];

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
          <Flex mt={2} align={{ base: "flex-start", md: "center" }} justify="space-between" gap={3} flexWrap="wrap">
            <Stack direction="row" align="center" flexWrap="wrap">
              <Badge colorScheme={task.mode === "plan" ? "purple" : "cyan"}>{task.mode}</Badge>
              <Badge colorScheme={task.isBlocked ? "orange" : statusColor(task.status)}>{taskStatusLabel(task)}</Badge>
              <Badge colorScheme={task.autoMerge ? "green" : "gray"}>auto-merge: {task.autoMerge ? "on" : "off"}</Badge>
              {task.mode === "plan" ? (
                <Badge colorScheme={task.autoMergeOnComplete ? "green" : "gray"}>
                  auto-merge on complete: {task.autoMergeOnComplete ? "on" : "off"}
                </Badge>
              ) : null}
              <Badge colorScheme={ide?.status === "running" ? "green" : ide?.status === "starting" ? "blue" : "gray"}>
                ide: {ide?.status ?? "stopped"}
              </Badge>
            </Stack>
            <Button colorScheme="blue" variant="outline" size="sm" onClick={markInProgress} isLoading={markingInProgress}>
              In Progress
            </Button>
          </Flex>
        </Box>

        <Tabs index={activePane === "ide" ? 0 : 1} onChange={(next) => setActivePane(next === 0 ? "ide" : "info")} colorScheme="teal">
          <TabList>
            <Tab>IDE</Tab>
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
              <Stack spacing={5}>
                <Flex justify="flex-end">
                  {task.mode === "plan" ? (
                    <Stack direction={{ base: "column", md: "row" }} spacing={2}>
                      <Button colorScheme="teal" variant="outline" size="sm" onClick={pullFromMain} isLoading={syncingMain} isDisabled={task.isBlocked}>
                        Pull From Base Repo
                      </Button>
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
                        onClick={markInProgress}
                        isLoading={markingInProgress}
                      >
                        In Progress
                      </Button>
                      <Button
                        colorScheme="blue"
                        variant="outline"
                        size="sm"
                        onClick={markMergeReady}
                        isLoading={markingReady}
                      >
                        Mark Merge Ready
                      </Button>
                      <Button colorScheme="green" size="sm" onClick={mergeTask} isLoading={mergingTask}>
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
                        onClick={markInProgress}
                        isLoading={markingInProgress}
                      >
                        In Progress
                      </Button>
                      <Button
                        colorScheme="blue"
                        variant="outline"
                        size="sm"
                        onClick={markMergeReady}
                        isLoading={markingReady}
                      >
                        Mark Merge Ready
                      </Button>
                      <Button colorScheme="green" size="sm" onClick={mergeTask} isLoading={mergingTask}>
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

                {!!runtimeFailureReason && (
                  <Box border="1px solid" borderColor="red.300" bg="red.50" borderRadius="md" p={4}>
                    <Heading size="sm" mb={2} color="red.700">
                      Runtime Failure
                    </Heading>
                    {!!session && (
                      <Text fontSize="sm" color="red.800" mb={2}>
                        Session status: {session.status}
                      </Text>
                    )}
                    <Code display="block" whiteSpace="pre-wrap" width="full" p={3} borderRadius="md">
                      {runtimeFailureReason}
                    </Code>
                    {!session?.failureReason && !!latestFailedTransition && (
                      <Text fontSize="xs" color="red.800" mt={2}>
                        Derived from last task transition at {new Date(latestFailedTransition.createdAt).toLocaleString()}.
                      </Text>
                    )}
                  </Box>
                )}

                {!!completionSummary && (
                  <Box>
                    <Heading size="sm" mb={2}>
                      Completion Summary
                    </Heading>
                    <Code display="block" whiteSpace="pre-wrap" width="full" p={4} borderRadius="md">
                      {completionSummary}
                    </Code>
                  </Box>
                )}

                {!!synthesisArtifact && (
                  <Box>
                    <Heading size="sm" mb={2}>
                      Completion Evidence
                    </Heading>
                    <Stack spacing={3}>
                      <Text fontSize="sm" color="gray.700">
                        Generated: {new Date(synthesisArtifact.generated_at).toLocaleString()}
                      </Text>
                      <Stack spacing={2}>
                        {synthesisArtifact.coverage_matrix.map((row) => (
                          <Box key={row.requirement_id} border="1px solid" borderColor="blackAlpha.200" borderRadius="md" p={3}>
                            <Stack direction={{ base: "column", md: "row" }} justify="space-between" align={{ base: "start", md: "center" }} mb={2}>
                              <Text fontWeight="600">{row.requirement_text}</Text>
                              <Badge colorScheme={row.coverage_status === "covered" ? "green" : row.coverage_status === "partial" ? "yellow" : "red"}>
                                {row.coverage_status}
                              </Badge>
                            </Stack>
                            <Stack spacing={2}>
                              {row.evidence.map((evidence, idx) => (
                                <Box key={`${row.requirement_id}-${evidence.child_task_id}-${idx}`} bg="gray.50" borderRadius="md" p={2}>
                                  <Text fontSize="sm" color="gray.800">{evidence.snippet}</Text>
                                  <Text fontSize="xs" color="gray.700">source: {evidence.artifact_ref}</Text>
                                  {!!evidence.repo_path && <Text fontSize="xs" color="gray.700">repo path: {evidence.repo_path}</Text>}
                                  {!!evidence.module_ref && <Text fontSize="xs" color="gray.700">module: {evidence.module_ref}</Text>}
                                  {!!evidence.test_ref && <Text fontSize="xs" color="gray.700">test: {evidence.test_ref}</Text>}
                                </Box>
                              ))}
                              {!row.evidence.length && (
                                <Text fontSize="sm" color="orange.700">
                                  Unresolved gap: {row.gap_reason || "missing evidence"}
                                </Text>
                              )}
                            </Stack>
                          </Box>
                        ))}
                      </Stack>
                    </Stack>
                  </Box>
                )}

                {!!verificationArtifact && (
                  <Box>
                    <Heading size="sm" mb={2}>
                      Verification Outcome
                    </Heading>
                    <Stack spacing={2}>
                      <Badge alignSelf="start" colorScheme={verificationArtifact.verdict === "pass" ? "green" : "red"}>
                        {verificationArtifact.verdict}
                      </Badge>
                      <Text fontSize="sm" color="gray.700">
                        Generated: {new Date(verificationArtifact.generated_at).toLocaleString()}
                      </Text>
                      {!!verificationArtifact.reasons.length && (
                        <Text fontSize="sm" color={verificationArtifact.verdict === "pass" ? "gray.700" : "red.700"}>
                          Reasons: {verificationArtifact.reasons.join(", ")}
                        </Text>
                      )}
                      {!!verificationArtifact.failing_requirements.length && (
                        <Text fontSize="sm" color="orange.700">
                          Unresolved requirements: {verificationArtifact.failing_requirements.join(", ")}
                        </Text>
                      )}
                    </Stack>
                  </Box>
                )}

                {!!deltaLoopHistory.length && (
                  <Box>
                    <Heading size="sm" mb={2}>
                      Gap Closure History
                    </Heading>
                    <Stack spacing={2}>
                      {deltaLoopHistory.map((entry, idx) => (
                        <Box key={`${entry.verification_artifact_event_id}-${idx}`} border="1px solid" borderColor="blackAlpha.200" borderRadius="md" p={3}>
                          <Stack direction={{ base: "column", md: "row" }} justify="space-between" align={{ base: "start", md: "center" }}>
                            <Badge colorScheme={entry.verdict === "pass" ? "green" : "red"}>{entry.verdict}</Badge>
                            <Text fontSize="xs" color="gray.600">{new Date(entry.generated_at).toLocaleString()}</Text>
                          </Stack>
                          {!!entry.reasons.length && <Text fontSize="sm" mt={1}>reasons: {entry.reasons.join(", ")}</Text>}
                          {!!entry.failing_requirements.length && (
                            <Text fontSize="sm" color="orange.700">
                              gaps: {entry.failing_requirements.join(", ")}
                            </Text>
                          )}
                          <Text fontSize="xs" color="gray.600">
                            delta planned: {entry.delta_plan_enqueued ? "yes" : "no"} | budget exhausted: {entry.budget_exhausted ? "yes" : "no"}
                          </Text>
                        </Box>
                      ))}
                    </Stack>
                  </Box>
                )}

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
                            <Accordion key={item.id} allowToggle>
                              <AccordionItem border="1px solid" borderColor="blackAlpha.200" borderRadius="md" overflow="hidden">
                                <AccordionButton px={4} py={3} _hover={{ bg: "gray.50" }}>
                                  <Flex direction="column" align="start" flex="1" gap={1}>
                                    <Text fontWeight="700">
                                      {item.ordinal}. {getPlanItemDraft(item.itemKey)?.title || item.title}
                                    </Text>
                                    <Text fontSize="sm" color="gray.600">
                                      id: {item.itemKey}
                                    </Text>
                                    <Text fontSize="sm" color="gray.600">
                                      depends on: {item.dependsOnItemKeys.length ? item.dependsOnItemKeys.join(", ") : "none"}
                                    </Text>
                                  </Flex>
                                  <AccordionIcon />
                                </AccordionButton>
                                <AccordionPanel pt={0} pb={4}>
                                  <Stack spacing={3}>
                                    <Checkbox
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
                                    <Box>
                                      <Text fontSize="sm" color="gray.700" mb={1}>
                                        Title
                                      </Text>
                                      <Input
                                        value={getPlanItemDraft(item.itemKey)?.title ?? item.title}
                                        onChange={(e) => {
                                          updatePlanItemDraft(
                                            item.itemKey,
                                            { title: e.target.value },
                                            { title: item.title, description: item.prompt }
                                          );
                                        }}
                                        placeholder="Task title"
                                      />
                                    </Box>
                                    <Box>
                                      <Text fontSize="sm" color="gray.700" mb={1}>
                                        Description
                                      </Text>
                                      <Textarea
                                        rows={4}
                                        value={getPlanItemDraft(item.itemKey)?.description ?? item.prompt}
                                        onChange={(e) => {
                                          updatePlanItemDraft(
                                            item.itemKey,
                                            { description: e.target.value },
                                            { title: item.title, description: item.prompt }
                                          );
                                        }}
                                        placeholder="Task description"
                                      />
                                    </Box>
                                    <Box>
                                      <Text fontSize="sm" color="gray.700" mb={1}>
                                        AI Command
                                      </Text>
                                      <Stack spacing={2}>
                                        <Select
                                          value={getPlanItemDraft(item.itemKey)?.aiCommandSelection ?? (taskAiCommandOptions[0] || DEFAULT_AI_COMMAND)}
                                          onChange={(e) => {
                                            const selected = e.target.value;
                                            updatePlanItemDraft(
                                              item.itemKey,
                                              {
                                                aiCommandSelection: selected,
                                                aiCommandOverride:
                                                  selected === AI_COMMAND_OTHER
                                                    ? getPlanItemDraft(item.itemKey)?.aiCommandOverride ?? ""
                                                    : ""
                                              },
                                              { title: item.title, description: item.prompt }
                                            );
                                          }}
                                        >
                                          {taskAiCommandOptions.map((option) => (
                                            <option key={option} value={option}>
                                              {option}
                                            </option>
                                          ))}
                                          <option value={AI_COMMAND_OTHER}>Other</option>
                                        </Select>
                                        {(getPlanItemDraft(item.itemKey)?.aiCommandSelection ?? "") === AI_COMMAND_OTHER && (
                                          <Input
                                            placeholder="Enter custom AI command"
                                            value={getPlanItemDraft(item.itemKey)?.aiCommandOverride ?? ""}
                                            onChange={(e) => {
                                              updatePlanItemDraft(
                                                item.itemKey,
                                                { aiCommandOverride: e.target.value },
                                                { title: item.title, description: item.prompt }
                                              );
                                            }}
                                          />
                                        )}
                                      </Stack>
                                    </Box>
                                    <Accordion allowToggle>
                                      <AccordionItem border="1px solid" borderColor="blackAlpha.100" borderRadius="md">
                                        <AccordionButton _hover={{ bg: "gray.50" }}>
                                          <Box flex="1" textAlign="left" fontSize="sm" fontWeight="600">
                                            Prompt
                                          </Box>
                                          <AccordionIcon />
                                        </AccordionButton>
                                        <AccordionPanel pt={0}>
                                          <Textarea
                                            rows={5}
                                            value={getPlanItemDraft(item.itemKey)?.prompt ?? ""}
                                            onChange={(e) => {
                                              updatePlanItemDraft(
                                                item.itemKey,
                                                { prompt: e.target.value },
                                                { title: item.title, description: item.prompt }
                                              );
                                            }}
                                            placeholder="Optional extra implementation prompt"
                                          />
                                        </AccordionPanel>
                                      </AccordionItem>
                                    </Accordion>
                                  </Stack>
                                </AccordionPanel>
                              </AccordionItem>
                            </Accordion>
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
                  <NodeActionsPanel
                    nodeDetail={nodeDetail}
                    isLoading={nodeDetailLoading}
                    loadError={nodeDetailError}
                    actionLoading={nodeActionLoading}
                    onStartNode={handleStartNode}
                    onSetAutoMode={handleSetNodeAutoMode}
                    onSetAutoMerge={handleSetNodeAutoMerge}
                    onForceReReview={handleForceNodeReReview}
                    onApproveBudgetOverride={handleApproveNodeBudgetOverride}
                  />
                </Box>

                <Box>
                  <WorkflowPanel
                    task={task}
                    workflow={workflowState}
                    definitions={workflowDefinitions}
                    isLoading={workflowLoading}
                    actionLoading={workflowActionLoading}
                    onSaveAssignment={handleSaveWorkflowAssignment}
                    onContinue={handleContinueWorkflow}
                    onRetry={handleRetryWorkflow}
                    onCancel={handleCancelWorkflow}
                  />
                </Box>

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
