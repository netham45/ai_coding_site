function boolFromEnv(name: string): boolean | undefined {
  const raw = process.env[name];
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return undefined;
}

export function orchestrationCompatibilityModeEnabled(): boolean {
  return boolFromEnv("ORCHESTRATION_COMPATIBILITY_MODE") === true;
}

export function orchestrationWorkersEnabled(): boolean {
  if (orchestrationCompatibilityModeEnabled()) {
    return false;
  }
  return boolFromEnv("ORCHESTRATION_WORKERS_ENABLED") ?? true;
}

export function orchestrationHierarchyApiEnabled(): boolean {
  if (orchestrationCompatibilityModeEnabled()) {
    return false;
  }
  return boolFromEnv("ORCHESTRATION_HIERARCHY_API_ENABLED") ?? true;
}

export function orchestrationActionsApiEnabled(): boolean {
  if (orchestrationCompatibilityModeEnabled()) {
    return false;
  }
  return boolFromEnv("ORCHESTRATION_ACTIONS_API_ENABLED") ?? true;
}
