/** Thai combining marks that pdftotext often detaches from the base consonant. */
const THAI_COMBINING = "\u0E31\u0E34-\u0E3A\u0E47-\u0E4E";
const THAI_BASE = "\u0E01-\u0E2E";
const ZW = /[\u200B-\u200D\uFEFF]/gu;

const COMBINING_RE = new RegExp(`[${THAI_COMBINING}]`, "gu");
const MARK_SPACE_MARK = new RegExp(`([${THAI_BASE}${THAI_COMBINING}])[ \\t\\u00A0]+([${THAI_COMBINING}])`, "gu");
const MARK_SPACE_BASE = new RegExp(`([${THAI_COMBINING}])[ \\t\\u00A0]+([${THAI_BASE}])`, "gu");
const BASE_SPACE_MARK = new RegExp(`([${THAI_BASE}])[ \\t\\u00A0]+([${THAI_COMBINING}])`, "gu");
const DANGLING = new RegExp(`\\s[${THAI_COMBINING}]`, "gu");

/** NFC, no zero-width characters, no Thai upper/lower marks, no whitespace: the form both index and query fold to. */
export function foldThai(text: string): string {
  return text.normalize("NFC").replace(ZW, "").replace(COMBINING_RE, "").replace(/\s+/gu, "");
}

/**
 * Repairs pdftotext layout artifacts: NFC, drop zero-width characters, glue floating Thai vowels and tone marks
 * back onto neighbouring letters. Does not invent missing glyphs.
 */
export function normalizeThaiPdf(text: string): string {
  let out = text.normalize("NFC").replace(ZW, "");
  for (let i = 0; i < 8; i += 1) {
    const next = out.replace(MARK_SPACE_MARK, "$1$2").replace(BASE_SPACE_MARK, "$1$2").replace(MARK_SPACE_BASE, "$1$2");
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Higher = more likely the extractor split marks away from their consonant. */
export function thaiExtractionPenalty(text: string): number {
  return ((text.match(BASE_SPACE_MARK)?.length ?? 0) + (text.match(DANGLING)?.length ?? 0)) * 8;
}

/** Chooses between pdftotext -layout and -raw output for one page, preferring fewer detached marks. */
export function pickBetterThaiExtract(layout: string, raw: string): string {
  if (!layout.trim()) return normalizeThaiPdf(raw);
  if (!raw.trim()) return normalizeThaiPdf(layout);
  return normalizeThaiPdf(thaiExtractionPenalty(raw) < thaiExtractionPenalty(layout) ? raw : layout);
}

/** Text given to the FTS5 trigram index: the readable form plus, when different, the folded form. */
export function ftsIndexText(text: string): string {
  const norm = normalizeThaiPdf(text);
  const folded = foldThai(norm);
  return folded.length >= 3 && folded !== norm.replace(/\s+/gu, "") ? `${norm}\n${folded}` : norm;
}
