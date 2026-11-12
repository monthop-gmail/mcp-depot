import { webcrypto } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { ConfigError } from "./errors.js";
import { log } from "./log.js";
import {
  type IdentityProvider,
  type IdentityResult,
  servicePrincipal,
  userPrincipal,
} from "./principal.js";

type CryptoKey = webcrypto.CryptoKey;
const subtle = webcrypto.subtle;

const SKEW_SECONDS = 60;
const JWKS_TTL_MS = 10 * 60 * 1000;
const JWKS_STALE_GRACE_MS = 60 * 60 * 1000;
const MIN_REFETCH_INTERVAL_MS = 30 * 1000;
const JWKS_TIMEOUT_MS = 5000;
const AUD_PATTERN = /^[0-9a-f]{64}$/i;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+$/;

export interface AccessJwtOptions {
  /** e.g. `team.cloudflareaccess.com` or `https://team.cloudflareaccess.com` */
  teamDomain: string;
  /** Exact AUD tags of this deployment's Access application(s). */
  audiences: string[];
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Injectable clock in milliseconds, for tests. */
  now?: () => number;
}

/** Validates and normalises the team domain. Throws ConfigError so the server refuses to start. */
export function parseTeamOrigin(domain: string): string {
  const raw = (domain ?? "").trim();
  if (!raw) throw new ConfigError("ACCESS_TEAM_DOMAIN is required");
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new ConfigError("ACCESS_TEAM_DOMAIN is not a valid host");
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".cloudflareaccess.com") || url.pathname !== "/") {
    throw new ConfigError("ACCESS_TEAM_DOMAIN must be https://<team>.cloudflareaccess.com");
  }
  return url.origin;
}

export function parseAudiences(list: string[]): string[] {
  const auds = list.map((a) => a.trim()).filter(Boolean);
  if (auds.length === 0) throw new ConfigError("ACCESS_AUD is required");
  for (const aud of auds) {
    if (!AUD_PATTERN.test(aud)) throw new ConfigError("ACCESS_AUD must be 64-character hex AUD tags");
  }
  return auds;
}

function b64urlToBytes(segment: string): Uint8Array {
  return new Uint8Array(Buffer.from(segment, "base64url"));
}

function b64urlJson(segment: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
  return parsed as Record<string, unknown>;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Verifies the Cloudflare Access JWT in `Cf-Access-Jwt-Assertion` (ADR 0001).
 * RS256 only · JWKS cached ≤ 10 min · unknown kid → one refetch (rate limited) → reject ·
 * iss = team origin · aud ∩ configured ≠ ∅ · exp/nbf ± 60 s · exactly one principal kind.
 */
export class AccessJwtProvider implements IdentityProvider {
  readonly origin: string;
  private readonly audiences: ReadonlySet<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private keys = new Map<string, CryptoKey>();
  private fetchedAt = 0;
  private lastFailureAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(options: AccessJwtOptions) {
    this.origin = parseTeamOrigin(options.teamDomain);
    this.audiences = new Set(parseAudiences(options.audiences));
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private async refreshKeys(): Promise<void> {
    if (!this.inflight) {
      this.inflight = (async () => {
        const res = await this.fetchImpl(`${this.origin}/cdn-cgi/access/certs`, {
          signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
        const body = (await res.json()) as { keys?: Array<Record<string, unknown>> };
        const next = new Map<string, CryptoKey>();
        for (const jwk of body.keys ?? []) {
          if (jwk.kty !== "RSA" || !nonEmptyString(jwk.kid) || !nonEmptyString(jwk.n) || !nonEmptyString(jwk.e)) continue;
          const key = await subtle.importKey(
            "jwk",
            { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["verify"],
          );
          next.set(jwk.kid, key);
        }
        this.keys = next;
        this.fetchedAt = this.now();
      })().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async keyFor(kid: string): Promise<CryptoKey | undefined> {
    const now = this.now();
    const age = now - this.fetchedAt;
    if (this.fetchedAt === 0 || age > JWKS_TTL_MS) {
      const withinGrace = this.fetchedAt !== 0 && age <= JWKS_TTL_MS + JWKS_STALE_GRACE_MS;
      const backingOff = now - this.lastFailureAt < MIN_REFETCH_INTERVAL_MS;
      if (!(withinGrace && backingOff)) {
        try {
          await this.refreshKeys();
        } catch (error) {
          this.lastFailureAt = this.now();
          // Stale-if-error (ADR 0001): public keys already fetched from the team origin stay usable for a
          // bounded grace period when a scheduled refresh fails. No keys, or past the grace → 503.
          if (!withinGrace) throw error;
          log("warn", "access keys refresh failed; using cached keys", {
            err: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    let key = this.keys.get(kid);
    if (!key && this.now() - this.fetchedAt > MIN_REFETCH_INTERVAL_MS) {
      try {
        await this.refreshKeys();
      } catch {
        return undefined;
      }
      key = this.keys.get(kid);
    }
    return key;
  }

  async verify(headers: IncomingHttpHeaders): Promise<IdentityResult> {
    const reject = (status: 401 | 403 | 503, reason: string): IdentityResult => ({
      ok: false,
      rejection: { status, reason },
    });

    const token = headers["cf-access-jwt-assertion"];
    if (typeof token !== "string" || token.length === 0) return reject(401, "identity_missing");
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((p) => p.length === 0)) return reject(401, "token_malformed");
    const [h, p, s] = parts as [string, string, string];

    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = b64urlJson(h);
      payload = b64urlJson(p);
    } catch {
      return reject(401, "token_malformed");
    }
    if (header.alg !== "RS256" || !nonEmptyString(header.kid)) return reject(401, "token_algorithm");

    let key: CryptoKey | undefined;
    try {
      key = await this.keyFor(header.kid);
    } catch (error) {
      log("error", "access keys unavailable", { err: error instanceof Error ? error.message : String(error) });
      return reject(503, "keys_unavailable");
    }
    if (!key) return reject(401, "token_key_unknown");

    const valid = await subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlToBytes(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!valid) return reject(401, "token_signature");

    const nowS = Math.floor(this.now() / 1000);
    if (payload.iss !== this.origin) return reject(401, "token_issuer");
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.some((a) => typeof a === "string" && this.audiences.has(a))) return reject(401, "token_audience");
    if (typeof payload.exp !== "number" || payload.exp + SKEW_SECONDS < nowS) return reject(401, "token_expired");
    if (typeof payload.nbf === "number" && payload.nbf - SKEW_SECONDS > nowS) return reject(401, "token_not_yet_valid");

    const hasEmail = nonEmptyString(payload.email);
    const hasCommonName = nonEmptyString(payload.common_name);
    if (hasEmail && !hasCommonName) {
      const email = (payload.email as string).trim();
      if (!EMAIL_PATTERN.test(email)) return reject(403, "principal_invalid");
      return { ok: true, principal: userPrincipal(email) };
    }
    if (hasCommonName && !hasEmail) {
      return { ok: true, principal: servicePrincipal(payload.common_name as string) };
    }
    return reject(403, "principal_ambiguous");
  }
}
