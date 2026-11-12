import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ConfigError } from "@mcp-depot/core";
import { AuditLog, StaticMembership, createHttpServer, loadServer } from "@mcp-depot/core/internal";
import { createTestIdentity, rpc, TEST_HOST } from "@mcp-depot/core/testing";
import { definition, storeFromEnv } from "../src/definition.js";
import { FixtureStore } from "../src/fixture.js";
import { MdbStore } from "../src/mdb-store.js";
import { MssqlStore } from "../src/mssql-store.js";

// Synthetic membership only. Personal data: departments are always named; core refuses ["*"].
const ALL = `["Head Office", "Workshop", "Warehouse"]`;
const MEMBERS = `
members:
  "user:root@example.com":     { roles: [viewer, diagnostics], scopes: { departments: ${ALL} } }
  "user:alice@example.com":    { roles: [viewer], scopes: { departments: ["Workshop"] } }
  "user:bob@example.com":      { roles: [viewer], scopes: { departments: ["Workshop", "Warehouse", "No such department"] } }
  "user:empty@example.com":    { roles: [viewer], scopes: { departments: ["No such department"] } }
  "user:diag@example.com":     { roles: [diagnostics], scopes: { departments: ${ALL} } }
  "user:norole@example.com":   { roles: [other], scopes: { departments: ${ALL} } }
  "user:wildcard@example.com": { roles: [viewer, diagnostics], scopes: { departments: ["*"] } }
  "user:noscope@example.com":  { roles: [viewer, diagnostics] }
`;

const RANGE = { from: "2026-11-01", to: "2026-11-30" };
const argsFor = (tool: string) => (tool === "list_punches" ? RANGE : {});

type CallResult = { isError?: boolean; content: Array<{ text: string }> };

describe("zktime server (fixture mode)", () => {
  const fixture = new FixtureStore();
  const loaded = loadServer(definition(fixture));
  const id = createTestIdentity();
  const audit: string[] = [];
  const server = createHttpServer(loaded, {
    port: 0,
    deployment: "site-a-zktime",
    allowedHosts: new Set([TEST_HOST]),
    identity: id.provider,
    membership: new StaticMembership(MEMBERS),
    audit: new AuditLog((l) => audit.push(l)),
    enabledTools: [],
    bodyLimitBytes: 64 * 1024,
  });
  const as = (email: string) => ({ "cf-access-jwt-assertion": id.sign({ email }) });
  const call = async (email: string, name: string, args: Record<string, unknown> = {}) => {
    const r = await rpc(server, "tools/call", { name, arguments: args }, as(email));
    const result = (r.json as { result: CallResult }).result;
    return { result, text: result.content[0]!.text, data: result.isError ? null : JSON.parse(result.content[0]!.text) };
  };
  const names = async (email: string) =>
    ((await rpc(server, "tools/list", {}, as(email))).json as { result: { tools: Array<{ name: string }> } }).result.tools
      .map((t) => t.name)
      .sort();
  const lastCall = (method: string) => fixture.calls.filter((c) => c.method === method).at(-1);

  before(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)));
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("answers initialize with the server name", async () => {
    const r = await rpc(server, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    }, as("alice@example.com"));
    assert.equal((r.json as { result: { serverInfo: { name: string } } }).result.serverInfo.name, "zktime");
  });

  it("tools/list equals the manifest for a member with both roles; each role sees only its tools", async () => {
    assert.deepEqual(await names("root@example.com"), loaded.manifest.tools.map((t) => t.name).sort());
    assert.deepEqual(await names("alice@example.com"), ["get_status", "list_departments", "list_devices", "list_employees", "list_punches"]);
    assert.deepEqual(await names("diag@example.com"), ["get_status", "inspect_schema"]);
    for (const email of ["stranger@example.com", "norole@example.com", "noscope@example.com", "wildcard@example.com"]) {
      assert.deepEqual(await names(email), [], email);
    }
  });

  it("denies every tool to non-members, members without the role and members without the scope", async () => {
    const expected = {
      "stranger@example.com": "not_member",
      "norole@example.com": "role_missing",
      "noscope@example.com": "scope_missing",
      "wildcard@example.com": "scope_wildcard_forbidden",
    };
    for (const [email, reason] of Object.entries(expected)) {
      for (const tool of loaded.manifest.tools) {
        const { result, text } = await call(email, tool.name, argsFor(tool.name));
        assert.equal(result.isError, true, `${email} ${tool.name}`);
        assert.equal(text, `denied: ${reason}`, `${email} ${tool.name}`);
      }
    }
  });

  it("denies inspect_schema to viewer and personal-data tools to diagnostics", async () => {
    assert.equal((await call("alice@example.com", "inspect_schema")).text, "denied: role_missing");
    for (const tool of ["list_departments", "list_devices", "list_employees", "list_punches"]) {
      assert.equal((await call("diag@example.com", tool, argsFor(tool))).text, "denied: role_missing", tool);
    }
    const schema = await call("diag@example.com", "inspect_schema");
    assert.equal(schema.result.isError, undefined);
    assert.ok(schema.data.columns.USERINFO.includes("USERID"));
  });

  it("passes the department scope into the store as ids, resolved from names", async () => {
    fixture.calls.length = 0;
    const alice = await call("alice@example.com", "list_employees");
    assert.deepEqual(lastCall("listEmployees")?.departmentIds, [2], "scope sent to the store, not filtered afterwards");
    assert.deepEqual(alice.data.employees.map((e: { department: string }) => e.department), ["Workshop", "Workshop"]);

    await call("bob@example.com", "list_employees");
    assert.deepEqual(lastCall("listEmployees")?.departmentIds, [2, 3], "unknown names are dropped");

    const root = await call("root@example.com", "list_employees");
    assert.deepEqual(lastCall("listEmployees")?.departmentIds, [1, 2, 3], "every department named explicitly");
    assert.equal(root.data.count, 4);

    const punches = await call("alice@example.com", "list_punches", RANGE);
    assert.deepEqual(lastCall("listPunches")?.departmentIds, [2]);
    assert.deepEqual([...new Set(punches.data.punches.map((p: { user_id: number }) => p.user_id))].sort(), [2, 3]);

    const departments = await call("alice@example.com", "list_departments");
    assert.deepEqual(lastCall("listDepartments")?.departmentIds, [2]);
    assert.deepEqual(departments.data.departments.map((d: { name: string }) => d.name), ["Workshop"]);

    const status = await call("alice@example.com", "get_status");
    assert.deepEqual(lastCall("status")?.departmentIds, [2]);
    assert.equal(status.data.employee_count, 2);
    assert.equal(status.data.sample, true);
  });

  it("treats a scope of unknown departments as seeing nothing, not as an error", async () => {
    fixture.calls.length = 0;
    for (const [tool, key] of [["list_employees", "employees"], ["list_punches", "punches"], ["list_departments", "departments"]] as const) {
      const { result, data } = await call("empty@example.com", tool, argsFor(tool));
      assert.equal(result.isError, undefined, tool);
      assert.deepEqual(data[key], [], tool);
    }
    assert.ok(fixture.calls.length > 0);
    for (const c of fixture.calls) assert.deepEqual(c.departmentIds, [], c.method);
    assert.equal((await call("empty@example.com", "get_status")).data.employee_count, 0);
  });

  it("does not tie devices to departments", async () => {
    const { data } = await call("empty@example.com", "list_devices");
    assert.equal(data.count, 2);
    for (const d of data.devices) assert.equal("CommPassword" in d || "comm_password" in d, false);
  });

  it("requires a punch date range of at most 31 days", async () => {
    const tooLong = await call("root@example.com", "list_punches", { from: "2026-10-01", to: "2026-11-01" });
    assert.equal(tooLong.result.isError, true);
    assert.match(tooLong.text, /^invalid arguments: .*31 days/);
    const backwards = await call("root@example.com", "list_punches", { from: "2026-11-05", to: "2026-11-01" });
    assert.match(backwards.text, /^invalid arguments/);
    const notADate = await call("root@example.com", "list_punches", { from: "2026-02-30", to: "2026-03-01" });
    assert.match(notADate.text, /^invalid arguments/);
    const missing = await call("root@example.com", "list_punches", { from: "2026-11-01" });
    assert.match(missing.text, /^invalid arguments/);
    const tooMany = await call("root@example.com", "list_punches", { ...RANGE, limit: 501 });
    assert.match(tooMany.text, /^invalid arguments/);
    const exactly31 = await call("root@example.com", "list_punches", { from: "2026-10-04", to: "2026-11-03" });
    assert.equal(exactly31.result.isError, undefined);
    assert.equal(exactly31.data.count, 11);
  });

  it("limits punch rows and filters by type and date", async () => {
    const limited = await call("root@example.com", "list_punches", { ...RANGE, limit: 3 });
    assert.equal(limited.data.count, 3);
    assert.equal(limited.data.truncated, true);
    const day = await call("root@example.com", "list_punches", { from: "2026-11-03", to: "2026-11-03", check_type: "in" });
    assert.equal(day.data.count, 3);
    assert.ok(day.data.punches.every((p: { check_type: string }) => p.check_type === "in"));
  });

  it("never returns card numbers, gender, biometrics or passwords", async () => {
    const forbidden = /card|gender|ssn|password|template|finger|face|photo/i;
    for (const tool of loaded.manifest.tools) {
      const { text } = await call("root@example.com", tool.name, argsFor(tool.name));
      if (tool.name === "inspect_schema") continue; // column names only
      const keys = [...text.matchAll(/"([A-Za-z_]+)":/g)].map((m) => m[1]!);
      assert.deepEqual(keys.filter((k) => forbidden.test(k)), [], tool.name);
    }
  });

  it("writes one audit line per call with the verified principal", () => {
    const lines = audit.map((l) => JSON.parse(l));
    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.equal(line.server, "zktime");
      assert.equal(line.deployment, "site-a-zktime");
      assert.match(line.principal, /^user:[^@]+@example\.com$/);
    }
  });
});

describe("zktime configuration", () => {
  it("chooses the backend from ZKTIME_MODE and refuses to start when misconfigured", () => {
    assert.throws(() => storeFromEnv({}), ConfigError);
    assert.throws(() => storeFromEnv({ ZKTIME_MODE: "magic" }), ConfigError);
    assert.throws(() => storeFromEnv({ ZKTIME_MODE: "mssql", ZKTIME_MSSQL_HOST: "db.example.com" }), ConfigError);
    assert.throws(
      () => storeFromEnv({ ZKTIME_MODE: "mssql", ZKTIME_MSSQL_HOST: "db.example.com", ZKTIME_MSSQL_USER: "sa", ZKTIME_MSSQL_PASSWORD: "x" }),
      ConfigError,
    );
    assert.throws(
      () => storeFromEnv({ ZKTIME_MODE: "mssql", ZKTIME_MSSQL_HOST: "db.example.com", ZKTIME_MSSQL_USER: "ro", ZKTIME_MSSQL_PASSWORD: "x", ZKTIME_MSSQL_PORT: "x" }),
      ConfigError,
    );
    assert.ok(storeFromEnv({ ZKTIME_MODE: "fixture" }) instanceof FixtureStore);
    assert.ok(storeFromEnv({ ZKTIME_MODE: "mdb" }) instanceof MdbStore);
    assert.ok(
      storeFromEnv({ ZKTIME_MODE: "mssql", ZKTIME_MSSQL_HOST: "db.example.com", ZKTIME_MSSQL_USER: "ro", ZKTIME_MSSQL_PASSWORD: "x" }) instanceof
        MssqlStore,
    );
  });
});
