import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assertTaskStatusTransition, canTransitionLifecycle, legacyStatusToLifecycle } from "./stateMachine.js";

describe("orchestration state machine", () => {
  test("supports expected lifecycle transition rules", () => {
    assert.equal(canTransitionLifecycle("ready", "running"), true);
    assert.equal(canTransitionLifecycle("running", "complete"), true);
    assert.equal(canTransitionLifecycle("complete", "running"), false);
  });

  test("maps legacy blocked statuses to blocked lifecycle", () => {
    assert.equal(legacyStatusToLifecycle("waiting_input"), "blocked");
    assert.equal(legacyStatusToLifecycle("awaiting_children"), "blocked");
  });

  test("rejects running transition when dependencies are unresolved", () => {
    assert.throws(
      () => {
        assertTaskStatusTransition({
          mode: "execution",
          fromStatus: "queued",
          toStatus: "in_progress",
          hasBlockingDependencies: true,
          hasPendingChildren: false,
          parentGuards: { synthesisPassed: true, verificationPassed: true }
        });
      },
      /blocked_dependencies/
    );
  });

  test("blocks plan completion until synthesis and verification pass", () => {
    assert.throws(
      () => {
        assertTaskStatusTransition({
          mode: "plan",
          fromStatus: "in_progress",
          toStatus: "merge_ready",
          hasBlockingDependencies: false,
          hasPendingChildren: false,
          parentGuards: { synthesisPassed: false, verificationPassed: false }
        });
      },
      /parent_synthesis_required/
    );

    const allowed = assertTaskStatusTransition({
      mode: "plan",
      fromStatus: "in_progress",
      toStatus: "merge_ready",
      hasBlockingDependencies: false,
      hasPendingChildren: false,
      parentGuards: { synthesisPassed: true, verificationPassed: true }
    });
    assert.equal(allowed.toLifecycle, "complete");
  });
});
