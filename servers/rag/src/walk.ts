import { readdirSync, realpathSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";

const SKIP_DIRS = new Set(["node_modules", "$recycle.bin", "system volume information"]);
export const MAX_FILE_BYTES = 40 * 1024 * 1024;

export interface WalkedFile {
  /** Resolved path (no symlinks), always under the resolved root. */
  realPath: string;
  /** Path relative to the docs root, "/"-separated, as the member sees and scopes it. */
  relPath: string;
  bytes: number;
  ext: string;
}

export interface WalkResult {
  files: WalkedFile[];
  /** Entries skipped because they resolve outside the root (symlinks). */
  outside: number;
}

/** True when `real` is `root` or inside it. Both must already be resolved with realpath. */
export function isUnder(root: string, real: string): boolean {
  return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Lists indexable files under `root`. Every entry is resolved with realpath and must stay under the resolved
 * root, so a symlink pointing outside the docs directory is never followed. Hidden entries are skipped and
 * each real directory is visited once (no symlink loops).
 */
export function walkFiles(root: string): WalkResult {
  const realRoot = realpathSync(root);
  const result: WalkResult = { files: [], outside: 0 };
  const visited = new Set<string>([realRoot]);
  const visit = (dir: string, relDir: string) => {
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
      const relPath = relDir ? `${relDir}/${name}` : name;
      let st;
      try {
        st = statSync(real);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name.toLowerCase()) || visited.has(real)) continue;
        visited.add(real);
        visit(real, relPath);
      } else if (st.isFile() && st.size > 0 && st.size <= MAX_FILE_BYTES) {
        result.files.push({ realPath: real, relPath, bytes: st.size, ext: extname(name).toLowerCase() });
      }
    }
  };
  visit(realRoot, "");
  return result;
}
