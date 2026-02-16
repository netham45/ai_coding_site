export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function nextSlug(base: string, exists: (slug: string) => boolean): string {
  const safeBase = base || "project";
  if (!exists(safeBase)) {
    return safeBase;
  }

  let suffix = 2;
  while (exists(`${safeBase}-${suffix}`)) {
    suffix += 1;
  }
  return `${safeBase}-${suffix}`;
}
