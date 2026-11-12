// Symlinks inside the document root must not change which folder a document belongs to (folder scopes are
// decided on the path), and one real file must be indexed once.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { startTestServer, type TestServer } from "@mcp-depot/core/testing";
import { RagCorpus } from "../src/corpus.js";
import { definition } from "../src/definition.js";
import { walkFiles } from "../src/walk.js";

const CODE = "KILO-9901";

/** hr/pay.md · public/ · a-link -> hr (sorts before hr) · public/copy.md -> ../hr/pay.md */
function makeTree(withLinks: boolean): { root: string; docs: string } {
  const root = mkdtempSync(join(tmpdir(), "rag-walk-test-"));
  const docs = join(root, "docs");
  mkdirSync(join(docs, "hr"), { recursive: true });
  mkdirSync(join(docs, "public"), { recursive: true });
  writeFileSync(join(docs, "hr", "pay.md"), `Pay notes ${CODE} (synthetic).\n`);
  writeFileSync(join(docs, "public", "notice.md"), "Public notice LIMA-1201 (synthetic).\n");
  if (withLinks) {
    symlinkSync("hr", join(docs, "a-link"));
    symlinkSync("../hr/pay.md", join(docs, "public", "copy.md"));
  }
  return { root, docs };
}

describe("walkFiles uses canonical paths", () => {
  const roots: string[] = [];
  after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

  it("returns each real file once under its real path, whatever links exist", () => {
    const linked = makeTree(true);
    const plain = makeTree(false);
    roots.push(linked.root, plain.root);
    const paths = walkFiles(linked.docs).files.map((f) => f.relPath);
    assert.deepEqual(paths, ["hr/pay.md", "public/notice.md"]);
    assert.equal(paths.filter((p) => p === "hr/pay.md").length, 1);
    assert.ok(!paths.some((p) => p.startsWith("a-link/") || p === "public/copy.md"), paths.join(", "));
    assert.deepEqual(paths, walkFiles(plain.docs).files.map((f) => f.relPath), "same result with or without links");
    assert.equal(walkFiles(linked.docs).links, 2, "both links (folder and file) are skipped and counted");
    assert.equal(walkFiles(plain.docs).links, 0);
  });
});

describe("folder scopes follow the real path, not the link name", () => {
  const { root, docs } = makeTree(true);
  let t: TestServer;
  before(async () => {
    const corpus = new RagCorpus({ mode: "files", docsDir: docs, indexPath: ":memory:" });
    t = await startTestServer(definition(corpus), `
members:
  "user:public@example.com": { roles: [reader], scopes: { folders: ["public"] } }
  "user:alink@example.com":  { roles: [reader], scopes: { folders: ["a-link"] } }
  "user:hr@example.com":     { roles: [reader], scopes: { folders: ["hr"] } }
`);
  });
  after(async () => {
    await t.close();
    rmSync(root, { recursive: true, force: true });
  });

  const hits = async (email: string) => {
    const r = await t.call(email, "search", { query: CODE });
    assert.equal(r.isError, false, r.text);
    return (r.data as { hits: Array<{ path: string }> }).hits.map((h) => h.path);
  };

  it("a link into hr does not show hr's document to other scopes", async () => {
    assert.deepEqual(await hits("public@example.com"), []);
    assert.deepEqual(await hits("alink@example.com"), []);
    const sources = (await t.call("public@example.com", "list_sources")).data as { sources: Array<{ path: string }> };
    assert.deepEqual(sources.sources.map((s) => s.path), ["public/notice.md"]);
  });

  it("the hr member still finds its own document, exactly once", async () => {
    assert.deepEqual(await hits("hr@example.com"), ["hr/pay.md"]);
  });

  it("get_status names scope prefixes that match no document, such as a link's name", async () => {
    const unmatched = async (email: string) =>
      ((await t.call(email, "get_status")).data as { unmatched_folders: string[] }).unmatched_folders;
    assert.deepEqual(await unmatched("alink@example.com"), ["a-link"]);
    assert.deepEqual(await unmatched("hr@example.com"), []);
    assert.deepEqual(await unmatched("public@example.com"), []);
  });
});
