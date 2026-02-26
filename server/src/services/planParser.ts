export type ParsedPlanTask = {
  itemKey: string;
  itemType: "execution_task" | "sub_plan";
  title: string;
  prompt: string;
  dependsOnItemKeys: string[];
  autoMerge: boolean;
  autoStart: boolean;
  autoMergeOnComplete: boolean;
};

export type ParsedPlan = {
  tasks: ParsedPlanTask[];
  autoStart: boolean;
  autoMergeOnComplete: boolean;
  autoMergeItemKeys: string[];
  yamlText: string;
};

function normalizeKey(raw: string): string {
  return raw.trim().replace(/^task\s+/i, "").trim();
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return [];
  }
  return trimmed
    .slice(1, -1)
    .split(",")
    .map((part) => normalizeKey(stripQuotes(part)))
    .filter(Boolean);
}

function parseBoolean(value: string): boolean | undefined {
  const normalized = stripQuotes(value).trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function countIndent(line: string): number {
  let indent = 0;
  while (indent < line.length && line[indent] === " ") {
    indent += 1;
  }
  return indent;
}

function isYamlBlockScalarToken(value: string): boolean {
  const token = value.trim();
  return token === "|" || token === ">" || token === "|-" || token === "|+" || token === ">-" || token === ">+";
}

export function extractYamlDocument(rawText: string): string {
  const fencedMatch = rawText.match(/```ya?ml\s*\n([\s\S]*?)```/i);
  if (fencedMatch?.[1]?.trim()) {
    return fencedMatch[1].trim();
  }

  const planStart = rawText.search(/(^|\n)(tasks|items):\s*(\n|$)/i);
  if (planStart >= 0) {
    return rawText.slice(planStart).trim();
  }

  throw new Error("No YAML plan found. Provide a YAML block containing a top-level `tasks:` list.");
}

function detectCycles(tasks: ParsedPlanTask[]): void {
  const byKey = new Map(tasks.map((task) => [task.itemKey.toLowerCase(), task]));
  const permanent = new Set<string>();
  const temporary = new Set<string>();

  const visit = (key: string): void => {
    const normalized = key.toLowerCase();
    if (permanent.has(normalized)) return;
    if (temporary.has(normalized)) {
      throw new Error(`Cyclic dependency detected at task ${key}`);
    }

    temporary.add(normalized);
    const task = byKey.get(normalized);
    if (task) {
      for (const dep of task.dependsOnItemKeys) {
        visit(dep);
      }
    }
    temporary.delete(normalized);
    permanent.add(normalized);
  };

  for (const task of tasks) {
    visit(task.itemKey);
  }
}

export function parsePlanYaml(yamlText: string): ParsedPlan {
  const lines = yamlText.replace(/\r\n/g, "\n").split("\n");
  const tasksRootIndex = lines.findIndex((line) => line.trim() === "tasks:" || line.trim() === "items:");
  if (tasksRootIndex < 0) {
    throw new Error("YAML plan must include a top-level `tasks:` key");
  }

  let defaultAutoStart = false;
  let defaultAutoMergeOnComplete = false;
  let defaultAutoMergeItemKeys: string[] = [];
  let topLevelIndex = 0;
  while (topLevelIndex < tasksRootIndex) {
    const line = lines[topLevelIndex];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      topLevelIndex += 1;
      continue;
    }
    if (countIndent(line) !== 0) {
      topLevelIndex += 1;
      continue;
    }
    const topLevelMatch = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (!topLevelMatch) {
      topLevelIndex += 1;
      continue;
    }
    const key = topLevelMatch[1];
    const value = topLevelMatch[2] ?? "";
    if (key === "auto_start") {
      const parsed = parseBoolean(value);
      if (parsed === undefined) {
        throw new Error("Top-level `auto_start` must be true or false");
      }
      defaultAutoStart = parsed;
      topLevelIndex += 1;
      continue;
    }
    if (key === "auto_merge_on_complete") {
      const parsed = parseBoolean(value);
      if (parsed === undefined) {
        throw new Error("Top-level `auto_merge_on_complete` must be true or false");
      }
      defaultAutoMergeOnComplete = parsed;
      topLevelIndex += 1;
      continue;
    }
    if (key === "auto_merge_item_keys") {
      const inlineList = parseInlineList(value);
      if (inlineList.length > 0) {
        defaultAutoMergeItemKeys = inlineList;
        topLevelIndex += 1;
        continue;
      }

      topLevelIndex += 1;
      const itemKeys: string[] = [];
      while (topLevelIndex < tasksRootIndex) {
        const depLine = lines[topLevelIndex];
        const depTrimmed = depLine.trim();
        const depIndent = countIndent(depLine);
        if (!depTrimmed) {
          topLevelIndex += 1;
          continue;
        }
        if (depIndent < 2) break;
        const depMatch = depLine.match(/^\s{2}-\s*(.+)$/);
        if (!depMatch) break;
        itemKeys.push(normalizeKey(stripQuotes(depMatch[1])));
        topLevelIndex += 1;
      }
      defaultAutoMergeItemKeys = itemKeys.filter(Boolean);
      continue;
    }
    topLevelIndex += 1;
  }

  const tasks: ParsedPlanTask[] = [];
  let index = tasksRootIndex + 1;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      index += 1;
      continue;
    }

    if (countIndent(line) < 2) {
      break;
    }

    const itemMatch = line.match(/^\s{2}-\s*(.*)$/);
    if (!itemMatch) {
      throw new Error(`Invalid task list entry near line ${index + 1}`);
    }

    const item: {
      id?: string;
      title?: string;
      prompt?: string;
      item_type?: "execution_task" | "sub_plan";
      auto_merge?: boolean;
      auto_start?: boolean;
      auto_merge_on_complete?: boolean;
      depends_on?: string[];
    } = {
      depends_on: []
    };

    const inline = itemMatch[1].trim();
    if (inline) {
      const [k, ...rest] = inline.split(":");
      if (!k || rest.length === 0) {
        throw new Error(`Invalid inline task property near line ${index + 1}`);
      }
      const v = rest.join(":").trim();
      if (k.trim() === "id") item.id = stripQuotes(v);
      if (k.trim() === "title") item.title = stripQuotes(v);
      if (k.trim() === "prompt") item.prompt = stripQuotes(v);
      if (k.trim() === "item_type" || k.trim() === "type") {
        const candidate = stripQuotes(v).trim().toLowerCase();
        if (candidate === "execution_task" || candidate === "sub_plan") {
          item.item_type = candidate;
        } else if (candidate === "execution" || candidate === "task") {
          item.item_type = "execution_task";
        } else if (candidate === "plan" || candidate === "subplan" || candidate === "sub_plan") {
          item.item_type = "sub_plan";
        }
      }
    }

    index += 1;
    while (index < lines.length) {
      const propertyLine = lines[index];
      const propertyTrimmed = propertyLine.trim();
      const indent = countIndent(propertyLine);

      if (!propertyTrimmed || propertyTrimmed.startsWith("#")) {
        index += 1;
        continue;
      }
      if (indent <= 2) {
        break;
      }
      if (indent < 4) {
        throw new Error(`Invalid task property indentation near line ${index + 1}`);
      }

      const propertyMatch = propertyLine.match(/^\s{4}([a-zA-Z0-9_]+):\s*(.*)$/);
      if (!propertyMatch) {
        throw new Error(`Invalid task property near line ${index + 1}`);
      }
      const key = propertyMatch[1];
      const value = propertyMatch[2] ?? "";

      if (key === "id") {
        item.id = stripQuotes(value);
        index += 1;
        continue;
      }
      if (key === "title") {
        item.title = stripQuotes(value);
        index += 1;
        continue;
      }
      if (key === "prompt") {
        if (isYamlBlockScalarToken(value)) {
          index += 1;
          const promptLines: string[] = [];
          while (index < lines.length) {
            const promptLine = lines[index];
            const promptIndent = countIndent(promptLine);
            if (promptLine.trim() === "") {
              promptLines.push("");
              index += 1;
              continue;
            }
            if (promptIndent < 6) break;
            promptLines.push(promptLine.slice(6));
            index += 1;
          }
          item.prompt = promptLines.join("\n").trim();
          continue;
        }
        item.prompt = stripQuotes(value);
        index += 1;
        continue;
      }
      if (key === "depends_on") {
        const inlineList = parseInlineList(value);
        if (inlineList.length) {
          item.depends_on = inlineList;
          index += 1;
          continue;
        }

        index += 1;
        const deps: string[] = [];
        while (index < lines.length) {
          const depLine = lines[index];
          const depTrimmed = depLine.trim();
          const depIndent = countIndent(depLine);
          if (!depTrimmed) {
            index += 1;
            continue;
          }
          if (depIndent < 6) break;
          const depMatch = depLine.match(/^\s{6}-\s*(.+)$/);
          if (!depMatch) {
            break;
          }
          deps.push(normalizeKey(stripQuotes(depMatch[1])));
          index += 1;
        }
        item.depends_on = deps;
        continue;
      }
      if (key === "item_type" || key === "type") {
        const candidate = stripQuotes(value).trim().toLowerCase();
        if (candidate === "execution_task" || candidate === "sub_plan") {
          item.item_type = candidate;
        } else if (candidate === "execution" || candidate === "task") {
          item.item_type = "execution_task";
        } else if (candidate === "plan" || candidate === "subplan" || candidate === "sub_plan") {
          item.item_type = "sub_plan";
        } else {
          throw new Error(`Task item_type must be execution_task or sub_plan (line ${index + 1})`);
        }
        index += 1;
        continue;
      }
      if (key === "auto_merge") {
        const parsed = parseBoolean(value);
        if (parsed === undefined) {
          throw new Error(`Task auto_merge must be true or false (line ${index + 1})`);
        }
        item.auto_merge = parsed;
        index += 1;
        continue;
      }
      if (key === "auto_start") {
        const parsed = parseBoolean(value);
        if (parsed === undefined) {
          throw new Error(`Task auto_start must be true or false (line ${index + 1})`);
        }
        item.auto_start = parsed;
        index += 1;
        continue;
      }
      if (key === "auto_merge_on_complete") {
        const parsed = parseBoolean(value);
        if (parsed === undefined) {
          throw new Error(`Task auto_merge_on_complete must be true or false (line ${index + 1})`);
        }
        item.auto_merge_on_complete = parsed;
        index += 1;
        continue;
      }

      index += 1;
    }

    const itemKey = normalizeKey(item.id ?? "");
    if (!itemKey) {
      throw new Error("Each YAML task must include an `id`");
    }
    const title = (item.title ?? `Task ${itemKey}`).trim();
    const prompt = (item.prompt ?? "").trim();
    if (!prompt) {
      throw new Error(`Task ${itemKey} is missing a prompt`);
    }
    const itemType = item.item_type ?? "execution_task";
    const autoMerge =
      itemType === "execution_task"
        ? (item.auto_merge ?? defaultAutoMergeItemKeys.some((key) => key.toLowerCase() === itemKey.toLowerCase()))
        : (item.auto_merge ?? false);
    const autoStart = itemType === "sub_plan" ? (item.auto_start ?? defaultAutoStart) : (item.auto_start ?? false);
    const autoMergeOnComplete =
      itemType === "sub_plan" ? (item.auto_merge_on_complete ?? defaultAutoMergeOnComplete) : (item.auto_merge_on_complete ?? false);
    if (itemType === "execution_task" && (autoStart || autoMergeOnComplete)) {
      throw new Error(`Task ${itemKey} is execution_task and cannot set auto_start or auto_merge_on_complete`);
    }
    if (itemType === "sub_plan" && autoMerge) {
      throw new Error(`Task ${itemKey} is sub_plan and cannot set auto_merge`);
    }

    const dependsOnItemKeys = [...new Set((item.depends_on ?? []).map((dep) => normalizeKey(dep)).filter(Boolean))];
    const selfDependency = dependsOnItemKeys.find((dep) => dep.toLowerCase() === itemKey.toLowerCase());
    if (selfDependency) {
      throw new Error(`Task ${itemKey} cannot depend on itself`);
    }

    tasks.push({
      itemKey,
      itemType,
      title,
      prompt,
      dependsOnItemKeys,
      autoMerge,
      autoStart,
      autoMergeOnComplete
    });
  }

  if (!tasks.length) {
    throw new Error("YAML plan has no tasks");
  }

  const seen = new Set<string>();
  for (const task of tasks) {
    const normalized = task.itemKey.toLowerCase();
    if (seen.has(normalized)) {
      throw new Error(`Duplicate task identifier found: ${task.itemKey}`);
    }
    seen.add(normalized);
  }

  const keySet = new Set(tasks.map((task) => task.itemKey.toLowerCase()));
  for (const task of tasks) {
    for (const dep of task.dependsOnItemKeys) {
      if (!keySet.has(dep.toLowerCase())) {
        throw new Error(`Task ${task.itemKey} depends on missing task ${dep}`);
      }
    }
  }

  detectCycles(tasks);
  return {
    tasks,
    autoStart: defaultAutoStart,
    autoMergeOnComplete: defaultAutoMergeOnComplete,
    autoMergeItemKeys: defaultAutoMergeItemKeys,
    yamlText
  };
}

export function parsePlanOutput(rawOutput: string): ParsedPlan {
  const yamlText = extractYamlDocument(rawOutput);
  return parsePlanYaml(yamlText);
}
