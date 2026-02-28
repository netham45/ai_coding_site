function boolFromEnv(name: string): boolean | undefined {
  const raw = process.env[name];
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return undefined;
}

export function legacyPlanOrchestrationPassOwnershipEnabled(): boolean {
  return boolFromEnv("ORCHESTRATION_LEGACY_PLAN_ORCHESTRATION_PASS_ENABLED") ?? false;
}

export function orchestrationLegacyJobOwnershipEnabled(): boolean {
  return boolFromEnv("ORCHESTRATION_LEGACY_JOB_OWNERSHIP_ENABLED") === true;
}
