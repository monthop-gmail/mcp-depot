import type { IncomingHttpHeaders } from "node:http";

/** A verified caller. Never built from anything the client can assert about itself. */
export type Principal =
  | { kind: "user"; id: `user:${string}`; email: string }
  | { kind: "service"; id: `service:${string}`; commonName: string };

export interface Rejection {
  status: 401 | 403 | 503;
  /** Stable machine-readable code, safe to log and to return. */
  reason: string;
}

export type IdentityResult = { ok: true; principal: Principal } | { ok: false; rejection: Rejection };

export interface IdentityProvider {
  verify(headers: IncomingHttpHeaders): Promise<IdentityResult>;
}

export function userPrincipal(email: string): Principal {
  const normalized = email.trim().toLowerCase();
  return { kind: "user", id: `user:${normalized}`, email: normalized };
}

export function servicePrincipal(commonName: string): Principal {
  const cn = commonName.trim();
  return { kind: "service", id: `service:${cn}`, commonName: cn };
}
