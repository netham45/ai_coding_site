import { afterEach, describe, expect, test, vi } from "vitest";
import {
  api,
  approveNodeBudgetOverride,
  createNode,
  forceNodeReReview,
  getDependencyGraph,
  getHierarchy,
  getNode,
  setNodeAutoMerge,
  setNodeAutoMode,
  startNode
} from "./client";

describe("api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("api sends JSON content type and returns parsed JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ ok: true })
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(api<{ ok: boolean }>("/api/test", { method: "POST", body: "{}" })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/test",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" })
      })
    );
  });

  test("api returns undefined on 204", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 204 }));
    await expect(api<void>("/api/empty")).resolves.toBeUndefined();
  });

  test("api surfaces error body message when available", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: vi.fn().mockResolvedValue({ error: "bad request" })
    }));
    await expect(api("/api/fail")).rejects.toThrow("bad request");
  });

  test("api falls back to status message when response body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: vi.fn().mockRejectedValue(new Error("not json"))
    }));
    await expect(api("/api/fail-json")).rejects.toThrow("Request failed: 503");
  });

  test("endpoint helpers hit expected paths with payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({})
    });
    vi.stubGlobal("fetch", fetchMock);

    await createNode("p1", { title: "x", taskPrompt: "y", nodeTier: "task", aiCommand: "cmd", autoMerge: true });
    await getHierarchy("p1");
    await getDependencyGraph("p1");
    await getNode("n1");
    await startNode("n1", { autoMode: true });
    await setNodeAutoMode("n1", { enabled: false, reason: "manual" });
    await setNodeAutoMerge("n1", { enabled: true, onComplete: true, reason: "manual" });
    await forceNodeReReview("n1", { reason: "stale" });
    await approveNodeBudgetOverride("n1", { enabled: true, reason: "needed" });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/projects/p1/nodes", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/projects/p1/hierarchy", expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/projects/p1/dependency-graph", expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/nodes/n1", expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(5, "/api/nodes/n1/start", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenNthCalledWith(6, "/api/nodes/n1/auto-mode", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenNthCalledWith(7, "/api/nodes/n1/auto-merge", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenNthCalledWith(8, "/api/nodes/n1/force-re-review", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenNthCalledWith(9, "/api/nodes/n1/approve-budget-override", expect.objectContaining({ method: "POST" }));
  });
});
