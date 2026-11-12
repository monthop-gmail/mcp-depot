# ADR 0001 — Identity: every server verifies a Cloudflare Access JWT on every request
Status: Proposed (phase 0 review) · Supersedes: shared role tokens + self-hosted OAuth of the predecessor hub

## Context
The predecessor hub issued one shared bearer token per role (IT / admin / accounting) through its own OAuth
page. The access token handed to clients *was* that shared token, so every person looked identical downstream,
one person could not be revoked without rotating everyone, and grants lived in process memory.
mcp-depot drops role tokens entirely. Each server is published on its own and aggregated by a Cloudflare
MCP server portal; identity must mean *a person* (or a named automation), the same way whether a client
connects directly or through the portal.

## Decision
1. **Entry.** One deployment = one hostname behind Cloudflare Tunnel + one Cloudflare Access application
   with Managed OAuth + one server entry in the MCP server portal with *Require user auth* on.
   Servers do **not** implement an OAuth server.
2. **Verification in `core`, every MCP request.** Read only the `Cf-Access-Jwt-Assertion` header.
   - Algorithm pinned to `RS256`; reject `none`, `HS*` and anything else.
   - Keys from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`; cache ≤ 10 min; unknown `kid`
     → refetch once → still unknown → reject. Team domain must be `https` and end with `.cloudflareaccess.com`.
   - `iss` = team origin · `aud`: the deployment configures an allowlist of exact AUD values; the token's `aud`
     (string or list) must contain at least one of them (whether the portal presents a different `aud` is
     proven in phase 1) · `exp` / `nbf` with ≤ 60 s skew.
   - Missing or malformed team domain / AUD → the server **refuses to start**; if it is somehow running
     unconfigured, every request gets 403. Keys unavailable → 503. Never fall through to "allow".
3. **Principal.** Exactly one of:
   - `user:<email>` — `email` present and no `common_name`; email lower-cased and trimmed.
   - `service:<common_name>` — `common_name` present and no `email` (Access service token). Looked up in the
     service table by `common_name` only; never mapped to a person.
   - anything else → reject. There is no anonymous principal and no fallback.
4. **Trust boundary.** Ignore `Cf-Access-Authenticated-User-Email` and every other identity header. Never take
   identity from tool arguments (e.g. an approval tool uses the principal from context, not an `approver` field).
5. **Hygiene.** Never log the JWT or any `Cf-Access-*` header. Never forward Access headers or service-token
   secrets to upstream systems.
6. **Network.** Server containers publish **no host ports**; they are reachable only through the tunnel
   (cloudflared on the same network). `/healthz` is unauthenticated and returns no data. Enforce a Host/Origin
   allowlist (DNS rebinding); never send `Access-Control-Allow-Origin: *`.
7. **Pluggable.** `core` exposes `IdentityProvider.verify(request) → Principal | Rejection`. Cloudflare Access is
   the only implementation for now; others (e.g. generic OIDC) need their own ADR.

## Why
Verifying at the server makes location irrelevant: a server is equally safe on a site LAN or on a public cloud
origin, and direct vs. portal connections yield the same principal. Access already handles login, MFA and
central revocation, so no server re-implements OAuth.

## Client paths
Each client path is tested and recorded per vendor: portal · desktop clients that can reach Access directly ·
each web chat connector. **A client that cannot complete Access directly uses the portal only.** No exception
path (shared token, IP allowlist, header bypass) is ever opened for it.

## Revocation
Two levers, both measured: removing a member from the site membership file (ADR 0002, takes effect on the next
request) and removing the person from the Access group **plus revoking their active Access sessions**. Access
application session duration is kept short (hours, not days); the chosen value is recorded per deployment.

## Trade-offs
- Depends on Cloudflare Access (mitigated by item 7).
- Revocation through Access alone is not instant: removing someone from an Access group does not end sessions
  already issued, hence the session revoke step and short session duration above.
- Web chat connectors reaching Access directly is unproven; see *Client paths*.
- LAN users must also come through the tunnel; there is no "trusted LAN".

## Phase 1 gate (must pass on one pilot deployment)
- No JWT → rejected · wrong `aud` → rejected · unconfigured server does not start.
- Direct request from the host or LAN to the container without JWT → unreachable or 401/403 (a test, not prose).
- The same person gets the same `user:` principal in audit via a direct client and via the portal.
- Service token → `service:` principal.
- Per-vendor client path table filled in (see *Client paths*).
- Revocation time measured for both levers (see *Revocation*).

## Change
Another identity provider, or relaxing any rule above, requires a new ADR superseding this one.
