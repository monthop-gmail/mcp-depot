// Scope isolation (ADR 0002): a member of one host group must not learn anything about another group,
// through any tool. Required for every server that declares scope_keys (npm run check).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startTestServer, type TestServer } from "@mcp-depot/core/testing";
import { fixtureDefinition } from "../src/definition.js";

const MEMBERS = `
members:
  "user:servers@example.com":  { roles: [viewer], scopes: { host_groups: ["Servers"] } }
  "user:switches@example.com": { roles: [viewer], scopes: { host_groups: ["Switches"] } }
`;

// What each member must never see (host names, visible names, group names from the fixture).
const FORBIDDEN: Record<string, string[]> = {
  "servers@example.com": ["sw-core-01", "Core switch 01", "cam-gate-01", "Gate camera 01", "Switches", "Cameras"],
  "switches@example.com": ["srv-app-01", "App server 01", "cam-gate-01", "Gate camera 01", "Servers", "Cameras"],
};

const ALL_HOSTS = ["srv-app-01", "srv-db-01", "sw-core-01", "cam-gate-01"];

describe("zabbix scope isolation", () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer(fixtureDefinition(), MEMBERS);
  });
  after(() => t.close());

  for (const [email, forbidden] of Object.entries(FORBIDDEN)) {
    it(`${email} sees nothing outside its host group, in every tool`, async () => {
      const outputs: string[] = [];
      outputs.push((await t.call(email, "get_active_problems")).text);
      outputs.push((await t.call(email, "get_device_status")).text);
      for (const group of ["Servers", "Switches", "Cameras"]) {
        outputs.push((await t.call(email, "get_device_status", { group_name: group })).text);
      }
      for (const host of ALL_HOSTS) {
        outputs.push((await t.call(email, "get_metrics", { host_name: host, item_keys: ["system.cpu.util"] })).text);
      }
      // Every tool in the manifest was exercised above.
      assert.deepEqual(await t.list(email), ["get_active_problems", "get_device_status", "get_metrics"]);
      const all = outputs.join("\n");
      for (const name of forbidden) {
        // Error messages may echo the name the caller typed; anything else must not contain it.
        const leaked = outputs.filter((o) => o.includes(name) && !o.startsWith("no permitted"));
        assert.deepEqual(leaked, [], `${email} learned '${name}'`);
      }
      assert.ok(all.length > 0);
    });
  }
});
