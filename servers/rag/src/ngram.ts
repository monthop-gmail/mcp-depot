/** A short excerpt of `text` around the first place the query (or one of its terms) occurs. */
export function excerptAround(text: string, query: string, width = 220): string {
  const hay = text.replace(/\s+/g, " ").trim();
  if (!hay) return "";
  const needle = query.trim();
  const lower = hay.toLowerCase();
  let idx = needle ? lower.indexOf(needle.toLowerCase()) : -1;
  if (idx < 0) {
    const compact = needle.replace(/\s+/g, "");
    idx = compact ? hay.indexOf(compact) : -1;
  }
  if (idx < 0) {
    for (const part of needle.split(/\s+/).filter((t) => [...t].length >= 2)) {
      idx = lower.indexOf(part.toLowerCase());
      if (idx >= 0) break;
    }
  }
  if (idx < 0) return hay.slice(0, width * 2);
  const start = Math.max(0, idx - width);
  const end = Math.min(hay.length, idx + Math.max(needle.length, 2) + width);
  return `${start > 0 ? "…" : ""}${hay.slice(start, end)}${end < hay.length ? "…" : ""}`;
}
