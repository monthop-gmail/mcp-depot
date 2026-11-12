import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import {
  AuditLog,
  ConfigError,
  StaticMembership,
  ToolError,
  configFromEnv,
  createHttpServer,
  loadServer,
  type ServerDefinition,
} from "../src/index.js";
import { createTestIdentity, raw, rpc, TEST_AUD, TEST_HOST, TEST_TEAM } from "../src/testing.js";

const ECHO = fileURLToPath(new URL("../../test/fixtures/echo/", import.meta.url));

const echoDefinition = (): ServerDefinition => ({
  dir: ECHO,
  version: "0.0.0-test",
  tools: {
    say: {
      description: "Echo a message.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string", maxLength: 100 } },
        required: ["message"],
        additionalProperties: false,
      },
      handler: async (args: { message: string }, ctx) => {
        if (args.message === "boom") throw new Error("secret internal detail");
        if (args.message === "nope") throw new ToolError("nothing to see");
        return { message: args.message, rooms: ctx.scopes.rooms, principal: ctx.principal.id };
      },
    },
    remember: {
      description: "Store a note.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => ({ stored: true }),
    },
  },
});

const MEMBERS = `
members:
  "user:alice@example.com": { roles: [reader], scopes: { rooms: ["a"] } }
  "user:wendy@example.com": { roles: [writer], scopes: { rooms: ["*"] } }
`;

describe("HTTP + MCP surface", () => {
  const id = createTestIdentity();
  const lines: string[] = [];
  const loaded = loadServer(echoDefinition());
  const server = createHttpServer(loaded, {
    port: 0,
    deployment: "site-a-echo",
    allowedHosts: new Set([TEST_HOST]),
    identity: id.provider,
    membership: new StaticMembership(MEMBERS),
    audit: new AuditLog((line) => lines.push(line)),
    enabledTools: [],
    bodyLimitBytes: 4096,
  });
  const auth = (claims: Record<string, unknown> = {}) => ({ "cf-access-jwt-assertion": id.sign(claims) });
  const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  before(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)));
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("serves /healthz without identity and without data", async () => {
    const res = await fetch(`${base()}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it("rejects requests without a JWT (direct LAN/host access)", async () => {
    const r = await rpc(server, "tools/list");
    assert.equal(r.status, 401);
  });

  it("rejects wrong Host and foreign Origin before identity", async () => {
    assert.equal((await rpc(server, "tools/list", {}, { host: "evil.example.com", ...auth() })).status, 403);
    assert.equal((await rpc(server, "tools/list", {}, { origin: "https://evil.example.com", ...auth() })).status, 403);
    assert.equal((await rpc(server, "tools/list", {}, { origin: `https://${TEST_HOST}`, ...auth() })).status, 200);
  });

  it("only allows POST on /mcp and sends no CORS headers", async () => {
    const res = await raw(server, { method: "GET" });
    assert.equal(res.status, 405);
    assert.equal(res.headers["access-control-allow-origin"], undefined);
    const options = await raw(server, { method: "OPTIONS", headers: { origin: `https://${TEST_HOST}` } });
    assert.equal(options.headers["access-control-allow-origin"], undefined);
  });

  it("enforces the body limit", async () => {
    const r = await rpc(server, "tools/call", { name: "say", arguments: { message: "x".repeat(5000) } }, auth());
    assert.equal(r.status, 413);
  });

  it("lists only the tools the principal may call; default-off tools never appear", async () => {
    const list = (r: { json: unknown }) =>
      ((r.json as { result: { tools: Array<{ name: string }> } }).result.tools).map((t) => t.name);
    assert.deepEqual(list(await rpc(server, "tools/list", {}, auth())), ["say"]);
    assert.deepEqual(list(await rpc(server, "tools/list", {}, auth({ email: "wendy@example.com" }))), ["say"]);
    assert.deepEqual(list(await rpc(server, "tools/list", {}, auth({ email: "nobody@example.com" }))), []);
  });

  it("calls a permitted tool with scopes from membership", async () => {
    const r = await rpc(server, "tools/call", { name: "say", arguments: { message: "hi" } }, auth());
    const text = (r.json as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
    assert.deepEqual(JSON.parse(text), { message: "hi", rooms: ["a"], principal: "user:alice@example.com" });
  });

  it("denies every manifest tool to a non-member, and audits each denial", async () => {
    for (const tool of loaded.manifest.tools) {
      const r = await rpc(server, "tools/call", { name: tool.name, arguments: {} }, auth({ email: "nobody@example.com" }));
      const result = (r.json as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
      assert.equal(result.isError, true);
      assert.match(result.content[0]!.text, /^denied: /);
    }
    const denials = lines.map((l) => JSON.parse(l)).filter((l) => l.principal === "user:nobody@example.com");
    assert.equal(denials.length, loaded.manifest.tools.length);
  });

  it("validates arguments before the handler runs", async () => {
    const r = await rpc(server, "tools/call", { name: "say", arguments: { message: 5 } }, auth());
    const result = (r.json as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /^invalid arguments/);
  });

  it("returns ToolError messages but hides other errors", async () => {
    const nope = await rpc(server, "tools/call", { name: "say", arguments: { message: "nope" } }, auth());
    assert.match(JSON.stringify(nope.json), /nothing to see/);
    const boom = await rpc(server, "tools/call", { name: "say", arguments: { message: "boom" } }, auth());
    assert.doesNotMatch(JSON.stringify(boom.json), /secret internal detail/);
  });

  it("never writes tokens into audit lines", async () => {
    const token = id.sign();
    await rpc(server, "tools/call", { name: "say", arguments: { message: "x" } }, { "cf-access-jwt-assertion": token });
    const all = lines.join("\n");
    assert.equal(all.includes(token), false);
    assert.equal(all.includes(token.split(".")[2]!), false);
    const last = JSON.parse(lines.at(-1)!);
    assert.equal(last.deployment, "site-a-echo");
    assert.equal(last.outcome, "ok");
  });
});

describe("refuse to start", () => {
  it("rejects code whose tools differ from the manifest", () => {
    const def = echoDefinition();
    delete def.tools.remember;
    assert.throws(() => loadServer(def), ConfigError);
    const extra = echoDefinition();
    extra.tools.sneaky = extra.tools.say!;
    assert.throws(() => loadServer(extra), ConfigError);
  });

  it("rejects incomplete deployment settings", () => {
    const loaded = loadServer(echoDefinition());
    const good = {
      ALLOWED_HOSTS: TEST_HOST,
      MEMBERS_PATH: fileURLToPath(new URL("../../test/fixtures/members.yaml", import.meta.url)),
      ACCESS_TEAM_DOMAIN: TEST_TEAM,
      ACCESS_AUD: TEST_AUD,
    };
    assert.doesNotThrow(() => configFromEnv(loaded, good));
    for (const drop of Object.keys(good)) {
      const env: Record<string, string> = { ...good };
      delete env[drop];
      assert.throws(() => configFromEnv(loaded, env), ConfigError, `missing ${drop}`);
    }
    assert.throws(() => configFromEnv(loaded, { ...good, ACCESS_AUD: "not-hex" }), ConfigError);
    assert.throws(() => configFromEnv(loaded, { ...good, ENABLED_TOOLS: "ghost" }), ConfigError);
  });
});
