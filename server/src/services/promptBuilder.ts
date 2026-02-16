import type { ProjectRow } from "../types.js";

type DependencySummary = {
  id: string;
  title: string;
  result: string;
};

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

  return sections.join("\n\n").trim();
}
