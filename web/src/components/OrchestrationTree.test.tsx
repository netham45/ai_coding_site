import { ChakraProvider } from "@chakra-ui/react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";
import { OrchestrationTree } from "./OrchestrationTree";
import type { HierarchyNode } from "../api/types";

function makeNode(overrides: Partial<HierarchyNode> & { id: string; title: string }): HierarchyNode {
  const { task: taskOverrides, ...nodeOverrides } = overrides;
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
      ...(taskOverrides ?? {})
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
    ...nodeOverrides
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
    expect(screen.queryByRole("link", { name: "Execution Task" })).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("Expand Plan Root"));
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

    expect(screen.queryByRole("link", { name: "Child Node" })).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("link", { name: "Collapsible Plan" }), { key: "ArrowRight" });
    expect(screen.getByRole("link", { name: "Child Node" })).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Collapse Collapsible Plan"));
    expect(screen.queryByRole("link", { name: "Child Node" })).not.toBeInTheDocument();
  });

  test("keeps manually-collapsed roots collapsed after refresh rerender", () => {
    const taskChild = makeNode({
      id: "task-refresh-child",
      title: "Refresh Child",
      tier: "task",
      task: { mode: "execution", parentPlanTaskId: "plan-refresh" }
    });
    const root = makeNode({ id: "plan-refresh", title: "Refresh Root", children: [taskChild] });

    const view = render(
      <ChakraProvider>
        <MemoryRouter>
          <OrchestrationTree roots={[root]} />
        </MemoryRouter>
      </ChakraProvider>
    );

    fireEvent.click(screen.getByLabelText("Expand Refresh Root"));
    expect(screen.getByRole("link", { name: "Refresh Child" })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Collapse Refresh Root"));
    expect(screen.queryByRole("link", { name: "Refresh Child" })).not.toBeInTheDocument();

    const refreshedRoot = makeNode({ id: "plan-refresh", title: "Refresh Root", children: [taskChild] });
    view.rerender(
      <ChakraProvider>
        <MemoryRouter>
          <OrchestrationTree roots={[refreshedRoot]} />
        </MemoryRouter>
      </ChakraProvider>
    );

    expect(screen.queryByRole("link", { name: "Refresh Child" })).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByLabelText("Expand Fallback Plan"));
    expect(screen.getByRole("link", { name: "Fallback Task" })).toBeInTheDocument();
    expect(screen.getByText("plan")).toBeInTheDocument();
    expect(screen.getByText("task")).toBeInTheDocument();
  });

  test("preserves root and child input order without chronology re-sort", () => {
    const firstChild = makeNode({
      id: "task-first",
      title: "Task First",
      tier: "task",
      task: {
        mode: "execution",
        parentPlanTaskId: "plan-root",
        createdAt: "2026-02-03T00:00:00.000Z",
        updatedAt: "2026-02-03T00:00:00.000Z"
      }
    });
    const secondChild = makeNode({
      id: "task-second",
      title: "Task Second",
      tier: "task",
      task: {
        mode: "execution",
        parentPlanTaskId: "plan-root",
        createdAt: "2026-02-02T00:00:00.000Z",
        updatedAt: "2026-02-02T00:00:00.000Z"
      }
    });
    const secondRoot = makeNode({
      id: "plan-second",
      title: "Plan Second",
      tier: "plan",
      task: { createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" }
    });
    const firstRoot = makeNode({
      id: "plan-root",
      title: "Plan Root",
      tier: "plan",
      task: { createdAt: "2026-02-05T00:00:00.000Z", updatedAt: "2026-02-05T00:00:00.000Z" },
      children: [firstChild, secondChild]
    });

    render(
      <ChakraProvider>
        <MemoryRouter>
          <OrchestrationTree roots={[firstRoot, secondRoot]} />
        </MemoryRouter>
      </ChakraProvider>
    );

    fireEvent.click(screen.getByLabelText("Expand Plan Root"));
    const links = screen.getAllByRole("link").map((link) => link.textContent);
    expect(links.indexOf("Plan Root")).toBeLessThan(links.indexOf("Plan Second"));
    expect(links.indexOf("Task First")).toBeLessThan(links.indexOf("Task Second"));
  });

  test("preserves fallback row order for tied timestamps", () => {
    const fallbackPlan = makeNode({
      id: "plan-fallback-order",
      title: "Plan Fallback Order"
    });
    const fallbackSecond = makeNode({
      id: "task-fallback-second",
      title: "Fallback Second",
      tier: "task",
      task: {
        mode: "execution",
        parentPlanTaskId: "plan-fallback-order",
        createdAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-02-01T00:00:00.000Z"
      }
    });
    const fallbackFirst = makeNode({
      id: "task-fallback-first",
      title: "Fallback First",
      tier: "task",
      task: {
        mode: "execution",
        parentPlanTaskId: "plan-fallback-order",
        createdAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-02-01T00:00:00.000Z"
      }
    });

    render(
      <ChakraProvider>
        <MemoryRouter>
          <OrchestrationTree roots={[]} fallbackRows={[fallbackPlan, fallbackSecond, fallbackFirst]} />
        </MemoryRouter>
      </ChakraProvider>
    );

    fireEvent.click(screen.getByLabelText("Expand Plan Fallback Order"));
    const links = screen.getAllByRole("link").map((link) => link.textContent);
    expect(links.indexOf("Fallback Second")).toBeLessThan(links.indexOf("Fallback First"));
  });

  test("shows child status summary and hides auto-merge badges", () => {
    const blockedChild = makeNode({
      id: "child-blocked",
      title: "Blocked Child",
      tier: "task",
      task: { mode: "execution", parentPlanTaskId: "summary-root", status: "queued", isBlocked: true }
    });
    const inProgressChild = makeNode({
      id: "child-progress",
      title: "In Progress Child",
      tier: "task",
      task: { mode: "execution", parentPlanTaskId: "summary-root", status: "in_progress" }
    });
    const mergedChild = makeNode({
      id: "child-merged",
      title: "Merged Child",
      tier: "task",
      task: { mode: "execution", parentPlanTaskId: "summary-root", status: "merged" }
    });
    const root = makeNode({
      id: "summary-root",
      title: "Summary Root",
      tier: "plan",
      children: [blockedChild, inProgressChild, mergedChild]
    });

    render(
      <ChakraProvider>
        <MemoryRouter>
          <OrchestrationTree roots={[root]} />
        </MemoryRouter>
      </ChakraProvider>
    );

    expect(screen.getByText("children: 1 blocked 1 in progress 1 merged")).toBeInTheDocument();
    expect(screen.queryByText("auto-merge: on")).not.toBeInTheDocument();
    expect(screen.queryByText("auto-merge on complete: on")).not.toBeInTheDocument();
  });
});
