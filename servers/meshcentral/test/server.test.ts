import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ConfigError } from "@mcp-depot/core";
import { loadServer } from "@mcp-depot/core/internal";
import { startTestServer, type TestServer } from "@mcp-depot/core/testing";
import { MeshClient } from "../src/client.js";
import { apiFromEnv, clientConfigFromEnv, fixtureDefinition } from "../src/definition.js";
import { FixtureMesh } from "../src/fixture.js";

const MEMBERS = `
members:
  "user:all@example.com":     { roles: [viewer], scopes: { device_groups: ["*"] } }
  "user:office@example.com":  { roles: [viewer], scopes: { device_groups: ["mesh//fixture-office"] } }
  "user:bad@example.com":     { roles: [viewer], scopes: { device_groups: ["fixture-office"] } }
  "user:norole@example.com":  { roles: [other], scopes: { device_groups: ["*"] } }
  "user:noscope@example.com": { roles: [viewer] }
`;

type Inventory = { count: number; truncated: boolean; devices: Array<Record<string, unknown>> };

describe("meshcentral server (fixture mode)", () => {
  const manifest = loadServer(fixtureDefinition()).manifest;
  let t: TestServer;
  before(async () => {
    t = await startTestServer(fixtureDefinition(), MEMBERS);
  });
  after(() => t.close());

  it("has read tools only, listed for a member and denied to everyone else", async () => {
    assert.deepEqual(manifest.tools.map((x) => [x.name, x.access]), [["list_groups", "read"], ["get_inventory", "read"]]);
    assert.deepEqual(await t.list("all@example.com"), ["get_inventory", "list_groups"]);
    const expected = { "stranger@example.com": "not_member", "norole@example.com": "role_missing", "noscope@example.com": "scope_missing" };
    for (const [email, reason] of Object.entries(expected)) {
      for (const tool of manifest.tools) assert.equal((await t.call(email, tool.name)).text, `denied: ${reason}`, `${email} ${tool.name}`);
    }
  });

  it("returns the documented device shape", async () => {
    const r = (await t.call("office@example.com", "get_inventory")).data as Inventory;
    assert.equal(r.count, 3);
    assert.equal(r.truncated, false);
    assert.deepEqual(r.devices[0], {
      id: "node//fixture-pc1", name: "office-pc-01", group_id: "mesh//fixture-office", os: "Windows 11 Pro", online: true,
      last_connect: "2026-11-12T08:00:00.000Z", ip: "192.0.2.11", cpu: "Sample CPU 4C", ram: "16 GB",
    });
    const groups = (await t.call("office@example.com", "list_groups")).data as { groups: unknown[] };
    assert.deepEqual(groups.groups, [{ id: "mesh//fixture-office", name: "Sample office PCs", device_count: 3 }]);
  });

  it("applies limit, truncated and online_only", async () => {
    const limited = (await t.call("all@example.com", "get_inventory", { limit: 2 })).data as Inventory;
    assert.equal(limited.count, 2);
    assert.equal(limited.truncated, true);
    const online = (await t.call("all@example.com", "get_inventory", { online_only: true })).data as Inventory;
    assert.equal(online.count, 5);
    assert.ok(online.devices.every((d) => d.online === true));
    assert.match((await t.call("all@example.com", "get_inventory", { limit: 501 })).text, /^invalid arguments/);
  });

  it("scope values that are not mesh ids grant nothing", async () => {
    assert.deepEqual(((await t.call("bad@example.com", "list_groups")).data as { groups: unknown[] }).groups, []);
    assert.equal(((await t.call("bad@example.com", "get_inventory")).data as Inventory).count, 0);
  });
});

describe("meshcentral configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-config-test-"));
  const ca = join(dir, "ca.pem");
  writeFileSync(ca, "-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n");
  after(() => rmSync(dir, { recursive: true, force: true }));
  const base = { MESHCENTRAL_URL: "https://mesh.example.com", MESHCENTRAL_USER: "mcp-viewer", MESHCENTRAL_PASSWORD: "x" };

  it("requires https, a sane timeout, a readable CA file and a known mode", () => {
    assert.equal(clientConfigFromEnv(base).url, "wss://mesh.example.com/control.ashx");
    assert.equal(clientConfigFromEnv({ ...base, MESHCENTRAL_URL: "https://mesh.example.com/sub/" }).url, "wss://mesh.example.com/sub/control.ashx");
    assert.equal(clientConfigFromEnv(base).timeoutMs, 15000);
    assert.throws(() => clientConfigFromEnv({ ...base, MESHCENTRAL_URL: "http://mesh.example.com" }), ConfigError);
    assert.equal(clientConfigFromEnv({ ...base, MESHCENTRAL_URL: "http://127.0.0.1:8080", MESHCENTRAL_ALLOW_HTTP: "true" }).url, "ws://127.0.0.1:8080/control.ashx");
    assert.throws(() => clientConfigFromEnv({ ...base, MESHCENTRAL_URL: "ftp://mesh.example.com" }), ConfigError);
    for (const bad of ["999", "60001", "abc", "1500.5"]) {
      assert.throws(() => clientConfigFromEnv({ ...base, MESHCENTRAL_TIMEOUT_MS: bad }), ConfigError, bad);
    }
    assert.equal(clientConfigFromEnv({ ...base, MESHCENTRAL_TIMEOUT_MS: "1000" }).timeoutMs, 1000);
    assert.throws(() => clientConfigFromEnv({ ...base, MESHCENTRAL_CA_FILE: join(dir, "missing.pem") }), ConfigError);
    assert.ok(clientConfigFromEnv({ ...base, MESHCENTRAL_CA_FILE: ca }).ca);
    assert.throws(() => clientConfigFromEnv({ ...base, MESHCENTRAL_PASSWORD: "" }), ConfigError);
    assert.throws(() => apiFromEnv({}), ConfigError);
    assert.ok(apiFromEnv({ MESHCENTRAL_MODE: "fixture" }) instanceof FixtureMesh);
    assert.ok(apiFromEnv({ MESHCENTRAL_MODE: "live", ...base }) instanceof MeshClient);
  });
});
