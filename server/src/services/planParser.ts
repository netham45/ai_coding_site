export type ParsedPlanTask = {
  itemKey: string;
  title: string;
  prompt: string;
  dependsOnItemKeys: string[];
};

export type ParsedPlan = {
  tasks: ParsedPlanTask[];
};

function normalizeKey(raw: string): string {
  return raw.trim().replace(/^task\s+/i, "").trim();
}

function parseDependencyList(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((part) => normalizeKey(part))
    .filter(Boolean);
}

function detectCycles(tasks: ParsedPlanTask[]): void {
  const byKey = new Map(tasks.map((task) => [task.itemKey, task]));
  const permanent = new Set<string>();
  const temporary = new Set<string>();

  const visit = (key: string): void => {
    if (permanent.has(key)) return;
    if (temporary.has(key)) {
      throw new Error(`Cyclic dependency detected at task ${key}`);
    }

    temporary.add(key);
    const task = byKey.get(key);
    if (task) {
      for (const dep of task.dependsOnItemKeys) {
        visit(dep);
      }
    }
    temporary.delete(key);
    permanent.add(key);
  };

  for (const task of tasks) {
    visit(task.itemKey);
  }
}

export function parsePlanOutput(rawOutput: string): ParsedPlan {
  const marker = /<task\s+([^>]+)>/gi;
  const matches = [...rawOutput.matchAll(marker)];

  if (!matches.length) {
    throw new Error("No <task ...> blocks found in plan output");
  }

  const tasks: ParsedPlanTask[] = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const blockStart = match.index ?? 0;
    const blockEnd = index + 1 < matches.length ? (matches[index + 1].index ?? rawOutput.length) : rawOutput.length;
    const block = rawOutput.slice(blockStart, blockEnd);

    const itemKey = normalizeKey(match[1] ?? "");
    if (!itemKey) {
      throw new Error("Encountered a task block with an empty task identifier");
    }

    const promptMatch = block.match(/<prompt>([\s\S]*?)<\/prompt>/i);
    const prompt = (promptMatch?.[1] ?? "").trim();
    if (!prompt) {
      throw new Error(`Task ${itemKey} is missing a <prompt>...</prompt> block`);
    }

    const dependsMatch = block.match(/<depends\s+on\s+([^>]+)>/i);
    const dependsOnItemKeys = dependsMatch ? parseDependencyList(dependsMatch[1] ?? "") : [];

    const selfDependency = dependsOnItemKeys.find((dep) => dep.toLowerCase() === itemKey.toLowerCase());
    if (selfDependency) {
      throw new Error(`Task ${itemKey} cannot depend on itself`);
    }

    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/i);
    const title = (titleMatch?.[1] ?? `Task ${itemKey}`).trim();

    tasks.push({
      itemKey,
      title: title || `Task ${itemKey}`,
      prompt,
      dependsOnItemKeys
    });
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
  return { tasks };
}
