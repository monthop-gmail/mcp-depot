// Scope isolation (ADR 0002): a member of one folder must not learn the names or contents of documents in
// another folder, through any tool or argument. Required for every server that declares scope_keys (npm run check).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startTestServer, type TestServer } from "@mcp-depot/core/testing";
import { fixtureDefinition } from "../src/definition.js";
import { FIXTURE_DOCS } from "../src/fixture.js";

const MEMBERS = `
members:
  "user:it@example.com":  { roles: [reader, indexer], scopes: { folders: ["คู่มือไอที"] } }
  "user:hr@example.com":  { roles: [reader, indexer], scopes: { folders: ["hr"] } }
  "user:ops@example.com": { roles: [reader, indexer], scopes: { folders: ["ops_team"] } }
  "user:pct@example.com": { roles: [reader, indexer], scopes: { folders: ["50%"] } }
`;

const OWN: Record<string, string> = {
  "it@example.com": "คู่มือไอที",
  "hr@example.com": "hr",
  "ops@example.com": "ops_team",
  "pct@example.com": "50%",
};

const PATHS = Object.keys(FIXTURE_DOCS);
const FOLDERS = [...new Set(PATHS.map((p) => p.split("/")[0]!))];
const codeOf = (path: string) => /[A-Z]+-\d{4}/.exec(FIXTURE_DOCS[path]!)![0];
const inFolder = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

describe("rag scope isolation", () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer(fixtureDefinition(), MEMBERS, { enabledTools: ["reindex"] });
  });
  after(() => t.close());

  for (const [email, own] of Object.entries(OWN)) {
    it(`${email} sees nothing outside '${own}', in every tool`, async () => {
      // What the member could observe. Search output echoes the query, so only its hits count.
      const seen: string[] = [];
      const run = async (tool: string, args: Record<string, unknown> = {}) => {
        const r = await t.call(email, tool, args);
        const data = r.data as { hits?: unknown } | null;
        seen.push(tool === "search" && data ? JSON.stringify(data.hits) : r.text);
        return r;
      };

      await run("get_status");
      await run("reindex");
      await run("list_sources");
      for (const folder of FOLDERS) await run("list_sources", { path_prefix: folder });
      for (const path of PATHS) {
        await run("search", { query: codeOf(path) });
        await run("search", { query: path.split("/").pop()!.replace(/\.[^.]+$/, "") });
        await run("search", { query: codeOf(path), path_prefix: path.split("/")[0]! });
      }
      for (const word of ["สำรองข้อมูล", "ครุภัณฑ์", "การลาพักร้อน", "synthetic", "Plan", "folder", "%", "_"]) {
        await run("search", { query: word.length < 2 ? `${word}${word}` : word });
      }
      for (let id = 1; id <= 40; id += 1) await run("get_chunk", { chunk_id: id });

      // Every tool in the manifest was exercised above.
      assert.deepEqual(await t.list(email), ["get_chunk", "get_status", "list_sources", "reindex", "search"]);

      const all = seen.join("\n");
      for (const path of PATHS) {
        const mine = inFolder(path, own);
        assert.equal(all.includes(codeOf(path)), mine, `${email}: content of ${path} ${mine ? "missing" : "leaked"}`);
        assert.equal(all.includes(JSON.stringify(path).slice(1, -1)), mine, `${email}: name of ${path} ${mine ? "missing" : "leaked"}`);
      }
    });
  }
});
