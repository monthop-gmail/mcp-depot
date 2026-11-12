import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AccessJwtProvider, ConfigError } from "../src/index.js";
import { createTestIdentity, TEST_AUD, TEST_ORIGIN, TEST_TEAM } from "../src/testing.js";

const header = (token: string) => ({ "cf-access-jwt-assertion": token });

describe("AccessJwtProvider", () => {
  it("accepts a valid user token and normalises the email", async () => {
    const t = createTestIdentity();
    const r = await t.provider.verify(header(t.sign({ email: "  Alice@Example.COM " })));
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.principal.id, "user:alice@example.com");
  });

  it("maps a service token (common_name, no email) to a service principal", async () => {
    const t = createTestIdentity();
    const r = await t.provider.verify(header(t.sign({ email: undefined, common_name: "bot-1.access" })));
    assert.equal(r.ok && r.principal.id, "service:bot-1.access");
  });

  it("rejects ambiguous principals: both email and common_name, or neither", async () => {
    const t = createTestIdentity();
    for (const claims of [{ common_name: "bot.access" }, { email: undefined }, { email: "" }]) {
      const r = await t.provider.verify(header(t.sign(claims)));
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.rejection.status, 403);
    }
  });

  it("rejects a missing or malformed header with 401", async () => {
    const t = createTestIdentity();
    for (const h of [{}, header(""), header("a.b"), header("..."), { "cf-access-jwt-assertion": ["x", "y"] }]) {
      const r = await t.provider.verify(h as never);
      assert.equal(!r.ok && r.rejection.status, 401);
    }
  });

  it("ignores other identity headers entirely", async () => {
    const t = createTestIdentity();
    const r = await t.provider.verify({ "cf-access-authenticated-user-email": "alice@example.com" });
    assert.equal(!r.ok && r.rejection.reason, "identity_missing");
  });

  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, string]> = [
    ["wrong audience", { aud: ["b".repeat(64)] }, {}, "token_audience"],
    ["wrong issuer", { iss: "https://other.cloudflareaccess.com" }, {}, "token_issuer"],
    ["expired beyond skew", { exp: 0 }, {}, "token_expired"],
    ["not yet valid", { nbf: 4102444800 }, {}, "token_not_yet_valid"],
    ["alg none", {}, { alg: "none" }, "token_algorithm"],
    ["alg HS256", {}, { alg: "HS256" }, "token_algorithm"],
    ["missing kid", {}, { kid: "" }, "token_algorithm"],
    ["unknown kid", {}, { kid: "other" }, "token_key_unknown"],
  ];
  for (const [name, claims, hdr, reason] of cases) {
    it(`rejects ${name}`, async () => {
      const t = createTestIdentity();
      const r = await t.provider.verify(header(t.sign(claims, hdr)));
      assert.equal(!r.ok && r.rejection.reason, reason);
    });
  }

  it("accepts aud as a plain string when it matches", async () => {
    const t = createTestIdentity();
    const r = await t.provider.verify(header(t.sign({ aud: TEST_AUD })));
    assert.equal(r.ok, true);
  });

  it("rejects a tampered payload (signature mismatch)", async () => {
    const t = createTestIdentity();
    const [h, , s] = t.sign().split(".");
    const forged = Buffer.from(
      JSON.stringify({ iss: TEST_ORIGIN, aud: [TEST_AUD], exp: 4102444800, email: "mallory@example.com" }),
    ).toString("base64url");
    const r = await t.provider.verify(header(`${h}.${forged}.${s}`));
    assert.equal(!r.ok && r.rejection.reason, "token_signature");
  });

  it("caches keys and rate-limits refetches for unknown kids", async () => {
    const t = createTestIdentity();
    await t.provider.verify(header(t.sign()));
    await t.provider.verify(header(t.sign()));
    assert.equal(t.fetches(), 1);
    await t.provider.verify(header(t.sign({}, { kid: "unknown" })));
    assert.equal(t.fetches(), 1, "no refetch within 30 s of the last fetch");
    t.nowMs.value += 31_000;
    await t.provider.verify(header(t.sign({}, { kid: "unknown" })));
    assert.equal(t.fetches(), 2, "one refetch after the interval");
  });

  it("returns 503 when keys cannot be fetched", async () => {
    const provider = new AccessJwtProvider({
      teamDomain: TEST_TEAM,
      audiences: [TEST_AUD],
      fetch: (async () => new Response("down", { status: 502 })) as typeof fetch,
    });
    const t = createTestIdentity();
    const r = await provider.verify(header(t.sign()));
    assert.equal(!r.ok && r.rejection.status, 503);
  });

  it("refuses to construct with bad configuration", () => {
    const bad: Array<[string, string[]]> = [
      ["", [TEST_AUD]],
      ["http://test.cloudflareaccess.com", [TEST_AUD]],
      ["evil.example.com", [TEST_AUD]],
      ["test.cloudflareaccess.com/path", [TEST_AUD]],
      [TEST_TEAM, []],
      [TEST_TEAM, ["short"]],
    ];
    for (const [teamDomain, audiences] of bad) {
      assert.throws(() => new AccessJwtProvider({ teamDomain, audiences }), ConfigError);
    }
  });
});
