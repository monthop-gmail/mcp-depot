// Scope isolation (ADR 0002): a member of one department must not learn anything about another department's
// people, through any tool or argument. Required for every server that declares scope_keys (npm run check).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startTestServer, type TestServer } from "@mcp-depot/core/testing";
import { fixtureDefinition } from "../src/definition.js";

const MEMBERS = `
members:
  "user:workshop@example.com":  { roles: [viewer, diagnostics], scopes: { departments: ["Workshop"] } }
  "user:warehouse@example.com": { roles: [viewer, diagnostics], scopes: { departments: ["Warehouse"] } }
`;

// Fixture people: user_id, badge, name, department.
const PEOPLE = [
  { id: 1, badge: "1001", name: "Sample Person A", department: "Head Office" },
  { id: 2, badge: "1002", name: "Sample Person B", department: "Workshop" },
  { id: 3, badge: "1003", name: "Sample Person C", department: "Workshop" },
  { id: 4, badge: "1004", name: "Sample Person D", department: "Warehouse" },
];
const DEPARTMENTS = ["Head Office", "Workshop", "Warehouse"];
const OWN: Record<string, string> = { "workshop@example.com": "Workshop", "warehouse@example.com": "Warehouse" };
const RANGE = { from: "2026-11-01", to: "2026-11-30" };

describe("zktime scope isolation", () => {
  let t: TestServer;
  before(async () => {
    t = await startTestServer(fixtureDefinition(), MEMBERS);
  });
  after(() => t.close());

  for (const [email, own] of Object.entries(OWN)) {
    it(`${email} sees nothing outside ${own}, in every tool`, async () => {
      const outputs: Array<{ tool: string; text: string; data: unknown }> = [];
      const run = async (tool: string, args: Record<string, unknown> = {}) => {
        const r = await t.call(email, tool, args);
        assert.equal(r.isError, false, `${tool} ${JSON.stringify(args)}: ${r.text}`);
        outputs.push({ tool, text: r.text, data: r.data });
      };

      await run("get_status");
      await run("inspect_schema");
      await run("list_devices");
      await run("list_departments");
      for (const name of DEPARTMENTS) await run("list_departments", { query: name });
      await run("list_employees");
      for (const p of PEOPLE) {
        await run("list_employees", { query: p.name });
        await run("list_employees", { query: p.badge });
        await run("list_punches", { ...RANGE, user_id: p.id });
      }
      await run("list_punches", RANGE);
      for (const check_type of ["in", "out", "all"]) await run("list_punches", { ...RANGE, check_type, limit: 500 });

      // Every tool in the manifest was exercised above.
      assert.deepEqual(await t.list(email), [
        "get_status", "inspect_schema", "list_departments", "list_devices", "list_employees", "list_punches",
      ]);

      const others = PEOPLE.filter((p) => p.department !== own);
      const forbidden = [...others.flatMap((p) => [p.name, p.badge]), ...DEPARTMENTS.filter((d) => d !== own)];
      for (const word of forbidden) {
        const leaked = outputs.filter((o) => o.text.includes(word)).map((o) => o.tool);
        assert.deepEqual(leaked, [], `${email} learned '${word}'`);
      }

      // Structural check as well: every person and punch returned belongs to the member's department.
      const ownIds = new Set(PEOPLE.filter((p) => p.department === own).map((p) => p.id));
      const seen = outputs.flatMap((o) => {
        const d = o.data as { employees?: Array<{ user_id: number }>; punches?: Array<{ user_id: number }> };
        return [...(d.employees ?? []), ...(d.punches ?? [])].map((r) => r.user_id);
      });
      assert.ok(seen.length > 0, "the member sees its own department");
      assert.deepEqual(seen.filter((id) => !ownIds.has(id)), [], `${email} saw other departments' user ids`);
    });
  }
});
