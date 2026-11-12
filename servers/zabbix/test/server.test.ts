import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { AuditLog, ConfigError, StaticMembership, createHttpServer, loadServer } from "@mcp-depot/core";
import { createTestIdentity, rpc, TEST_HOST } from "@mcp-depot/core/testing";
import { definition, rpcFromEnv } from "../src/definition.js";
import { FixtureZabbix } from "../src/fixture.js";

const MEMBERS = `
members:
  "user:alice@example.com": { roles: [viewer], scopes: { host_groups: ["Servers"] } }
  "user:root@example.com":  { roles: [viewer], scopes: { host_groups: ["*"] } }
  "user:empty@example.com": { roles: [viewer], scopes: { host_groups: ["No such group"] } }
  "user:norole@example.com": { roles: [other], scopes: { host_groups: ["*"] } }
  "user:noscope@example.com": { roles: [viewer] }
`;

type CallResult = { isError?: boolean; content: Array<{ text: string }> };

describe("zabbix server (fixture mode)", () => {
  const fixture = new FixtureZabbix();
  const loaded = loadServer(definition(fixture));
  const id = createTestIdentity();
  const audit: string[] = [];
  const server = createHttpServer(loaded, {
    port: 0,
    deployment: "site-a-zabbix",
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
    return { result, data: result.isError ? null : JSON.parse(result.content[0]!.text) };
  };

  before(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)));
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("answers initialize with the server name", async () => {
    const r = await rpc(server, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    }, as("alice@example.com"));
    assert.equal((r.json as { result: { serverInfo: { name: string } } }).result.serverInfo.name, "zabbix");
  });

  it("tools/list equals the manifest for a full member, and is empty for others", async () => {
    const names = async (email: string) =>
      ((await rpc(server, "tools/list", {}, as(email))).json as { result: { tools: Array<{ name: string }> } }).result.tools
        .map((t) => t.name)
        .sort();
    assert.deepEqual(await names("root@example.com"), loaded.manifest.tools.map((t) => t.name).sort());
    for (const email of ["stranger@example.com", "norole@example.com", "noscope@example.com"]) {
      assert.deepEqual(await names(email), [], email);
    }
  });

  it("denies every tool to non-members, members without the role and members without the scope", async () => {
    for (const email of ["stranger@example.com", "norole@example.com", "noscope@example.com"]) {
      for (const tool of loaded.manifest.tools) {
        const { result } = await call(email, tool.name, tool.name === "get_metrics" ? { host_name: "x", item_keys: ["k"] } : {});
        assert.equal(result.isError, true, `${email} ${tool.name}`);
        assert.match(result.content[0]!.text, /^denied: (not_member|role_missing|scope_missing)$/);
      }
    }
  });

  it("pushes the host-group scope into the Zabbix query", async () => {
    fixture.calls.length = 0;
    const { data } = await call("alice@example.com", "get_device_status");
    assert.deepEqual(data.devices.map((d: { host: string }) => d.host).sort(), ["srv-app-01", "srv-db-01"]);
    const hostQuery = fixture.calls.find((c) => c.method === "host.get");
    assert.deepEqual(hostQuery?.params.groupids, ["10"], "groupids sent to Zabbix, not filtered afterwards");
  });

  it("limits problems to permitted groups; ['*'] sees everything", async () => {
    const alice = await call("alice@example.com", "get_active_problems");
    assert.deepEqual(alice.data.problems.map((p: { name: string }) => p.name), ["Database agent unavailable"]);
    const root = await call("root@example.com", "get_active_problems", { severity_min: 4 });
    assert.equal(root.data.count, 2);
  });

  it("does not reveal hosts outside the scope", async () => {
    const outside = await call("alice@example.com", "get_metrics", { host_name: "sw-core-01", item_keys: ["system.cpu.util"] });
    assert.equal(outside.result.isError, true);
    assert.match(outside.result.content[0]!.text, /no permitted host/);
    const group = await call("alice@example.com", "get_device_status", { group_name: "Switches" });
    assert.equal(group.result.isError, true);
    const inside = await call("alice@example.com", "get_metrics", { host_name: "srv-app-01", item_keys: ["system.cpu.util", "nope"] });
    assert.equal(inside.data.metrics[0].lastvalue, "12.5");
    assert.deepEqual(inside.data.missing_item_keys, ["nope"]);
  });

  it("treats an unknown scope group as seeing nothing", async () => {
    const { data } = await call("empty@example.com", "get_device_status");
    assert.equal(data.count, 0);
  });

  it("writes one audit line per call with the verified principal", () => {
    const lines = audit.map((l) => JSON.parse(l));
    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.equal(line.server, "zabbix");
      assert.equal(line.deployment, "site-a-zabbix");
      assert.match(line.principal, /^user:[^@]+@example\.com$/);
    }
  });
});

describe("zabbix configuration", () => {
  it("refuses to start without API settings", () => {
    assert.throws(() => rpcFromEnv({}), ConfigError);
    assert.throws(() => rpcFromEnv({ ZABBIX_API_URL: "https://zabbix.example.com/api_jsonrpc.php" }), ConfigError);
    assert.throws(() => rpcFromEnv({ ZABBIX_MODE: "magic" }), ConfigError);
    assert.doesNotThrow(() =>
      rpcFromEnv({ ZABBIX_API_URL: "https://zabbix.example.com/api_jsonrpc.php", ZABBIX_API_TOKEN: "t" }),
    );
    assert.doesNotThrow(() => rpcFromEnv({ ZABBIX_MODE: "fixture" }));
  });
});
