import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  ConfigError,
  FileMembership,
  Guard,
  StaticMembership,
  loadManifest,
  loadRoles,
  servicePrincipal,
  userPrincipal,
} from "../src/index.js";

const ECHO = fileURLToPath(new URL("../../test/fixtures/echo/", import.meta.url));
const manifest = loadManifest(join(ECHO, "manifest.yaml"));
const roles = loadRoles(join(ECHO, "roles.yaml"), manifest);

const MEMBERS = `
members:
  "user:reader@example.com": { roles: [reader], scopes: { rooms: ["a"] } }
  "user:writer@example.com": { roles: [writer], scopes: { rooms: ["*"] } }
  "user:noscope@example.com": { roles: [reader] }
  "user:ghost-role@example.com": { roles: [nonexistent], scopes: { rooms: ["a"] } }
  "service:bot.access": { roles: [reader], scopes: { rooms: ["a"] } }
`;

describe("Guard (default deny)", () => {
  const guard = new Guard(manifest, roles, new StaticMembership(MEMBERS));

  it("allows a member whose role names the tool, passing scopes", () => {
    const d = guard.decide(userPrincipal("reader@example.com"), "say");
    assert.deepEqual(d, { allow: true, roles: ["reader"], scopes: { rooms: ["a"] } });
  });

  it("denies every tool to a non-member", () => {
    for (const tool of manifest.tools) {
      assert.deepEqual(guard.decide(userPrincipal("stranger@example.com"), tool.name), {
        allow: false,
        reason: tool.default_enabled === false ? "tool_disabled" : "not_member",
      });
    }
  });

  it("denies a member without a role naming the tool", () => {
    assert.equal(guard.decide(userPrincipal("ghost-role@example.com"), "say").allow, false);
  });

  it("denies when a required scope is missing", () => {
    assert.deepEqual(guard.decide(userPrincipal("noscope@example.com"), "say"), { allow: false, reason: "scope_missing" });
  });

  it("keeps a default-off write tool disabled even for a role that names it", () => {
    assert.deepEqual(guard.decide(userPrincipal("writer@example.com"), "remember"), { allow: false, reason: "tool_disabled" });
    assert.deepEqual(guard.visibleTools(userPrincipal("writer@example.com")), ["say"]);
  });

  it("enables a default-off tool only when the deployment says so", () => {
    const g = new Guard(manifest, roles, new StaticMembership(MEMBERS), ["remember"]);
    assert.equal(g.decide(userPrincipal("writer@example.com"), "remember").allow, true);
    assert.equal(g.decide(userPrincipal("reader@example.com"), "remember").allow, false);
  });

  it("rejects unknown tools and unknown ENABLED_TOOLS", () => {
    assert.deepEqual(guard.decide(userPrincipal("reader@example.com"), "nope"), { allow: false, reason: "unknown_tool" });
    assert.throws(() => new Guard(manifest, roles, new StaticMembership(MEMBERS), ["nope"]), ConfigError);
  });

  it("keeps services separate from people", () => {
    assert.equal(guard.decide(servicePrincipal("bot.access"), "say").allow, true);
    assert.equal(guard.decide(userPrincipal("bot.access@example.com"), "say").allow, false);
  });
});

describe("FileMembership", () => {
  const dir = mkdtempSync(join(tmpdir(), "depot-members-"));
  const path = join(dir, "members.yaml");
  let tick = 1_700_000_000;
  const write = (text: string) => {
    writeFileSync(path, text);
    tick += 10;
    utimesSync(path, tick, tick);
  };

  it("refuses to start on a missing or invalid file", () => {
    assert.throws(() => new FileMembership(join(dir, "missing.yaml")), ConfigError);
    write("members: [not, a, map]");
    assert.throws(() => new FileMembership(path), ConfigError);
  });

  it("applies removals on the next lookup without restart", () => {
    write(MEMBERS);
    const m = new FileMembership(path);
    assert.ok(m.lookup("user:reader@example.com").status === "ok");
    write(MEMBERS.replace(/.*reader@example\.com.*\n/, ""));
    const after = m.lookup("user:reader@example.com");
    assert.deepEqual(after, { status: "ok", member: undefined });
  });

  it("fails closed when the file becomes invalid, then recovers", () => {
    write(MEMBERS);
    const m = new FileMembership(path);
    write("members: {\"user:bad\": {roles: []}}");
    assert.deepEqual(m.lookup("user:writer@example.com"), { status: "unavailable" });
    write(MEMBERS);
    assert.equal(m.lookup("user:writer@example.com").status, "ok");
  });

  it("normalises user keys and rejects duplicates after normalisation", () => {
    write(`members:\n  "user:Reader@Example.com": { roles: [reader], scopes: { rooms: ["a"] } }\n`);
    const m = new FileMembership(path);
    const r = m.lookup("user:reader@example.com");
    assert.ok(r.status === "ok" && r.member);
    write(`members:\n  "user:A@example.com": { roles: [reader] }\n  "user:a@example.com": { roles: [reader] }\n`);
    assert.deepEqual(m.lookup("user:a@example.com"), { status: "unavailable" });
  });

  it("cleans up", () => rmSync(dir, { recursive: true, force: true }));
});

describe("manifest and roles", () => {
  const dir = mkdtempSync(join(tmpdir(), "depot-manifest-"));
  it("rejects tool names carrying the server prefix", () => {
    const p = join(dir, "m.yaml");
    writeFileSync(
      p,
      "name: echo\nsummary: Prefix test server only.\nowner: '@x'\nstatus: experimental\nruntime: any\ndata_class: public\ntools:\n  - { name: echo_say, summary: Says things, access: read }\n",
    );
    assert.throws(() => loadManifest(p), /server prefix/);
  });
  it("rejects roles that name unknown tools", () => {
    const p = join(dir, "r.yaml");
    writeFileSync(p, "scope_keys: []\nroles:\n  x: { tools: [say, ghost] }\n");
    assert.throws(() => loadRoles(p, manifest), /unknown tool 'ghost'/);
  });
  it("cleans up", () => rmSync(dir, { recursive: true, force: true }));
});
