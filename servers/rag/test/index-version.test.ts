// An index written by another INDEX_VERSION (older path rules, chunking…) must be dropped and rebuilt on first
// use, not served; an index of the current version must not be rebuilt.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import Database from "better-sqlite3";
import { INDEX_VERSION, RagCorpus } from "../src/corpus.js";

describe("rag index version", () => {
  const root = mkdtempSync(join(tmpdir(), "rag-index-version-test-"));
  const docs = join(root, "docs");
  const indexPath = join(root, "index", "index.sqlite");
  mkdirSync(join(docs, "hr"), { recursive: true });
  writeFileSync(join(docs, "hr", "pay.md"), "Pay notes MIKE-7701 (synthetic).\n");
  const corpus = () => new RagCorpus({ mode: "files", docsDir: docs, indexPath });
  const paths = async (c: RagCorpus) => (await c.listSources(undefined, undefined, 100)).map((s) => s.path);
  const meta = (db: Database.Database, k: string) => (db.prepare("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | undefined)?.v;
  const insertStale = (db: Database.Database) =>
    db.prepare("INSERT INTO chunks(path, title, page, text) VALUES ('hr/stale.md', 'stale', NULL, 'stale row')").run();
  after(() => rmSync(root, { recursive: true, force: true }));

  it("rebuilds an index written by another version, and keeps a current one", async () => {
    assert.deepEqual(await paths(corpus()), ["hr/pay.md"]);
    const db = new Database(indexPath);
    try {
      assert.equal(meta(db, "index_version"), String(INDEX_VERSION));

      // Pretend the index was written by version 1 and holds a row the current rules would not produce.
      db.prepare("UPDATE meta SET v = '1' WHERE k = 'index_version'").run();
      insertStale(db);
      const before = meta(db, "indexed_at");
      await new Promise((r) => setTimeout(r, 5)); // so a rebuild gets a different indexed_at

      assert.deepEqual(await paths(corpus()), ["hr/pay.md"], "stale row dropped by the rebuild");
      assert.equal(meta(db, "index_version"), String(INDEX_VERSION));
      const rebuilt = meta(db, "indexed_at");
      assert.notEqual(rebuilt, before);

      // Same version: no rebuild, so even a stray row stays and indexed_at is unchanged.
      insertStale(db);
      assert.deepEqual(await paths(corpus()), ["hr/pay.md", "hr/stale.md"]);
      assert.equal(meta(db, "indexed_at"), rebuilt);
    } finally {
      db.close();
    }
  });
});
