import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { AuditLog, StaticMembership, createHttpServer, loadServer } from "@mcp-depot/core";
import { createTestIdentity, rpc, TEST_HOST } from "@mcp-depot/core/testing";
import { fixtureDefinition } from "../src/definition.js";

// Synthetic membership only. Add scopes here when roles.yaml declares scope_keys.
const MEMBERS = `
members:
  "user:alice@example.com": { roles: [viewer] }
`;

describe("__NAME__ server", () => {
  const loaded = loadServer(fixtureDefinition());
  const id = createTestIdentity();
  const server = createHttpServer(loaded, {
    port: 0,
    deployment: "test-__NAME__",
    allowedHosts: new Set([TEST_HOST]),
    identity: id.provider,
    membership: new StaticMembership(MEMBERS),
    audit: new AuditLog(() => {}),
    enabledTools: [],
    bodyLimitBytes: 64 * 1024,
  });
  const as = (email: string) => ({ "cf-access-jwt-assertion": id.sign({ email }) });

  before(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)));
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("tools/list equals the manifest's enabled tools for a member", async () => {
    const r = await rpc(server, "tools/list", {}, as("alice@example.com"));
    const names = (r.json as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name).sort();
    const expected = loaded.manifest.tools.filter((t) => t.default_enabled !== false).map((t) => t.name).sort();
    assert.deepEqual(names, expected);
  });

  it("denies every tool to a non-member", async () => {
    for (const tool of loaded.manifest.tools) {
      const r = await rpc(server, "tools/call", { name: tool.name, arguments: {} }, as("stranger@example.com"));
      assert.equal((r.json as { result: { isError: boolean } }).result.isError, true, tool.name);
    }
  });
});
