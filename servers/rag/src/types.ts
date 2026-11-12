export type RagMode = "fixture" | "files";

/**
 * Folder prefixes a member may read, normalised (relative, "/"-separated, no trailing slash).
 * `undefined` = the whole corpus (scope ["*"]).
 */
export type Folders = string[] | undefined;

/** Counts are limited to the member's folders. */
export interface Status {
  mode: RagMode;
  sample: boolean;
  indexed_at: string | null;
  file_count: number;
  chunk_count: number;
  /** The member's own scope prefixes that match no indexed document (always [] for ["*"]). */
  unmatched_folders: string[];
}

export interface Source {
  path: string;
  title: string;
  ext: string;
  chars: number;
  chunk_count: number;
}

export interface Hit {
  chunk_id: number;
  path: string;
  title: string;
  page: number | null;
  score: number;
  excerpt: string;
}

export interface Chunk {
  id: number;
  path: string;
  title: string;
  page: number | null;
  text: string;
}

/** Whole-corpus totals; no paths, so the result reveals nothing about folders outside the caller's scope. */
export interface ReindexResult {
  indexed_at: string;
  file_count: number;
  chunk_count: number;
  skipped_count: number;
  /** Symlinks skipped (never followed, wherever they point). */
  link_count: number;
  duration_ms: number;
}
