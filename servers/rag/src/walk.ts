import { readdirSync, realpathSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

const SKIP_DIRS = new Set(["node_modules", "$recycle.bin", "system volume information"]);
export const MAX_FILE_BYTES = 40 * 1024 * 1024;

export interface WalkedFile {
  /** Resolved path (no symlinks), always under the resolved root. */
  realPath: string;
  /**
   * The file's real path relative to the resolved docs root, "/"-separated — never the name of a symlink that
   * led to it. This is the path members see and the path the `folders` scope is decided on, so a link cannot
   * move a document into another folder's scope.
   */
  relPath: string;
  bytes: number;
  ext: string;
}

export interface WalkResult {
  /** Each real file once, sorted by relPath. */
  files: WalkedFile[];
  /** Entries skipped because they resolve outside the root (symlinks). */
  outside: number;
}

/** True when `real` is `root` or inside it. Both must already be resolved with realpath. */
export function isUnder(root: string, real: string): boolean {
  return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** A canonical relative path is skipped when any of its segments is hidden or a skipped directory. */
const skipped = (relPath: string) =>
  relPath.split("/").some((s) => s.startsWith(".") || SKIP_DIRS.has(s.toLowerCase()));

/**
 * Lists indexable files under `root`. Every entry is resolved with realpath and must stay under the resolved
 * root, so a symlink pointing outside the docs directory is never followed. Paths are canonical (relative to
 * the resolved root), each real directory is visited once and each real file is returned once, so the result
 * does not depend on which links exist or in which order names sort.
 */
export function walkFiles(root: string): WalkResult {
  const realRoot = realpathSync(root);
  const result: WalkResult = { files: [], outside: 0 };
  const visited = new Set<string>([realRoot]);
  const seenFiles = new Set<string>();
  const visit = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      let real: string;
      try {
        real = realpathSync(join(dir, name));
      } catch {
        continue; // dangling link or vanished entry
      }
      if (!isUnder(realRoot, real)) {
        result.outside += 1;
        continue;
      }
      const relPath = relative(realRoot, real).split(sep).join("/");
      if (relPath === "" || skipped(relPath)) continue;
      let st;
      try {
        st = statSync(real);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (visited.has(real)) continue;
        visited.add(real);
        visit(real);
      } else if (st.isFile() && st.size > 0 && st.size <= MAX_FILE_BYTES && !seenFiles.has(real)) {
        seenFiles.add(real);
        result.files.push({ realPath: real, relPath, bytes: st.size, ext: extname(real).toLowerCase() });
      }
    }
  };
  visit(realRoot);
  result.files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return result;
}
