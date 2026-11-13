export interface TextChunk {
  page: number | null;
  text: string;
}

const CHUNK_SIZE = 1400;
const OVERLAP = 160;

/** Splits extracted text into overlapping chunks; form feeds (from pdftotext) mark pages. */
export function chunkText(raw: string): TextChunk[] {
  const pages = raw.includes("\f") ? raw.split("\f") : [raw];
  return pages.flatMap((pageText, i) => splitChunks(pageText, pages.length > 1 ? i + 1 : null));
}

function splitChunks(pageText: string, page: number | null): TextChunk[] {
  const cleaned = pageText.replace(/\u0000/g, "").trim();
  if (!cleaned) return [];
  if (cleaned.length <= CHUNK_SIZE) return [{ page, text: cleaned }];
  const out: TextChunk[] = [];
  let start = 0;
  while (start < cleaned.length) {
    const end = Math.min(cleaned.length, start + CHUNK_SIZE);
    const slice = cleaned.slice(start, end).trim();
    if (slice) out.push({ page, text: slice });
    if (end >= cleaned.length) break;
    start = Math.max(end - OVERLAP, start + 1);
  }
  return out;
}

export function titleFromPath(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  return base.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || relPath;
}
