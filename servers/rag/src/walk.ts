import { lstatSync, readdirSync, realpathSync } from "node:fs";
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
  /** Symlinks skipped (files or folders, wherever they point): links are never followed. */
  links: number;
}

/** True when `real` is `root` or inside it. Both must already be resolved with realpath. */
export function isUnder(root: string, real: string): boolean {
  return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** A canonical relative path is skipped when any of its segments is hidden or a skipped directory. */
const skipped = (relPath: string) =>
  relPath.split("/").some((s) => s.startsWith(".") || SKIP_DIRS.has(s.toLowerCase()));

/**
 * Lists indexable files under `root`. Symlinks below the root are never followed — whether they point inside
 * or outside it — and are only counted; the root itself may be a link (resolved once). Every entry is checked
 * with lstat, so a document is reached only by its real path: paths are canonical (relative to the resolved
 * root), each directory is visited once and each file returned once, whatever links exist or however names
 * sort, and a case-insensitive mount cannot give one file two names through a link.
 */
export function walkFiles(root: string): WalkResult {
  const realRoot = realpathSync(root);
  const result: WalkResult = { files: [], links: 0 };
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
      // `dir` is a real directory and `name` is not a link (checked below), so this path is already canonical.
      const real = join(dir, name);
      let st;
      try {
        st = lstatSync(real);
      } catch {
        continue; // vanished entry
      }
      if (st.isSymbolicLink()) {
        result.links += 1;
        continue;
      }
      if (!isUnder(realRoot, real)) continue; // defensive; cannot happen without following a link
      const relPath = relative(realRoot, real).split(sep).join("/");
      if (relPath === "" || skipped(relPath)) continue;
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
