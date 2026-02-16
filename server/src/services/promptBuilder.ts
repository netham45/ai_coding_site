import type { ProjectRow } from "../types.js";

export function buildEffectivePrompt(project: ProjectRow, taskPrompt: string): string {
  const sections: string[] = [];
  const prompt = project.project_prompt.trim();
  const rules = project.project_rules.trim();
  const codingStandard = project.coding_standard.trim();
  const codingStandardOther = project.coding_standard_other.trim();
  const other = project.project_other.trim();
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
  if (task) {
    sections.push(`Task Prompt:\n${task}`);
  }

  return sections.join("\n\n").trim();
}
