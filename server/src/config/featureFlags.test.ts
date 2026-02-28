import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  legacyPlanOrchestrationPassOwnershipEnabled,
  orchestrationLegacyJobOwnershipEnabled
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

  test("defaults legacy ownership flags to disabled when env vars are unset", () => {
    delete process.env.ORCHESTRATION_LEGACY_PLAN_ORCHESTRATION_PASS_ENABLED;
    delete process.env.ORCHESTRATION_LEGACY_JOB_OWNERSHIP_ENABLED;

    assert.equal(orchestrationLegacyJobOwnershipEnabled(), false);
    assert.equal(legacyPlanOrchestrationPassOwnershipEnabled(), false);
  });

  test("parses boolean-like env values for legacy ownership toggles", () => {
    process.env.ORCHESTRATION_LEGACY_PLAN_ORCHESTRATION_PASS_ENABLED = "on";
    process.env.ORCHESTRATION_LEGACY_JOB_OWNERSHIP_ENABLED = "yes";

    assert.equal(legacyPlanOrchestrationPassOwnershipEnabled(), true);
    assert.equal(orchestrationLegacyJobOwnershipEnabled(), true);
  });

  test("compatibility mode no longer alters legacy ownership flags", () => {
    process.env.ORCHESTRATION_COMPATIBILITY_MODE = "true";
    process.env.ORCHESTRATION_LEGACY_PLAN_ORCHESTRATION_PASS_ENABLED = "true";
    process.env.ORCHESTRATION_LEGACY_JOB_OWNERSHIP_ENABLED = "false";

    assert.equal(legacyPlanOrchestrationPassOwnershipEnabled(), true);
    assert.equal(orchestrationLegacyJobOwnershipEnabled(), false);
  });
});
