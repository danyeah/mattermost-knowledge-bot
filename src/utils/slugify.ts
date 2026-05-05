export function slugify(input: string, maxLen = 60): string {
  if (!input || !input.trim()) return "untitled";

  const normalized = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen);

  if (!normalized || !/[a-z]/.test(normalized)) return "untitled";
  return normalized;
}
