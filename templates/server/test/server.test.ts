import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { loadServer } from "@mcp-depot/core/internal";
import { startTestServer, type TestServer } from "@mcp-depot/core/testing";
import { fixtureDefinition } from "../src/definition.js";

// Synthetic membership only. Add scopes here when roles.yaml declares scope_keys.
const MEMBERS = `
members:
  "user:alice@example.com": { roles: [viewer] }
`;

describe("__NAME__ server", () => {
  const manifest = loadServer(fixtureDefinition()).manifest;
  let t: TestServer;
  before(async () => {
    t = await startTestServer(fixtureDefinition(), MEMBERS);
  });
  after(() => t.close());

  it("tools/list equals the manifest's enabled tools for a member", async () => {
    const expected = manifest.tools.filter((x) => x.default_enabled !== false).map((x) => x.name).sort();
    assert.deepEqual(await t.list("alice@example.com"), expected);
  });

  it("denies every tool to a non-member", async () => {
    for (const tool of manifest.tools) {
      assert.equal((await t.call("stranger@example.com", tool.name)).isError, true, tool.name);
    }
  });
});
