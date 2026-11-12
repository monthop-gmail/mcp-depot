/**
 * Test helpers: a real AccessJwtProvider wired to an in-memory key pair, and a tiny MCP client.
 * Nothing here is used at runtime and nothing here bypasses verification.
 */
import { generateKeyPairSync, createSign } from "node:crypto";
import type { AddressInfo } from "node:net";
import { request, type IncomingHttpHeaders, type Server as HttpServer } from "node:http";
import { AccessJwtProvider } from "./identity.js";

export const TEST_TEAM = "test-team.cloudflareaccess.com";
export const TEST_ORIGIN = `https://${TEST_TEAM}`;
export const TEST_AUD = "a".repeat(64);
export const TEST_HOST = "depot-test.example.com";

export interface TestIdentity {
  provider: AccessJwtProvider;
  /** Signs a JWT with the test key. Claims default to a valid user token for alice@example.com. */
  sign(claims?: Record<string, unknown>, header?: Record<string, unknown>): string;
  /** Number of JWKS fetches so far. */
  fetches(): number;
  nowMs: { value: number };
}

export function createTestIdentity(): TestIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  const kid = "test-kid-1";
  let count = 0;
  const nowMs = { value: Date.UTC(2026, 10, 12, 5, 0, 0) };
  const fakeFetch = (async (input: string | URL | Request) => {
    count += 1;
    const url = String(input instanceof Request ? input.url : input);
    if (url !== `${TEST_ORIGIN}/cdn-cgi/access/certs`) return new Response("not found", { status: 404 });
    return Response.json({ keys: [{ kty: "RSA", kid, n: jwk.n, e: jwk.e, alg: "RS256", use: "sig" }] });
  }) as typeof fetch;
  const provider = new AccessJwtProvider({
    teamDomain: TEST_TEAM,
    audiences: [TEST_AUD],
    fetch: fakeFetch,
    now: () => nowMs.value,
  });
  const sign = (claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) => {
    const nowS = Math.floor(nowMs.value / 1000);
    const h = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT", ...header })).toString("base64url");
    const p = Buffer.from(
      JSON.stringify({ iss: TEST_ORIGIN, aud: [TEST_AUD], exp: nowS + 600, iat: nowS, email: "alice@example.com", ...claims }),
    ).toString("base64url");
    const signer = createSign("RSA-SHA256");
    signer.update(`${h}.${p}`);
    return `${h}.${p}.${signer.sign(privateKey).toString("base64url")}`;
  };
  return { provider, sign, fetches: () => count, nowMs };
}

export interface RpcResponse {
  status: number;
  json: unknown;
}

export interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

/** Plain HTTP request with full header control (fetch cannot set Host). */
export function raw(
  server: HttpServer,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<RawResponse> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path ?? "/mcp",
        headers: { host: TEST_HOST, ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** Minimal Streamable HTTP client for tests: one JSON-RPC request per HTTP POST. */
export async function rpc(
  server: HttpServer,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<RpcResponse> {
  const res = await raw(server, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  let json: unknown = null;
  try {
    json = JSON.parse(res.text);
  } catch {
    json = res.text;
  }
  return { status: res.status, json };
}
