import { ChakraProvider } from "@chakra-ui/react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { TaskDetailPage } from "./TaskDetailPage";
import type { OrchestrationNodeDetail, Project, Task } from "../api/types";

const apiMock = vi.fn();
const getNodeMock = vi.fn();
const startNodeMock = vi.fn();
const setNodeAutoModeMock = vi.fn();
const setNodeAutoMergeMock = vi.fn();
const forceNodeReReviewMock = vi.fn();
const approveNodeBudgetOverrideMock = vi.fn();

vi.mock("../api/client", () => ({
  api: (...args: unknown[]) => apiMock(...args),
  getNode: (...args: unknown[]) => getNodeMock(...args),
  startNode: (...args: unknown[]) => startNodeMock(...args),
  setNodeAutoMode: (...args: unknown[]) => setNodeAutoModeMock(...args),
  setNodeAutoMerge: (...args: unknown[]) => setNodeAutoMergeMock(...args),
  forceNodeReReview: (...args: unknown[]) => forceNodeReReviewMock(...args),
  approveNodeBudgetOverride: (...args: unknown[]) => approveNodeBudgetOverrideMock(...args)
}));

vi.mock("../components/NodeActionsPanel", () => ({
  NodeActionsPanel: ({
    onStartNode,
    onSetAutoMode,
    onSetAutoMerge
  }: {
    onStartNode: (autoMode: boolean) => void;
    onSetAutoMode: (enabled: boolean) => void;
    onSetAutoMerge: (enabled: boolean) => void;
  }) => (
    <div>
      <h2>Node Orchestration</h2>
      <button onClick={() => onStartNode(true)}>Start Node</button>
      <button onClick={() => onSetAutoMode(false)}>Disable Auto Mode</button>
      <button onClick={() => onSetAutoMerge(false)}>Disable Auto-Merge</button>
    </div>
  )
}));

function makeTask(overrides: Partial<Task> & { id: string; title: string }): Task {
  return {
    id: overrides.id,
    projectId: "project-1",
    title: overrides.title,
    taskPrompt: "prompt",
    result: "",
    effectivePrompt: "prompt",
    aiCommand: "codex --yolo {prompt}",
    autoMerge: true,
    autoStart: true,
    autoMergeOnComplete: false,
    mode: "execution",
    parentPlanTaskId: null,
    sourcePlanRevisionId: null,
    sourcePlanItemKey: null,
    status: "merged",
    workspacePath: "/tmp/task-1",
    baseCommitShaAtCreate: "abc123",
    headCommitSha: null,
    cancelReason: null,
    mergedAt: null,
    mergedByUserId: null,
    dependencyTaskIds: [],
    blockedByTaskIds: [],
    isBlocked: false,
    createdByUserId: "user-1",
    createdAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z",
    ...overrides
  };
}

function makeNodeDetail(node: Task): OrchestrationNodeDetail {
  return {
    node,
    transitions: [],
    dependencyDiagnostics: {
      node: { id: node.id, tier: "task" },
      unresolved: []
    },
    waiting: {
      waiting: false,
      reasonCode: "none",
      reason: "ready",
      dependencyBlockerTaskId: null,
      unresolvedDependencyIds: [],
      unresolvedDependencyDetails: []
    },
    automation: {},
    orchestration: {},
    parent: null,
    children: []
  };
}

function renderPage() {
  return render(
    <ChakraProvider>
      <MemoryRouter initialEntries={["/tasks/task-1?tab=info"]}>
        <Routes>
          <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
          <Route path="/plans/:planId" element={<TaskDetailPage />} />
        </Routes>
      </MemoryRouter>
    </ChakraProvider>
  );
}

describe("TaskDetailPage node actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const task = makeTask({ id: "task-1", title: "Task One" });
    const project: Project = {
      id: "project-1",
      name: "Project One",
      slug: "project-one",
      repoUrl: "https://example.com/repo.git",
      defaultBranch: "main",
      basePath: "/tmp/repo",
      projectPrompt: "",
      projectRules: "",
      codingStandard: "",
      codingStandardOther: "",
      projectOther: "",
      cloneStatus: "ready",
      cloneError: null,
      createdByUserId: "user-1",
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z"
    };

    apiMock.mockImplementation(async (path: string) => {
      if (path === "/api/tasks/task-1") {
        return {
          task,
          transitions: [],
          session: null,
          ide: { id: "ide-1", taskId: "task-1", provider: "code_server", url: "http://ide", status: "stopped", startedAt: null, endedAt: null, lastHeartbeatAt: null },
          gitStatus: null,
          mergeRecords: []
        };
      }
      if (path === "/api/tasks/task-1/ide/start") {
        return {
          ide: { id: "ide-1", taskId: "task-1", provider: "code_server", url: "http://ide", status: "running", startedAt: null, endedAt: null, lastHeartbeatAt: null },
          launchUrl: "http://ide"
        };
      }
      if (path === "/api/projects/project-1/tasks") return { tasks: [task] };
      if (path === "/api/projects/project-1") return { project };
      if (path === "/api/users/me/settings") {
        return {
          settings: {
            defaultAiCommand: "codex --yolo {prompt}",
            defaultAiCommands: ["codex --yolo {prompt}"]
          }
        };
      }
      throw new Error(`Unhandled api() path in test: ${path}`);
    });

    getNodeMock.mockResolvedValue(makeNodeDetail(task));
    startNodeMock.mockResolvedValue({ node: task, started: true, tier: "task" });
    setNodeAutoModeMock.mockResolvedValue({ node: { ...task, autoStart: false } });
    setNodeAutoMergeMock.mockResolvedValue({ node: { ...task, autoMerge: false } });
    forceNodeReReviewMock.mockResolvedValue({ ok: true, pendingEventId: "evt-1" });
    approveNodeBudgetOverrideMock.mockResolvedValue({ node: task });
  });

  test("executes node actions and refreshes task + node detail", async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText("Node Orchestration");

    const taskCallsBeforeStart = apiMock.mock.calls.filter((call) => call[0] === "/api/tasks/task-1").length;
    const nodeCallsBeforeStart = getNodeMock.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Start Node" }));

    await waitFor(() => {
      expect(startNodeMock).toHaveBeenCalledWith("task-1", { autoMode: true });
    });
    await waitFor(() => {
      const taskCallsAfterStart = apiMock.mock.calls.filter((call) => call[0] === "/api/tasks/task-1").length;
      expect(taskCallsAfterStart).toBeGreaterThan(taskCallsBeforeStart);
      expect(getNodeMock.mock.calls.length).toBeGreaterThan(nodeCallsBeforeStart);
    });

    const taskCallsBeforeAutoMode = apiMock.mock.calls.filter((call) => call[0] === "/api/tasks/task-1").length;
    const nodeCallsBeforeAutoMode = getNodeMock.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Disable Auto Mode" }));

    await waitFor(() => {
      expect(setNodeAutoModeMock).toHaveBeenCalledWith("task-1", { enabled: false });
    });
    await waitFor(() => {
      const taskCallsAfterAutoMode = apiMock.mock.calls.filter((call) => call[0] === "/api/tasks/task-1").length;
      expect(taskCallsAfterAutoMode).toBeGreaterThan(taskCallsBeforeAutoMode);
      expect(getNodeMock.mock.calls.length).toBeGreaterThan(nodeCallsBeforeAutoMode);
    });

    await user.click(screen.getByRole("button", { name: "Disable Auto-Merge" }));
    await waitFor(() => {
      expect(setNodeAutoMergeMock).toHaveBeenCalledWith("task-1", expect.objectContaining({ enabled: false }));
    });
  });
});
