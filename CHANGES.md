# Changes

## Unreleased — design phase
- Repository created: README, AGENTS.md, CONTRIBUTING, SECURITY, CODEOWNERS, Apache-2.0 license.
- ADR 0001 identity (Cloudflare Access JWT verified by every server), ADR 0002 permissions (three layers,
  default deny, one guard), ADR 0003 server manifest — all *Proposed*.
- `schemas/server-manifest.schema.json` with one example manifest.
- Review round 1: ADR 0001 — exact AUD allowlist, refuse to start when unconfigured, per-vendor client paths
  (portal only when a client cannot complete Access), revocation via membership and Access session revoke,
  testable phase 1 gate. ADR 0002 — guard enforces manifest `default_enabled` at runtime, audit stays at the
  site with per-site retention (default 90 days), no secret left in running containers. `repo.yaml` (schema 0.2).
