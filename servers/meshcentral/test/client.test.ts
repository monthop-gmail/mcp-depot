// The live client against a fake MeshCentral (ws on 127.0.0.1, plain ws via MESHCENTRAL_ALLOW_HTTP).
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { startTestServer, type TestServer } from "@mcp-depot/core/testing";
import { MeshClient } from "../src/client.js";
import { clientConfigFromEnv, definition } from "../src/definition.js";
import { NOT_FOUND } from "../src/tools.js";

const A = "mesh//fake-a";
const B = "mesh//fake-b";
const C = "mesh//fake-c";
const nodes: Record<string, Array<Record<string, unknown>>> = {
  [A]: [{ _id: "node//fake-a1", name: "a-one", ip: "192.0.2.41", conn: 1 }],
  [B]: [{ _id: "node//fake-b1", name: "b-one", ip: "192.0.2.42", conn: 0 }],
  [C]: [{ _id: "node//fake-c1", name: "c-one", ip: "192.0.2.43", conn: 1 }],
};

describe("meshcentral live client", () => {
  let wss: WebSocketServer;
  let port = 0;
  let auth = "";
  const received: Array<Record<string, unknown>> = [];
  /** How the fake answers `nodes`: "honest" honours meshid; "leaky" also returns group C; "invalid" errors. */
  let mode: "honest" | "leaky" | "invalid" | "silent" | "close" = "honest";
  let sockets: WebSocket[] = [];

  before(async () => {
    wss = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/control.ashx" });
    wss.on("connection", (ws, req) => {
      sockets.push(ws);
      auth = String(req.headers["x-meshauth"] ?? "");
      ws.send(JSON.stringify({ action: "ping" }));
      ws.send(JSON.stringify({ action: "serverinfo", serverinfo: {} }));
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        received.push(msg);
        const reply = (m: Record<string, unknown>) => ws.send(JSON.stringify({ ...m, action: msg.action, responseid: msg.responseid }));
        if (msg.action === "meshes") return reply({ meshes: [A, B, C].map((id) => ({ _id: id, name: `group ${id.slice(-1)}` })) });
        if (msg.action !== "nodes") return;
        if (mode === "silent") return;
        if (mode === "close") return ws.send(JSON.stringify({ action: "close", cause: "noauth" }));
        if (mode === "invalid") return reply({ result: "Invalid group id" });
        const id = msg.meshid as string | undefined;
        if (id === undefined) return reply({ nodes });
        reply({ nodes: { [id]: nodes[id] ?? [], ...(mode === "leaky" ? { [C]: nodes[C] } : {}) } });
      });
    });
    await new Promise<void>((r) => wss.on("listening", () => r()));
    port = (wss.address() as AddressInfo).port;
  });
  after(() => new Promise<void>((r) => wss.close(() => r())));
  beforeEach(() => {
    mode = "honest";
    received.length = 0;
  });

  const client = (timeoutMs = 2000) =>
    new MeshClient({
      ...clientConfigFromEnv({
        MESHCENTRAL_URL: `http://127.0.0.1:${port}`,
        MESHCENTRAL_ALLOW_HTTP: "true",
        MESHCENTRAL_USER: "mcp-viewer",
        MESHCENTRAL_PASSWORD: "synthetic-pass,word",
      }),
      timeoutMs,
    });

  describe("through the tools", () => {
    let t: TestServer;
    let c: MeshClient;
    before(async () => {
      c = client();
      t = await startTestServer(definition(c), `
members:
  "user:ab@example.com": { roles: [viewer], scopes: { device_groups: ["${A}", "${B}"] } }
`);
    });
    after(async () => {
      c.close();
      await t.close();
    });

    it("authenticates with x-meshauth and requests exactly the permitted groups", async () => {
      const r = (await t.call("ab@example.com", "get_inventory")).data as { devices: Array<{ name: string }> };
      assert.deepEqual(r.devices.map((d) => d.name), ["a-one", "b-one"]);
      const [user, pass] = auth.split(",").map((p) => Buffer.from(p, "base64").toString());
      assert.deepEqual([user, pass], ["mcp-viewer", "synthetic-pass,word"]);
      const asked = received.filter((m) => m.action === "nodes").map((m) => m.meshid).sort();
      assert.deepEqual(asked, [A, B], "one nodes request per permitted group, none unfiltered");
    });

    it("drops nodes of other groups even when the server returns them", async () => {
      mode = "leaky";
      const inv = await t.call("ab@example.com", "get_inventory");
      const groups = await t.call("ab@example.com", "list_groups");
      for (const text of [inv.text, groups.text]) {
        assert.doesNotMatch(text, /c-one|192\.0\.2\.43|fake-c/);
      }
      assert.deepEqual((groups.data as { groups: Array<{ id: string; device_count: number }> }).groups.map((g) => [g.id, g.device_count]), [[A, 1], [B, 1]]);
    });

    it("treats 'Invalid group id' as not found without passing the upstream text on", async () => {
      mode = "invalid";
      const r = await t.call("ab@example.com", "get_inventory", { group_id: A });
      assert.equal(r.isError, true);
      assert.equal(r.text, NOT_FOUND);
    });

    it("sends only meshes, nodes and pong", () => {
      const actions = new Set(received.map((m) => m.action));
      for (const a of actions) assert.ok(["meshes", "nodes", "pong"].includes(String(a)), `unexpected action ${String(a)}`);
    });
  });

  it("times out a request the server never answers", async () => {
    mode = "silent";
    const c = client(300);
    await assert.rejects(c.request("nodes", { meshid: A }), /timed out after 300ms/);
    c.close();
  });

  it("rejects pending requests when the server sends close", async () => {
    mode = "close";
    const c = client();
    await assert.rejects(c.request("nodes", { meshid: A }), /closed the session \(noauth\)/);
    c.close();
  });

  it("reconnects on the next request after the connection drops", async () => {
    const c = client();
    await c.request("meshes");
    const before = sockets.length;
    for (const s of sockets) s.terminate();
    await new Promise((r) => setTimeout(r, 50));
    const reply = await c.request("meshes");
    assert.ok(Array.isArray(reply.meshes));
    assert.equal(sockets.length, before + 1);
    assert.ok(received.some((m) => m.action === "pong"), "ping answered with pong");
    c.close();
  });
});
