import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  legacyPlanOrchestrationPassOwnershipEnabled,
  orchestrationActionsApiEnabled,
  orchestrationCompatibilityModeEnabled,
  orchestrationHierarchyApiEnabled,
  orchestrationLegacyJobOwnershipEnabled,
  orchestrationWorkersEnabled
} from "./featureFlags.js";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

describe("feature flags", () => {
  afterEach(() => {
    resetEnv();
  });

  test("compatibility mode hard-disables orchestration APIs and workers", () => {
    process.env.ORCHESTRATION_COMPATIBILITY_MODE = "true";
    process.env.ORCHESTRATION_WORKERS_ENABLED = "true";
    process.env.ORCHESTRATION_HIERARCHY_API_ENABLED = "true";
    process.env.ORCHESTRATION_ACTIONS_API_ENABLED = "true";
    process.env.ORCHESTRATION_LEGACY_PLAN_ORCHESTRATION_PASS_ENABLED = "true";
    process.env.ORCHESTRATION_LEGACY_JOB_OWNERSHIP_ENABLED = "false";

    assert.equal(orchestrationCompatibilityModeEnabled(), true);
    assert.equal(orchestrationLegacyJobOwnershipEnabled(), true);
    assert.equal(orchestrationWorkersEnabled(), false);
    assert.equal(orchestrationHierarchyApiEnabled(), false);
    assert.equal(orchestrationActionsApiEnabled(), false);
    assert.equal(legacyPlanOrchestrationPassOwnershipEnabled(), false);
  });

  test("defaults to workers/apis enabled when env vars are unset or invalid", () => {
    delete process.env.ORCHESTRATION_COMPATIBILITY_MODE;
    delete process.env.ORCHESTRATION_WORKERS_ENABLED;
    delete process.env.ORCHESTRATION_HIERARCHY_API_ENABLED;
    delete process.env.ORCHESTRATION_ACTIONS_API_ENABLED;
    delete process.env.ORCHESTRATION_LEGACY_PLAN_ORCHESTRATION_PASS_ENABLED;
    delete process.env.ORCHESTRATION_LEGACY_JOB_OWNERSHIP_ENABLED;

    assert.equal(orchestrationCompatibilityModeEnabled(), false);
    assert.equal(orchestrationLegacyJobOwnershipEnabled(), false);
    assert.equal(orchestrationWorkersEnabled(), true);
    assert.equal(orchestrationHierarchyApiEnabled(), true);
    assert.equal(orchestrationActionsApiEnabled(), true);
    assert.equal(legacyPlanOrchestrationPassOwnershipEnabled(), false);

    process.env.ORCHESTRATION_WORKERS_ENABLED = "invalid";
    assert.equal(orchestrationWorkersEnabled(), true);
  });

  test("parses boolean-like env values for granular toggles", () => {
    process.env.ORCHESTRATION_WORKERS_ENABLED = "off";
    process.env.ORCHESTRATION_HIERARCHY_API_ENABLED = "0";
    process.env.ORCHESTRATION_ACTIONS_API_ENABLED = "no";
    process.env.ORCHESTRATION_LEGACY_PLAN_ORCHESTRATION_PASS_ENABLED = "on";
    process.env.ORCHESTRATION_LEGACY_JOB_OWNERSHIP_ENABLED = "yes";

    assert.equal(orchestrationWorkersEnabled(), false);
    assert.equal(orchestrationHierarchyApiEnabled(), false);
    assert.equal(orchestrationActionsApiEnabled(), false);
    assert.equal(legacyPlanOrchestrationPassOwnershipEnabled(), true);
    assert.equal(orchestrationLegacyJobOwnershipEnabled(), true);
  });
});
