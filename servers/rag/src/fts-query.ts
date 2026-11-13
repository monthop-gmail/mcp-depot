import { foldThai, normalizeThaiPdf } from "./thai-normalize.js";

/**
 * Turns a user query into an FTS5 MATCH expression plus LIKE patterns, both passed as bound parameters.
 * The trigram tokenizer needs 3+ characters, so shorter terms fall back to LIKE. Each term is quoted, so FTS5
 * operators typed by the caller are searched as text, not interpreted.
 */
export interface PreparedSearch {
  match: string | null;
  likes: string[];
}

const quote = (term: string) => `"${term.replaceAll('"', '""')}"`;

export function prepareSearch(query: string): PreparedSearch {
  const terms = normalizeThaiPdf(query).trim().split(/\s+/).filter(Boolean);
  const matchParts: string[] = [];
  const likes: string[] = [];
  for (const term of terms) {
    if ([...term].length < 3) {
      likes.push(`%${escapeLike(term)}%`);
      continue;
    }
    const folded = foldThai(term);
    matchParts.push(folded.length >= 3 && folded !== term ? `(${quote(term)} OR ${quote(folded)})` : quote(term));
  }
  return { match: matchParts.length > 0 ? matchParts.join(" AND ") : null, likes };
}

/** Escapes LIKE wildcards for use with `ESCAPE '\'`. */
export function escapeLike(term: string): string {
  return term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
