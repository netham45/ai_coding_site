import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { NodeMetadata, TaskRow } from "../../types.js";
import { recordEvent } from "../events.js";
import { enqueueOrchestrationJob } from "./jobQueue.js";
import { readReplanControl } from "./idempotency.js";
import { readNodeMetadata, writeNodeMetadata } from "./metadata.js";

const SYNTHESIS_TEMPLATE_ID = "ip-09";
const VERIFY_TEMPLATE_ID = "ip-10";
const SYNTHESIS_TEMPLATE_PATH = "prompts/synthesis.md";
const VERIFY_TEMPLATE_PATH = "prompts/verification.md";

type Requirement = {
  id: string;
  text: string;
};

type CoverageEvidence = {
  child_task_id: string;
  artifact_ref: string;
  snippet: string;
  repo_path: string | null;
  module_ref: string | null;
  test_ref: string | null;
};

type CoverageRow = {
  requirement_id: string;
  requirement_text: string;
  coverage_status: "covered" | "partial" | "uncovered";
  evidence: CoverageEvidence[];
  gap_reason: string | null;
};

type SynthesisArtifact = {
  template: { id: string; path: string };
  summary: string;
  coverage_matrix: CoverageRow[];
  uncovered_requirements: string[];
  idempotency_key: string;
  generated_at: string;
};

type VerificationArtifact = {
  template: { id: string; path: string };
  verdict: "pass" | "fail";
  failing_requirements: string[];
  reasons: string[];
  delta_plan_enqueued: boolean;
  budget_exhausted: boolean;
  idempotency_key: string;
  generated_at: string;
};

type DeltaLoopHistoryEntry = {
  generated_at: string;
  verdict: "pass" | "fail";
  reasons: string[];
  failing_requirements: string[];
  delta_plan_enqueued: boolean;
  budget_exhausted: boolean;
  verification_artifact_event_id: string;
  synthesis_artifact_event_id: string;
};

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "for",
  "with",
  "from",
  "into",
  "onto",
  "this",
  "that",
  "these",
  "those",
  "must",
  "should",
  "would",
  "could",
  "have",
  "has",
  "had",
  "will",
  "can",
  "not",
  "only",
  "then",
  "than",
  "when",
  "where",
  "what",
  "why",
  "how",
  "all",
  "any",
  "are",
  "was",
  "were",
  "been",
  "being",
  "you",
  "your",
  "its",
  "our",
  "their",
  "task",
  "plan"
]);

function readTask(projectDb: Database.Database, taskId: string): TaskRow | undefined {
  return projectDb.prepare("SELECT * FROM tasks WHERE id = ? LIMIT 1").get(taskId) as TaskRow | undefined;
}

function readChildren(projectDb: Database.Database, parentTaskId: string): TaskRow[] {
  return projectDb
    .prepare("SELECT * FROM tasks WHERE parent_plan_task_id = ? ORDER BY created_at ASC")
    .all(parentTaskId) as TaskRow[];
}

function tokenize(input: string): string[] {
  const raw = input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((value) => value.trim())
    .filter((value) => value.length >= 4 && !STOPWORDS.has(value));
  return [...new Set(raw)];
}

function truncate(input: string, max = 140): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

function extractRepoPath(input: string): string | null {
  const match = input.match(/\b(?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+\b/);
  return match?.[0] ?? null;
}

function inferModuleRef(repoPath: string | null): string | null {
  if (!repoPath) return null;
  const parts = repoPath.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return `${parts[0]}/${parts[1]}`;
}

function extractTestRef(input: string): string | null {
  const explicit = input.match(/\b[a-zA-Z0-9._/-]*?(?:test|spec)[a-zA-Z0-9._/-]*\b/i);
  if (explicit?.[0]) return explicit[0];
  const fnMatch = input.match(/\b(?:it|test|describe)\s*\(\s*["'`][^"'`]{3,120}["'`]\s*\)/i);
  return fnMatch?.[0] ?? null;
}

function digestStable(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function extractRequirements(taskPrompt: string): Requirement[] {
  const lines = taskPrompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const extracted = lines
    .filter((line) => /^(-|\*|\d+[.)])\s+/.test(line))
    .map((line) => line.replace(/^(-|\*|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
  const unique = [...new Set(extracted)].slice(0, 12);
  return unique.map((text, idx) => ({ id: `req_${idx + 1}`, text }));
}

function toCoverageRow(requirement: Requirement, mergedChildren: TaskRow[]): CoverageRow {
  const reqTokens = tokenize(requirement.text);
  const evidence: CoverageEvidence[] = [];

  for (const child of mergedChildren) {
    const title = child.title ?? "";
    const result = child.result ?? "";
    const source = `${title}\n${result}`;
    const sourceTokens = tokenize(source);
    const overlap = reqTokens.filter((token) => sourceTokens.includes(token));
    if (overlap.length === 0 && reqTokens.length > 0) continue;
    if (!result.trim() && !title.trim()) continue;
    const repoPath = extractRepoPath(source);
    evidence.push({
      child_task_id: child.id,
      artifact_ref: result.trim() ? `task:${child.id}#result` : `task:${child.id}#title`,
      snippet: truncate(result.trim() || title.trim()),
      repo_path: repoPath,
      module_ref: inferModuleRef(repoPath),
      test_ref: extractTestRef(source)
    });
    if (evidence.length >= 3) break;
  }

  if (evidence.length === 0) {
    return {
      requirement_id: requirement.id,
      requirement_text: requirement.text,
      coverage_status: "uncovered",
      evidence: [],
      gap_reason: "no_matching_child_evidence"
    };
  }

  const status: "covered" = "covered";
  return {
    requirement_id: requirement.id,
    requirement_text: requirement.text,
    coverage_status: status,
    evidence,
    gap_reason: null
  };
}

function writeCompletionMetadata(params: {
  projectDb: Database.Database;
  task: TaskRow;
    updates: {
      synthesisPassed?: boolean;
      verificationPassed?: boolean;
      reasonCode: string;
      synthesisArtifactEventId?: string;
      verificationArtifactEventId?: string;
      verificationVerdict?: "pass" | "fail";
      synthesisArtifact?: SynthesisArtifact;
      verificationArtifact?: VerificationArtifact;
      deltaLoopHistoryEntry?: DeltaLoopHistoryEntry;
    };
}): NodeMetadata {
  const metadataRead = readNodeMetadata({
    projectDb: params.projectDb,
    task: params.task,
    dependencyTaskIds: []
  });
  const metadata = metadataRead.metadata;
  metadata.lifecycle = {
    synthesis_passed: params.updates.synthesisPassed ?? metadata.lifecycle?.synthesis_passed,
    verification_passed: params.updates.verificationPassed ?? metadata.lifecycle?.verification_passed,
    last_transition_reason_code: params.updates.reasonCode
  };
  const custom = { ...(metadata.custom ?? {}) } as Record<string, unknown>;
  if (params.updates.synthesisArtifactEventId) {
    custom.synthesis_artifact_event_id = params.updates.synthesisArtifactEventId;
  }
  if (params.updates.verificationArtifactEventId) {
    custom.verification_artifact_event_id = params.updates.verificationArtifactEventId;
  }
  if (params.updates.verificationVerdict) {
    custom.verification_verdict = params.updates.verificationVerdict;
  }
  const completionArtifacts =
    custom.completion_artifacts && typeof custom.completion_artifacts === "object"
      ? { ...(custom.completion_artifacts as Record<string, unknown>) }
      : {};
  if (params.updates.synthesisArtifact) {
    completionArtifacts.synthesis = params.updates.synthesisArtifact;
  }
  if (params.updates.verificationArtifact) {
    completionArtifacts.verification = params.updates.verificationArtifact;
  }
  if (params.updates.deltaLoopHistoryEntry) {
    const historyRaw = Array.isArray(completionArtifacts.delta_loop_history)
      ? (completionArtifacts.delta_loop_history as DeltaLoopHistoryEntry[])
      : [];
    completionArtifacts.delta_loop_history = [...historyRaw, params.updates.deltaLoopHistoryEntry].slice(-20);
  }
  custom.completion_artifacts = completionArtifacts;
  metadata.custom = custom;
  writeNodeMetadata({
    projectDb: params.projectDb,
    taskId: params.task.id,
    metadata
  });
  return metadata;
}

export function resolveParentTaskForCompletion(params: {
  projectDb: Database.Database;
  anchorTaskId: string;
}): TaskRow | null {
  const anchor = readTask(params.projectDb, params.anchorTaskId);
  if (!anchor) return null;
  if (anchor.mode === "plan") return anchor;
  if (!anchor.parent_plan_task_id) return null;
  const parent = readTask(params.projectDb, anchor.parent_plan_task_id);
  if (!parent || parent.mode !== "plan") return null;
  return parent;
}

export async function runSynthesizeForParent(params: {
  projectDb: Database.Database;
  projectId: string;
  parentTaskId: string;
  sourceEventId?: string | null;
}): Promise<{ parentTaskId: string; artifact: SynthesisArtifact; eventId: string } | null> {
  const parent = readTask(params.projectDb, params.parentTaskId);
  if (!parent || parent.mode !== "plan") return null;

  const children = readChildren(params.projectDb, parent.id);
  const mergedChildren = children.filter((child) => child.status === "merged");
  const requirementsFromPrompt = extractRequirements(parent.task_prompt);
  const requirements =
    requirementsFromPrompt.length > 0
      ? requirementsFromPrompt
      : mergedChildren.length > 0
        ? mergedChildren.map((child, idx) => ({
            id: `req_child_${idx + 1}`,
            text: child.title?.trim() || `Child deliverable ${idx + 1}`
          }))
        : [{ id: "req_1", text: "Parent completion requirements" }];
  const coverageMatrix = requirements.map((req) => toCoverageRow(req, mergedChildren));
  const uncovered = coverageMatrix
    .filter((row) => row.coverage_status === "uncovered")
    .map((row) => row.requirement_id);

  const artifact: SynthesisArtifact = {
    template: { id: SYNTHESIS_TEMPLATE_ID, path: SYNTHESIS_TEMPLATE_PATH },
    summary: `Merged child tasks: ${mergedChildren.length}/${children.length}. Covered requirements: ${requirements.length - uncovered.length}/${requirements.length}.`,
    coverage_matrix: coverageMatrix,
    uncovered_requirements: uncovered,
    idempotency_key: digestStable({
      parentTaskId: parent.id,
      requirements,
      childState: children.map((child) => ({ id: child.id, status: child.status, result: child.result, title: child.title }))
    }),
    generated_at: new Date().toISOString()
  };

  const eventWrite = recordEvent({
    projectId: params.projectId,
    taskId: parent.id,
    eventType: "orchestration.synthesize.completed",
    payload: {
      schema_version: 1,
      sourceEventId: params.sourceEventId ?? null,
      parentTaskId: parent.id,
      artifact
    },
    database: params.projectDb
  });

  writeCompletionMetadata({
    projectDb: params.projectDb,
    task: parent,
    updates: {
      synthesisPassed: true,
      verificationPassed: false,
      reasonCode: "orchestration.synthesize.completed",
      synthesisArtifactEventId: eventWrite.eventId,
      synthesisArtifact: artifact
    }
  });

  return { parentTaskId: parent.id, artifact, eventId: eventWrite.eventId };
}

export async function runVerifyForParent(params: {
  projectDb: Database.Database;
  projectId: string;
  parentTaskId: string;
  sourceEventId?: string | null;
}): Promise<{ parentTaskId: string; artifact: VerificationArtifact; eventId: string } | null> {
  const parent = readTask(params.projectDb, params.parentTaskId);
  if (!parent || parent.mode !== "plan") return null;

  const synthesis = await runSynthesizeForParent({
    projectDb: params.projectDb,
    projectId: params.projectId,
    parentTaskId: parent.id,
    sourceEventId: params.sourceEventId ?? null
  });
  if (!synthesis) return null;

  const children = readChildren(params.projectDb, parent.id);
  const hasUnmergedChildren = children.some((child) => child.status !== "merged");
  const failedChildren = children.filter((child) => child.status === "failed" || child.status === "merge_conflict" || child.status === "cancelled");
  const uncovered = synthesis.artifact.coverage_matrix
    .filter((row) => row.coverage_status === "uncovered")
    .map((row) => row.requirement_id);

  const reasons: string[] = [];
  if (hasUnmergedChildren) reasons.push("children_pending_completion");
  if (failedChildren.length > 0) reasons.push("children_failed_or_cancelled");
  if (uncovered.length > 0) reasons.push("coverage_incomplete");

  const metadataRead = readNodeMetadata({ projectDb: params.projectDb, task: parent, dependencyTaskIds: [] });
  const replan = readReplanControl(metadataRead.metadata);

  let deltaPlanEnqueued = false;
  let budgetExhausted = false;
  if (reasons.length > 0 && !hasUnmergedChildren) {
    budgetExhausted = replan.iterationsUsed >= replan.maxIterations && !replan.budgetOverride;
    if (!budgetExhausted) {
      enqueueOrchestrationJob({
        projectId: params.projectId,
        taskId: parent.id,
        jobType: "delta_plan",
        idempotencyKey: digestStable({
          job: "verify->delta_plan",
          parentTaskId: parent.id,
          uncoveredRequirements: uncovered,
          failedChildren: failedChildren.map((child) => child.id),
          synthesisIdempotencyKey: synthesis.artifact.idempotency_key
        }),
        debounceMs: 600,
        dedupeWindowMs: 3_000,
        metadata: {
          source: "orchestration.verify",
          sourceEventId: params.sourceEventId ?? null
        },
        database: params.projectDb
      });
      deltaPlanEnqueued = true;
    }
  }

  const verdict: "pass" | "fail" = reasons.length === 0 ? "pass" : "fail";
  const artifact: VerificationArtifact = {
    template: { id: VERIFY_TEMPLATE_ID, path: VERIFY_TEMPLATE_PATH },
    verdict,
    failing_requirements: uncovered,
    reasons,
    delta_plan_enqueued: deltaPlanEnqueued,
    budget_exhausted: budgetExhausted,
    idempotency_key: digestStable({
      parentTaskId: parent.id,
      reasons,
      uncovered,
      failedChildren: failedChildren.map((child) => `${child.id}:${child.status}`),
      synthesisKey: synthesis.artifact.idempotency_key,
      replanState: {
        iterationsUsed: replan.iterationsUsed,
        maxIterations: replan.maxIterations,
        budgetOverride: replan.budgetOverride
      }
    }),
    generated_at: new Date().toISOString()
  };

  const eventWrite = recordEvent({
    projectId: params.projectId,
    taskId: parent.id,
    eventType: "orchestration.verify.completed",
    payload: {
      schema_version: 1,
      sourceEventId: params.sourceEventId ?? null,
      parentTaskId: parent.id,
      artifact
    },
    database: params.projectDb
  });

  writeCompletionMetadata({
    projectDb: params.projectDb,
    task: parent,
    updates: {
      synthesisPassed: true,
      verificationPassed: verdict === "pass",
      reasonCode: verdict === "pass" ? "orchestration.verify.pass" : "orchestration.verify.fail",
      synthesisArtifactEventId: synthesis.eventId,
      verificationArtifactEventId: eventWrite.eventId,
      verificationVerdict: verdict,
      synthesisArtifact: synthesis.artifact,
      verificationArtifact: artifact,
      deltaLoopHistoryEntry: {
        generated_at: artifact.generated_at,
        verdict,
        reasons,
        failing_requirements: uncovered,
        delta_plan_enqueued: deltaPlanEnqueued,
        budget_exhausted: budgetExhausted,
        verification_artifact_event_id: eventWrite.eventId,
        synthesis_artifact_event_id: synthesis.eventId
      }
    }
  });

  return { parentTaskId: parent.id, artifact, eventId: eventWrite.eventId };
}

export async function runParentCompletionFeedbackLoop(params: {
  projectDb: Database.Database;
  projectId: string;
  parentTaskId: string;
  sourceEventId?: string | null;
}): Promise<{ verified: boolean; budgetExhausted: boolean } | null> {
  const verify = await runVerifyForParent({
    projectDb: params.projectDb,
    projectId: params.projectId,
    parentTaskId: params.parentTaskId,
    sourceEventId: params.sourceEventId ?? null
  });
  if (!verify) return null;
  return {
    verified: verify.artifact.verdict === "pass",
    budgetExhausted: verify.artifact.budget_exhausted
  };
}
