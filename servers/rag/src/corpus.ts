import { mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { ToolError, log } from "@mcp-depot/core";
import { chunkText, titleFromPath } from "./chunk.js";
import { extractFile, supportedExt } from "./extract.js";
import { escapeLike, prepareSearch } from "./fts-query.js";
import { excerptAround } from "./ngram.js";
import { ftsIndexText, normalizeThaiPdf } from "./thai-normalize.js";
import type { Chunk, Folders, Hit, RagMode, ReindexResult, Source, Status } from "./types.js";
import { walkFiles } from "./walk.js";

/**
 * Version of what the index stores (paths, chunking, normalisation). Bump it when that changes: an index built
 * with another version is dropped and rebuilt on first use. 2 = canonical paths, symlinks never followed.
 */
export const INDEX_VERSION = 2;

const DDL = `
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL,
    title TEXT NOT NULL,
    page INTEGER,
    text TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    path, title, text, content='chunks', content_rowid='id', tokenize='trigram'
  );
`;

/**
 * Normalises a folder prefix to "a/b" form: "\" → "/", empty segments and trailing "/" dropped.
 * Rejects "." and ".." segments and Windows drive or UNC forms. A leading "/" is an absolute path and is
 * rejected unless `rootRelative` (scope values written by site admins, where "/hr" means "hr" under the docs root).
 */
export function normalizePrefix(raw: string, what: string, rootRelative = false): string {
  let p = raw.trim().replaceAll("\\", "/");
  const bad = (why: string) => new ToolError(`invalid ${what} '${raw}': ${why}`);
  if (/^[A-Za-z]:/.test(p) || p.startsWith("//")) throw bad("absolute paths are not allowed");
  if (p.startsWith("/")) {
    if (!rootRelative) throw bad("absolute paths are not allowed; use a path relative to the document root");
    p = p.replace(/^\/+/, "");
  }
  if (p.includes("\0")) throw bad("contains NUL");
  const parts = p.split("/").filter((s) => s !== "");
  if (parts.some((s) => s === "." || s === "..")) throw bad("'.' and '..' are not allowed");
  if (parts.length === 0) throw bad("empty");
  return parts.join("/");
}

/**
 * SQL condition limiting `column` to the given folder prefixes, with every value bound as a parameter
 * (ADR 0002 rule 3). Per prefix: the path equals it, or starts with "<prefix>/".
 * `LIKE` (wildcards in the prefix escaped) can use the path index; SQLite's LIKE ignores ASCII case, so
 * `instr(...) = 1` adds the exact, case-sensitive check — "hr" must not match "HR/…".
 */
export function folderCondition(folders: string[], column = "c.path"): { sql: string; params: string[] } {
  if (folders.length === 0) return { sql: "0", params: [] };
  return {
    sql: `(${folders.map(() => `${column} = ? OR (${column} LIKE ? ESCAPE '\\' AND instr(${column}, ?) = 1)`).join(" OR ")})`,
    params: folders.flatMap((f) => [f, `${escapeLike(f)}/%`, `${f}/`]),
  };
}

/** Scope (`undefined` = all) AND the optional path_prefix argument, as one bound condition. */
function where(folders: Folders, prefix?: string): { sql: string; params: string[] } {
  const parts = [folders ? folderCondition(folders) : { sql: "1", params: [] }];
  if (prefix !== undefined) parts.push(folderCondition([prefix]));
  return { sql: parts.map((p) => p.sql).join(" AND "), params: parts.flatMap((p) => p.params) };
}

type ChunkRow = { id: number; path: string; title: string; page: number | null; text: string; rank: number };

export interface CorpusOptions {
  mode: RagMode;
  docsDir: string;
  /** SQLite file on a writable volume, or ":memory:". */
  indexPath: string;
  /** Called once before the first index build (the fixture writes its documents here). */
  prepare?: () => void;
}

/**
 * The document index: SQLite FTS5 with the trigram tokenizer (Thai has no spaces between words).
 * Documents are read only from `docsDir`; the index lives elsewhere. Readers wait while a build runs.
 */
export class RagCorpus {
  readonly mode: RagMode;
  private db?: Database.Database;
  private building?: Promise<ReindexResult>;
  private prepared = false;

  constructor(private readonly options: CorpusOptions) {
    this.mode = options.mode;
  }

  private open(): Database.Database {
    if (this.db) return this.db;
    if (this.options.indexPath !== ":memory:") mkdirSync(dirname(this.options.indexPath), { recursive: true });
    const db = new Database(this.options.indexPath);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.exec(DDL);
    this.db = db;
    return db;
  }

  private meta(key: string): string | null {
    const row = this.open().prepare("SELECT v FROM meta WHERE k = ?").get(key) as { v: string } | undefined;
    return row?.v ?? null;
  }

  private indexedAt(): string | null {
    return this.meta("indexed_at");
  }

  /**
   * Waits for a running build, and builds if the index has never been built or was built by another
   * INDEX_VERSION (then its tables are dropped and recreated first). Callers wait meanwhile.
   */
  private async ready(): Promise<Database.Database> {
    if (this.building) await this.building.catch(() => undefined);
    const current = this.meta("index_version") === String(INDEX_VERSION);
    if (this.indexedAt() === null || !current) {
      this.building ??= this.build(!current).finally(() => (this.building = undefined));
      await this.building;
    }
    return this.open();
  }

  /** Starts the first build in the background if needed; errors are logged and retried on the next call. */
  warmUp(): void {
    this.ready().catch((error: unknown) => log("error", "initial index failed", { err: String(error) }));
  }

  /** Rebuilds the whole corpus. One build at a time. */
  async reindex(): Promise<ReindexResult> {
    if (this.building) throw new ToolError("a reindex is already running");
    this.building = this.build().finally(() => (this.building = undefined));
    return this.building;
  }

  /** `resetSchema` drops and recreates the index tables (inside the transaction, so a failed build keeps the old index). */
  private async build(resetSchema = false): Promise<ReindexResult> {
    const started = Date.now();
    if (!this.prepared) {
      this.options.prepare?.();
      this.prepared = true;
    }
    const db = this.open();
    const { files, links } = walkFiles(this.options.docsDir);
    let skipped = 0;
    let indexedFiles = 0;
    let chunks = 0;
    // Readers wait for this build (ready()), so the transaction can stay open across awaits.
    db.exec("BEGIN");
    try {
      if (resetSchema) db.exec(`DROP TABLE IF EXISTS chunks_fts; DROP TABLE IF EXISTS chunks; ${DDL}`);
      else db.exec("DELETE FROM chunks; INSERT INTO chunks_fts(chunks_fts) VALUES('delete-all');");
      // Prepared after a possible reset, so they bind to the recreated tables.
      const insertChunk = db.prepare("INSERT INTO chunks(path, title, page, text) VALUES (?, ?, ?, ?)");
      const insertFts = db.prepare("INSERT INTO chunks_fts(rowid, path, title, text) VALUES (?, ?, ?, ?)");
      for (const file of files) {
        // Re-resolve right before reading: the file must still be the same real path under the root.
        let still = false;
        try {
          still = realpathSync(file.realPath) === file.realPath;
        } catch {
          // vanished
        }
        if (!still || supportedExt(file.relPath) === "skip") {
          skipped += 1;
          continue;
        }
        const extracted = await extractFile(file.realPath);
        if (!extracted.ok) {
          skipped += 1;
          continue;
        }
        const title = titleFromPath(file.relPath);
        const pieces = chunkText(extracted.text);
        for (const piece of pieces) {
          const text = normalizeThaiPdf(piece.text);
          const id = Number(insertChunk.run(file.relPath, title, piece.page, text).lastInsertRowid);
          insertFts.run(id, file.relPath, title, ftsIndexText(text));
        }
        if (pieces.length > 0) indexedFiles += 1;
        chunks += pieces.length;
      }
      const at = new Date().toISOString();
      db.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES ('indexed_at', ?)").run(at);
      db.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES ('index_version', ?)").run(String(INDEX_VERSION));
      db.exec("COMMIT");
      const result = { indexed_at: at, file_count: indexedFiles, chunk_count: chunks, skipped_count: skipped, link_count: links, duration_ms: Date.now() - started };
      log("info", "index built", { ...result });
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async status(folders: Folders): Promise<Status> {
    const db = await this.ready();
    const w = where(folders);
    const row = db.prepare(`SELECT COUNT(DISTINCT c.path) AS files, COUNT(*) AS chunks FROM chunks c WHERE ${w.sql}`).get(...w.params) as {
      files: number;
      chunks: number;
    };
    // Scope prefixes with no document at all: usually a typo in members.yaml or a folder that is not indexed.
    const unmatched = (folders ?? []).filter((f) => {
      const c = folderCondition([f]);
      return db.prepare(`SELECT 1 FROM chunks c WHERE ${c.sql} LIMIT 1`).get(...c.params) === undefined;
    });
    return {
      mode: this.mode,
      sample: this.mode === "fixture",
      indexed_at: this.indexedAt(),
      file_count: row.files,
      chunk_count: row.chunks,
      unmatched_folders: unmatched,
    };
  }

  async listSources(folders: Folders, prefix: string | undefined, limit: number): Promise<Source[]> {
    const db = await this.ready();
    const w = where(folders, prefix);
    const rows = db
      .prepare(
        `SELECT c.path, c.title, COUNT(*) AS chunk_count, SUM(LENGTH(c.text)) AS chars FROM chunks c
         WHERE ${w.sql} GROUP BY c.path, c.title ORDER BY c.path LIMIT ?`,
      )
      .all(...w.params, limit) as Array<{ path: string; title: string; chunk_count: number; chars: number }>;
    return rows.map((r) => ({
      path: r.path,
      title: r.title,
      ext: /\.[^./]+$/.exec(r.path)?.[0].toLowerCase() ?? "",
      chars: Number(r.chars) || 0,
      chunk_count: Number(r.chunk_count) || 0,
    }));
  }

  async search(folders: Folders, query: string, prefix: string | undefined, limit: number): Promise<Hit[]> {
    const db = await this.ready();
    const prepared = prepareSearch(query);
    const w = where(folders, prefix);
    const likeSql = (likes: string[]) => likes.map(() => " AND c.text LIKE ? ESCAPE '\\'").join("");
    const viaLike = (likes: string[]) =>
      likes.length === 0
        ? []
        : (db
            .prepare(`SELECT c.id, c.path, c.title, c.page, c.text, 0 AS rank FROM chunks c WHERE ${w.sql}${likeSql(likes)} ORDER BY c.path LIMIT ?`)
            .all(...w.params, ...likes, limit) as ChunkRow[]);
    let rows: ChunkRow[];
    if (!prepared.match) {
      rows = viaLike(prepared.likes);
    } else {
      try {
        rows = db
          .prepare(
            `SELECT c.id, c.path, c.title, c.page, c.text, bm25(chunks_fts) AS rank
             FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
             WHERE chunks_fts MATCH ? AND ${w.sql}${likeSql(prepared.likes)}
             ORDER BY rank, c.path LIMIT ?`,
          )
          .all(prepared.match, ...w.params, ...prepared.likes, limit) as ChunkRow[];
        if (rows.length === 0 && prepared.likes.length > 0) rows = viaLike(prepared.likes);
      } catch (error) {
        log("warn", "FTS5 MATCH failed; falling back to LIKE", { err: error instanceof Error ? error.message : String(error) });
        rows = viaLike(prepared.likes.length > 0 ? prepared.likes : [`%${escapeLike(query.trim())}%`]);
      }
    }
    return rows.map((r) => ({
      chunk_id: r.id,
      path: r.path,
      title: r.title,
      page: r.page,
      score: Number.isFinite(Number(r.rank)) ? -Number(r.rank) : 0,
      excerpt: excerptAround(r.text, query),
    }));
  }

  /** A chunk outside the member's folders is indistinguishable from one that does not exist. */
  async getChunk(folders: Folders, id: number): Promise<Chunk | null> {
    const db = await this.ready();
    const w = where(folders);
    const row = db.prepare(`SELECT c.id, c.path, c.title, c.page, c.text FROM chunks c WHERE c.id = ? AND ${w.sql}`).get(id, ...w.params) as
      | Chunk
      | undefined;
    return row ?? null;
  }
}
