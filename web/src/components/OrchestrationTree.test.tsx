import { ChakraProvider } from "@chakra-ui/react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";
import { OrchestrationTree } from "./OrchestrationTree";
import type { HierarchyNode } from "../api/types";

function makeNode(overrides: Partial<HierarchyNode> & { id: string; title: string }): HierarchyNode {
  return {
    task: {
      id: overrides.id,
      projectId: "project-1",
      title: overrides.title,
      taskPrompt: "prompt",
      result: "",
      effectivePrompt: "prompt",
      aiCommand: "codex --yolo {prompt}",
      autoMerge: true,
      autoStart: false,
      autoMergeOnComplete: true,
      mode: "plan",
      parentPlanTaskId: null,
      sourcePlanRevisionId: null,
      sourcePlanItemKey: null,
      status: "queued",
      workspacePath: "/tmp/task",
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
      ...(overrides.task ?? {})
    },
    tier: "plan",
    waiting: {
      waiting: false,
      reasonCode: "",
      reason: "",
      dependencyBlockerTaskId: null,
      unresolvedDependencyIds: [],
      unresolvedDependencyDetails: []
    },
    children: [],
    ...overrides
  };
}

describe("OrchestrationTree", () => {
  test("renders hierarchy and routes on node click", async () => {
    const user = userEvent.setup();
    const taskChild = makeNode({
      id: "task-1",
      title: "Execution Task",
      tier: "task",
      task: { mode: "execution", parentPlanTaskId: "plan-1" }
    });
    const planRoot = makeNode({ id: "plan-1", title: "Plan Root", tier: "plan", children: [taskChild] });

    render(
      <ChakraProvider>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route path="/" element={<OrchestrationTree roots={[planRoot]} selectedNodeId="task-1" />} />
            <Route path="/tasks/:taskId" element={<div>task route</div>} />
            <Route path="/plans/:planId" element={<div>plan route</div>} />
          </Routes>
        </MemoryRouter>
      </ChakraProvider>
    );

    expect(screen.getByText("Orchestration Tree")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Plan Root" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Execution Task" })).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Execution Task" }));
    expect(screen.getByText("task route")).toBeInTheDocument();
  });

  test("supports collapse and keyboard expand on parent nodes", () => {
    const taskChild = makeNode({
      id: "task-2",
      title: "Child Node",
      tier: "task",
      task: { mode: "execution", parentPlanTaskId: "plan-2" }
    });
    const planRoot = makeNode({ id: "plan-2", title: "Collapsible Plan", tier: "plan", children: [taskChild] });

    render(
      <ChakraProvider>
        <MemoryRouter>
          <OrchestrationTree roots={[planRoot]} />
        </MemoryRouter>
      </ChakraProvider>
    );

    expect(screen.getByRole("link", { name: "Child Node" })).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Collapse Collapsible Plan"));
    expect(screen.queryByRole("link", { name: "Child Node" })).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("link", { name: "Collapsible Plan" }), { key: "ArrowRight" });
    expect(screen.getByRole("link", { name: "Child Node" })).toBeInTheDocument();
  });

  test("can render from fallback rows when hierarchy roots are missing", () => {
    const fallbackPlan = makeNode({ id: "plan-fallback", title: "Fallback Plan", tier: "plan" });
    const fallbackTask = makeNode({
      id: "task-fallback",
      title: "Fallback Task",
      tier: "task",
      task: { mode: "execution", parentPlanTaskId: "plan-fallback" }
    });

    render(
      <ChakraProvider>
        <MemoryRouter>
          <OrchestrationTree roots={[]} fallbackRows={[fallbackPlan, fallbackTask]} />
        </MemoryRouter>
      </ChakraProvider>
    );

    expect(screen.getByRole("link", { name: "Fallback Plan" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Fallback Task" })).toBeInTheDocument();
    expect(screen.getByText("plan")).toBeInTheDocument();
    expect(screen.getByText("task")).toBeInTheDocument();
  });
});
