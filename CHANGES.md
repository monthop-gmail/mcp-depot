# Changes

## Unreleased — phase 1 (pre-pilot)
- `packages/core`: Cloudflare Access JWT verification (ADR 0001), three-layer default-deny guard with
  runtime manifest enforcement and file membership that reloads per request and fails closed (ADR 0002),
  audit JSON lines, stateless Streamable HTTP MCP endpoint with Host/Origin allowlist, no CORS, body limit,
  refuse-to-start on bad configuration; `@mcp-depot/core/testing` helpers.
- `servers/zabbix`: three read-only tools; host-group scope pushed into Zabbix queries; synthetic fixture.
- `templates/` + `npm run new-server`, `npm run check` (depot rules), `npm run catalogue` → `docs/servers.md`.
- `schemas/roles.schema.json`, `schemas/members.schema.json`; Dockerfile (one image per server);
  `compose/zabbix.yml`; CI (pinned actions, `pull_request` only, image build without push); `docs/deploy.md`.
- ADR 0002 example updated to the implemented `scope_keys` format.

## Design phase
- Repository created: README, AGENTS.md, CONTRIBUTING, SECURITY, CODEOWNERS, Apache-2.0 license.
- ADR 0001 identity (Cloudflare Access JWT verified by every server), ADR 0002 permissions (three layers,
  default deny, one guard), ADR 0003 server manifest — all *Proposed*.
- `schemas/server-manifest.schema.json` with one example manifest.
- Review round 1: ADR 0001 — exact AUD allowlist, refuse to start when unconfigured, per-vendor client paths
  (portal only when a client cannot complete Access), revocation via membership and Access session revoke,
  testable phase 1 gate. ADR 0002 — guard enforces manifest `default_enabled` at runtime, audit stays at the
  site with per-site retention (default 90 days), no secret left in running containers. `repo.yaml` (schema 0.2).
