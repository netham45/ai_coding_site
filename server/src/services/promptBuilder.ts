import type { ProjectRow } from "../types.js";

type DependencySummary = {
  id: string;
  title: string;
  result: string;
};

function cliUsageInstructions(): string {
  return [
    "CLI Usage:",
    "- Run commands with `acs <command>` from the repository root or any nested directory in this ai-coding-site workspace (for example: /server, /server/src/cli, /web).",
    "- First run `acs --help` to view all available commands and options.",
    "- Backward compatible fallback: `npm run cli -- <command>`.",
    "- If you see `Could not locate the ai-coding-site workspace root`, run the command from within this workspace (for example, <workspace>/server).",
    "- Available commands:",
    "  - tasks list [--project-id <projectId>] [--plan-id <planId>]",
    "  - tasks all [--project-id <projectId>] [--plan-id <planId>]",
    "  - tasks active [--project-id <projectId>] [--plan-id <planId>]",
    "  - tasks get <taskId> [--project-id <projectId>] [--plan-id <planId>]",
    "  - tasks summary <taskId> [--project-id <projectId>] [--plan-id <planId>]",
    "  - tasks details <taskId> [--project-id <projectId>] [--plan-id <planId>]",
    "  - tasks create --project <projectId> --title <title> --prompt <prompt> [--ai-command <cmd>] [--depends-on a,b] [--auto-merge]",
    "  - tasks start <taskId>",
    "  - tasks input <taskId> --text <text>",
    "  - tasks pull-main <taskId>",
    "  - plans list [--project-id <projectId>] [--plan-id <planId>]",
    "  - plans create --project <projectId> --title <title> --prompt <prompt> [--ai-command <cmd>]",
    "  - plans get <planId>",
    "  - plans review <planId>",
    "  - plans extract <planId>",
    "  - plans regenerate <planId> --feedback <text>",
    "  - plans approve <planId> [--auto-merge-item-keys a,b] [--task-edits-file path.json]",
    "  - info <taskId> [--project-id <projectId>] [--plan-id <planId>]",
    "  - session start <taskId>",
    "  - session input <taskId> --text <text>",
    "  - create task ...",
    "  - create plan ...",
    "  - review task <taskId>",
    "  - review plan <planId>",
    "  - review <taskId>",
    "  - ide status <taskId>",
    "  - ide start <taskId>",
    "  - ide stop <taskId>",
    "  - ready_merge <taskId>",
    "  - ready_merge task <taskId>",
    "  - ready_merge plan <planId>",
    "  - merge <taskId>",
    "  - merge task <taskId>",
    "  - merge plan <planId>"
  ].join("\n");
}

export function buildEffectivePrompt(project: ProjectRow, taskPrompt: string, dependencySummaries: DependencySummary[] = []): string {
  const sections: string[] = [];
  const prompt = (project.project_prompt ?? "").trim();
  const rules = (project.project_rules ?? "").trim();
  const codingStandard = (project.coding_standard ?? "").trim();
  const codingStandardOther = (project.coding_standard_other ?? "").trim();
  const other = (project.project_other ?? "").trim();
  const task = taskPrompt.trim();

  if (prompt) {
    sections.push(`Project Prompt:\n${prompt}`);
  }
  if (rules) {
    sections.push(`Rules:\n${rules}`);
  }
  if (codingStandard) {
    const standardValue =
      codingStandard.toLowerCase() === "other" && codingStandardOther ? codingStandardOther : codingStandard;
    sections.push(`Coding Standard:\n${standardValue}`);
  } else if (codingStandardOther) {
    sections.push(`Coding Standard:\n${codingStandardOther}`);
  }
  if (other) {
    sections.push(`Other:\n${other}`);
  }
  if (dependencySummaries.length > 0) {
    const formatted = dependencySummaries
      .filter((summary) => summary.result.trim().length > 0)
      .map((summary) => `- ${summary.title} (${summary.id}):\n${summary.result.trim()}`)
      .join("\n\n");
    if (formatted) {
      sections.push(`Dependency Summaries:\n${formatted}`);
    }
  }
  if (task) {
    sections.push(`Task Prompt:\n${task}`);
  }
  sections.push(cliUsageInstructions());

  return sections.join("\n\n").trim();
}
