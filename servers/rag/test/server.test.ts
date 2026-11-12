import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ConfigError } from "@mcp-depot/core";
import { loadServer } from "@mcp-depot/core/internal";
import { startTestServer, type TestServer } from "@mcp-depot/core/testing";
import { RagCorpus, folderCondition, normalizePrefix } from "../src/corpus.js";
import { corpusFromEnv, definition, fixtureDefinition } from "../src/definition.js";

// Synthetic membership only.
const MEMBERS = `
members:
  "user:all@example.com":      { roles: [reader, indexer], scopes: { folders: ["*"] } }
  "user:reader@example.com":   { roles: [reader], scopes: { folders: ["*"] } }
  "user:indexer@example.com":  { roles: [indexer], scopes: { folders: ["*"] } }
  "user:it@example.com":       { roles: [reader], scopes: { folders: ["/คู่มือไอที/"] } }
  "user:dots@example.com":     { roles: [reader], scopes: { folders: ["hr/../คู่มือไอที"] } }
  "user:norole@example.com":   { roles: [other], scopes: { folders: ["*"] } }
  "user:noscope@example.com":  { roles: [reader, indexer] }
`;

const READ_TOOLS = ["get_chunk", "get_status", "list_sources", "search"];
const argsFor = (tool: string) => (tool === "search" ? { query: "sample" } : tool === "get_chunk" ? { chunk_id: 1 } : {});

describe("rag server (fixture mode)", () => {
  const manifest = loadServer(fixtureDefinition()).manifest;
  let t: TestServer;
  let off: TestServer;
  before(async () => {
    t = await startTestServer(fixtureDefinition(), MEMBERS, { enabledTools: ["reindex"] });
    off = await startTestServer(fixtureDefinition(), MEMBERS);
  });
  after(async () => {
    await t.close();
    await off.close();
  });

  it("tools/list equals the manifest when reindex is enabled; each role sees only its tools", async () => {
    assert.deepEqual(await t.list("all@example.com"), manifest.tools.map((x) => x.name).sort());
    assert.deepEqual(await t.list("reader@example.com"), READ_TOOLS);
    assert.deepEqual(await t.list("indexer@example.com"), ["get_status", "reindex"]);
  });

  it("does not offer reindex unless the deployment enables it", async () => {
    assert.equal(manifest.tools.find((x) => x.name === "reindex")?.default_enabled, false);
    assert.deepEqual(await off.list("all@example.com"), READ_TOOLS);
    assert.equal((await off.call("all@example.com", "reindex")).text, "denied: tool_disabled");
  });

  it("denies every tool to non-members, members without the role and members without the scope", async () => {
    const expected = { "stranger@example.com": "not_member", "norole@example.com": "role_missing", "noscope@example.com": "scope_missing" };
    for (const [email, reason] of Object.entries(expected)) {
      assert.deepEqual(await t.list(email), [], email);
      for (const tool of manifest.tools) {
        const r = await t.call(email, tool.name, argsFor(tool.name));
        assert.equal(r.isError, true, `${email} ${tool.name}`);
        assert.equal(r.text, `denied: ${reason}`, `${email} ${tool.name}`);
      }
    }
    assert.equal((await t.call("reader@example.com", "reindex")).text, "denied: role_missing");
    assert.equal((await t.call("indexer@example.com", "search", { query: "sample" })).text, "denied: role_missing");
  });

  it("finds Thai text, including words whose marks the PDF extractor detached", async () => {
    const thai = (await t.call("all@example.com", "search", { query: "สำรองข้อมูล" })).data as { hits: Array<{ path: string; chunk_id: number }> };
    assert.equal(thai.hits[0]?.path, "คู่มือไอที/การสำรองข้อมูล.md");
    const folded = (await t.call("all@example.com", "search", { query: "ครุภัณฑ์" })).data as { hits: Array<{ path: string }> };
    assert.deepEqual(folded.hits.map((h) => h.path), ["คู่มือไอที/การสำรองข้อมูล.md"]);
    const chunk = await t.call("all@example.com", "get_chunk", { chunk_id: thai.hits[0]!.chunk_id });
    assert.match(chunk.text, /ALPHA-7731/);
    const english = (await t.call("all@example.com", "search", { query: "line manager" })).data as { hits: Array<{ path: string }> };
    assert.deepEqual(english.hits.map((h) => h.path), ["hr/leave-policy.md"]);
  });

  it("normalises root-relative scope values and answers out-of-scope chunks like missing ones", async () => {
    const sources = (await t.call("it@example.com", "list_sources")).data as { sources: Array<{ path: string }> };
    assert.deepEqual(sources.sources.map((s) => s.path), ["คู่มือไอที/network/wifi-setup.txt", "คู่มือไอที/การสำรองข้อมูล.md"]);
    const hr = (await t.call("all@example.com", "search", { query: "BRAVO-4410" })).data as { hits: Array<{ chunk_id: number }> };
    const id = hr.hits[0]!.chunk_id;
    assert.equal((await t.call("it@example.com", "get_chunk", { chunk_id: id })).text, `chunk ${id} not found`);
    assert.equal((await t.call("it@example.com", "get_chunk", { chunk_id: 99999 })).text, "chunk 99999 not found");
  });

  it("rejects '..' and absolute paths in path_prefix and in scopes", async () => {
    for (const bad of ["../etc", "/etc", "C:/Windows", "hr/../คู่มือไอที", "./hr", "\\\\server\\share", "//x"]) {
      for (const tool of ["list_sources", "search"]) {
        const r = await t.call("all@example.com", tool, { ...argsFor(tool), path_prefix: bad });
        assert.equal(r.isError, true, `${tool} ${bad}`);
        assert.match(r.text, /^invalid path_prefix/, `${tool} ${bad}`);
      }
    }
    const r = await t.call("dots@example.com", "list_sources");
    assert.equal(r.isError, true);
    assert.match(r.text, /^invalid folders scope/);
    assert.throws(() => normalizePrefix("/", "x", true));
    assert.equal(normalizePrefix("a//b/", "x"), "a/b");
  });

  it("binds folder prefixes as parameters with LIKE wildcards escaped", () => {
    const c = folderCondition(["50%", "ops_team", "a\\b"]);
    assert.doesNotMatch(c.sql, /50|ops|team/);
    assert.deepEqual(c.params.slice(0, 6), ["50%", "50\\%/%", "50%/", "ops_team", "ops\\_team/%", "ops_team/"]);
  });

  it("reindex rebuilds the whole corpus and reports totals only", async () => {
    const r = await t.call("indexer@example.com", "reindex");
    const data = r.data as Record<string, unknown>;
    assert.equal(data.file_count, 9);
    assert.equal(data.outside_root_count, 0);
    assert.doesNotMatch(r.text, /\.md|\.txt/);
  });
});

describe("rag files mode: the document root is a hard boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "rag-files-test-"));
  const docs = join(root, "docs");
  const outside = join(root, "outside");
  let t: TestServer;
  before(async () => {
    mkdirSync(join(docs, "manuals"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(docs, "manuals", "inside.md"), "Inside document INSIDE-1001 (synthetic).\n");
    writeFileSync(join(outside, "secret.md"), "Outside document OUTSIDE-9009 (synthetic); must never be indexed.\n");
    symlinkSync(join(outside, "secret.md"), join(docs, "manuals", "link-to-file.md"));
    symlinkSync(outside, join(docs, "link-to-dir"));
    symlinkSync(join(docs, "manuals", "inside.md"), join(docs, "manuals", "alias.md")); // inside the root: indexed once, under its real path
    const corpus = new RagCorpus({ mode: "files", docsDir: docs, indexPath: join(root, "index", "index.sqlite") });
    t = await startTestServer(definition(corpus), `
members:
  "user:all@example.com": { roles: [reader, indexer], scopes: { folders: ["*"] } }
`, { enabledTools: ["reindex"] });
  });
  after(async () => {
    await t.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("does not index symlinks that lead outside the root", async () => {
    const r = (await t.call("all@example.com", "reindex")).data as { file_count: number; outside_root_count: number };
    assert.equal(r.outside_root_count, 2);
    const sources = (await t.call("all@example.com", "list_sources")).data as { sources: Array<{ path: string }> };
    assert.deepEqual(sources.sources.map((s) => s.path), ["manuals/inside.md"]);
    const hits = (await t.call("all@example.com", "search", { query: "OUTSIDE-9009" })).data as { count: number };
    assert.equal(hits.count, 0);
  });
});

describe("rag configuration", () => {
  it("refuses to start when misconfigured", () => {
    assert.throws(() => corpusFromEnv({}), ConfigError);
    assert.throws(() => corpusFromEnv({ RAG_MODE: "magic" }), ConfigError);
    assert.throws(() => corpusFromEnv({ RAG_MODE: "files", RAG_DOCS_DIR: "/no/such/dir" }), ConfigError);
    assert.throws(() => corpusFromEnv({ RAG_MODE: "files", RAG_DOCS_DIR: tmpdir(), RAG_INDEX_PATH: join(tmpdir(), "x.sqlite") }), ConfigError);
    assert.throws(() => corpusFromEnv({ RAG_MODE: "files", RAG_DOCS_DIR: tmpdir(), RAG_INDEX_PATH: "relative.sqlite" }), ConfigError);
    assert.ok(corpusFromEnv({ RAG_MODE: "files", RAG_DOCS_DIR: tmpdir(), RAG_INDEX_PATH: "/var/lib/rag/index.sqlite" }) instanceof RagCorpus);
    assert.ok(corpusFromEnv({ RAG_MODE: "fixture" }) instanceof RagCorpus);
  });
});
