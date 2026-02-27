import { ChakraProvider } from "@chakra-ui/react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ProjectDetailPage } from "./ProjectDetailPage";
import type { CreateNodeTier, Project, Task } from "../api/types";

const mockNavigate = vi.fn();
const apiMock = vi.fn();
const createNodeMock = vi.fn();
const getHierarchyMock = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate
  };
});

vi.mock("../api/client", () => ({
  api: (...args: unknown[]) => apiMock(...args),
  createNode: (...args: unknown[]) => createNodeMock(...args),
  getHierarchy: (...args: unknown[]) => getHierarchyMock(...args)
}));

vi.mock("../components/NodeCreateForm", () => ({
  NodeCreateForm: ({ onCreate }: { onCreate: (payload: { title: string; taskPrompt: string; nodeTier: CreateNodeTier }) => Promise<void> }) => {
    return (
      <form
        data-testid="node-create-form"
        onSubmit={(event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          onCreate({
            title: String(formData.get("title") || ""),
            taskPrompt: String(formData.get("taskPrompt") || ""),
            nodeTier: String(formData.get("nodeTier") || "task") as CreateNodeTier
          });
        }}
      >
        <label>
          Title
          <input name="title" aria-label="Title" />
        </label>
        <label>
          Node Tier
          <select name="nodeTier" aria-label="Node Tier" defaultValue="task">
            <option value="epoch">epoch</option>
            <option value="phase">phase</option>
            <option value="plan">plan</option>
            <option value="task">task</option>
          </select>
        </label>
        <label>
          Prompt
          <textarea name="taskPrompt" aria-label="Prompt" />
        </label>
        <button type="submit">Create Node</button>
      </form>
    );
  }
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
    autoStart: false,
    autoMergeOnComplete: true,
    mode: "execution",
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
    ...overrides
  };
}

function renderPage() {
  return render(
    <ChakraProvider>
      <MemoryRouter initialEntries={["/projects/project-1"]}>
        <Routes>
          <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
        </Routes>
      </MemoryRouter>
    </ChakraProvider>
  );
}

describe("ProjectDetailPage unified node creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const project: Project = {
      id: "project-1",
      name: "Test Project",
      slug: "test-project",
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

    const projectTasks = [
      makeTask({ id: "epoch-existing", title: "Existing Epoch", mode: "plan" }),
      makeTask({ id: "plan-existing", title: "Existing Plan", mode: "plan", parentPlanTaskId: "epoch-existing" }),
      makeTask({ id: "task-existing", title: "Existing Task", mode: "execution", parentPlanTaskId: "plan-existing" })
    ];

    apiMock.mockImplementation(async (path: string) => {
      if (path === "/api/projects/project-1") return { project };
      if (path === "/api/projects/project-1/tasks") return { tasks: projectTasks };
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

    getHierarchyMock.mockResolvedValue({
      hierarchy: {
        projectId: "project-1",
        roots: [],
        nodes: [
          {
            task: projectTasks[0],
            tier: "epoch",
            waiting: {
              waiting: false,
              reasonCode: "",
              reason: "",
              dependencyBlockerTaskId: null,
              unresolvedDependencyIds: [],
              unresolvedDependencyDetails: []
            }
          },
          {
            task: projectTasks[1],
            tier: "plan",
            waiting: {
              waiting: false,
              reasonCode: "",
              reason: "",
              dependencyBlockerTaskId: null,
              unresolvedDependencyIds: [],
              unresolvedDependencyDetails: []
            }
          },
          {
            task: projectTasks[2],
            tier: "task",
            waiting: {
              waiting: false,
              reasonCode: "",
              reason: "",
              dependencyBlockerTaskId: null,
              unresolvedDependencyIds: [],
              unresolvedDependencyDetails: []
            }
          }
        ]
      }
    });

    createNodeMock.mockImplementation(async (_projectId: string, payload: { nodeTier: CreateNodeTier }) => ({
      node: makeTask({
        id: `${payload.nodeTier}-created`,
        title: `${payload.nodeTier} created`,
        mode: payload.nodeTier === "task" ? "execution" : "plan"
      })
    }));
  });

  test("supports creating epoch, phase, plan, and task tiers from one form", async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText("Test Project");
    const form = screen.getAllByTestId("node-create-form")[0];

    const tierSelect = within(form).getByLabelText("Node Tier");
    const options = within(form).getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual(expect.arrayContaining(["epoch", "phase", "plan", "task"]));

    const createForTier = async (tier: CreateNodeTier) => {
      fireEvent.change(within(form).getByLabelText("Title"), { target: { value: `${tier} node` } });
      fireEvent.change(within(form).getByLabelText("Prompt"), { target: { value: `${tier} prompt` } });
      await user.selectOptions(tierSelect, tier);
      await user.click(within(form).getByRole("button", { name: "Create Node" }));

      await waitFor(() => {
        expect(createNodeMock).toHaveBeenCalledWith(
          "project-1",
          expect.objectContaining({
            nodeTier: tier,
            title: `${tier} node`,
            taskPrompt: `${tier} prompt`
          })
        );
      });
    };

    await createForTier("epoch");
    await createForTier("phase");
    await createForTier("plan");
    await createForTier("task");

    const submittedTiers = createNodeMock.mock.calls.map((call) => call[1].nodeTier);
    expect(submittedTiers).toEqual(expect.arrayContaining(["epoch", "phase", "plan", "task"]));
  });
});
