const scpLike = /^[^@\s]+@[^:\s]+:[^\s]+$/;

export function isValidRepoUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  if (scpLike.test(value)) return true;

  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "ssh:";
  } catch {
    return false;
  }
}
