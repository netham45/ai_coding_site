export type ProjectDbFailureStage = "open" | "validation" | "migration" | "resolve";

export type ProjectDbFailureDiagnostic = {
  stage: ProjectDbFailureStage;
  code?: string;
  projectId?: string;
  basePath?: string;
  dbPath?: string;
  message: string;
  at: string;
};

const MAX_RECENT_FAILURES = 50;
const failureCounts = new Map<string, number>();
const recentFailures: ProjectDbFailureDiagnostic[] = [];

function makeKey(stage: ProjectDbFailureStage, code?: string): string {
  return `${stage}:${code ?? "unknown"}`;
}

export function recordProjectDbFailure(failure: Omit<ProjectDbFailureDiagnostic, "at">): ProjectDbFailureDiagnostic {
  const entry: ProjectDbFailureDiagnostic = { ...failure, at: new Date().toISOString() };
  const key = makeKey(entry.stage, entry.code);
  failureCounts.set(key, (failureCounts.get(key) ?? 0) + 1);
  recentFailures.push(entry);
  if (recentFailures.length > MAX_RECENT_FAILURES) {
    recentFailures.splice(0, recentFailures.length - MAX_RECENT_FAILURES);
  }
  return entry;
}

export function collectProjectDbDiagnosticsHealth(): {
  failureCounts: Record<string, number>;
  recentFailures: ProjectDbFailureDiagnostic[];
} {
  return {
    failureCounts: Object.fromEntries(failureCounts.entries()),
    recentFailures: recentFailures.slice(-10)
  };
}

export function resetProjectDbDiagnosticsForTests(): void {
  failureCounts.clear();
  recentFailures.length = 0;
}
