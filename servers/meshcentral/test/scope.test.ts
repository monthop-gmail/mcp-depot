// Scope isolation (ADR 0002): a member of one device group must not learn anything about another group,
// through any tool or argument. Required for every server that declares scope_keys (npm run check).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startTestServer, type TestServer } from "@mcp-depot/core/testing";
import { definition } from "../src/definition.js";
import { FIXTURE_GROUPS, FIXTURE_NODES, FixtureMesh } from "../src/fixture.js";
import { NOT_FOUND } from "../src/tools.js";

const OFFICE = "mesh//fixture-office";
const LAB = "mesh//fixture-lab";
const KIOSK = "mesh//fixture-kiosk";

const MEMBERS = `
members:
  "user:office@example.com": { roles: [viewer], scopes: { device_groups: ["${OFFICE}"] } }
  "user:lab@example.com":    { roles: [viewer], scopes: { device_groups: ["${LAB}", "not-a-mesh-id"] } }
  "user:all@example.com":    { roles: [viewer], scopes: { device_groups: ["*"] } }
`;

/** Every name, id and address that belongs to a group. */
const identifiers = (group: string) => [
  group,
  FIXTURE_GROUPS.find((g) => g._id === group)!.name,
  ...FIXTURE_NODES[group]!.flatMap((n) => [String(n._id), String(n.name), String(n.ip)]),
];

describe("meshcentral scope isolation", () => {
  const fixture = new FixtureMesh();
  let t: TestServer;
  before(async () => {
    t = await startTestServer(definition(fixture), MEMBERS);
  });
  after(() => t.close());

  for (const [email, own] of [["office@example.com", OFFICE], ["lab@example.com", LAB]] as const) {
    it(`${email} sees nothing outside ${own}, in every tool`, async () => {
      const outputs: string[] = [];
      outputs.push((await t.call(email, "list_groups")).text);
      outputs.push((await t.call(email, "get_inventory")).text);
      outputs.push((await t.call(email, "get_inventory", { online_only: true, limit: 500 })).text);
      for (const g of [OFFICE, LAB, KIOSK, "mesh//no-such-group"]) {
        const r = await t.call(email, "get_inventory", { group_id: g });
        if (g !== own) {
          assert.equal(r.isError, true, g);
          assert.equal(r.text, NOT_FOUND, `${g}: same answer as a group that does not exist`);
        }
        outputs.push(r.text);
      }
      assert.deepEqual(await t.list(email), ["get_inventory", "list_groups"]);
      const all = outputs.join("\n");
      for (const other of [OFFICE, LAB, KIOSK].filter((g) => g !== own)) {
        for (const word of identifiers(other)) assert.equal(all.includes(word), false, `${email} learned '${word}'`);
      }
      for (const word of identifiers(own)) assert.ok(all.includes(word), `${email} should see '${word}'`);
    });
  }

  it("asks MeshCentral only for the member's own groups, by meshid", async () => {
    fixture.calls.length = 0;
    await t.call("lab@example.com", "get_inventory");
    await t.call("lab@example.com", "list_groups");
    const nodeCalls = fixture.calls.filter((c) => c.action === "nodes");
    assert.ok(nodeCalls.length > 0);
    for (const c of nodeCalls) assert.equal(c.meshid, LAB, "every nodes request carries the permitted meshid");
  });

  it('["*"] sees every group with one unfiltered request', async () => {
    fixture.calls.length = 0;
    const groups = (await t.call("all@example.com", "list_groups")).data as { groups: Array<{ id: string; device_count: number }> };
    assert.deepEqual(groups.groups.map((g) => [g.id, g.device_count]), [[OFFICE, 3], [LAB, 2], [KIOSK, 2]]);
    assert.deepEqual(fixture.calls, [{ action: "meshes" }, { action: "nodes" }]);
    const inv = (await t.call("all@example.com", "get_inventory")).data as { count: number };
    assert.equal(inv.count, 7);
  });
});
