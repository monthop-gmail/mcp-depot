# ADR 0003 — Every server ships a manifest; CI enforces it
Status: Proposed (phase 0 review) · Supersedes: none

## Context
mcp-depot grows by adding servers whenever a need appears, including from outside contributors. Without a
contract, the depot fills with servers nobody can explain: what they touch, whether they write, whether they
are still used.

## Decision
Each server lives in `servers/<name>/` with a `manifest.yaml` validated against
`schemas/server-manifest.schema.json`. Fields:

- `name` — kebab-case, unique; becomes the suffix of the portal Server ID (`<site>-<name>`).
- `summary`, `owner` (GitHub handle), `status` (`experimental` · `stable` · `deprecated`) and
  `deprecated_since` (required when deprecated).
- `runtime` — `site` (needs site network/data) · `cloud` · `any`.
- `data_class` — highest class any tool touches: `public` · `internal` · `personal` · `financial`.
- `tools[]` — `name`, `access` (`read` · `write`), optional `data_class`, `default_enabled`, `summary`.
- `secrets[]` / `config[]` — environment variable **names only**.
- `upstreams[]` — systems the server talks to (descriptive).

**Tool names carry no server prefix.** The portal already namespaces tools as `<server_id>_<tool>`.

**Defaults tied to data class**
- `personal` / `financial`: roles must list tools explicitly (no wildcard), and the server is `experimental`
  until a maintainer reviews its scopes.
- Any `access: write` tool: `default_enabled: false`. Enabling it by default needs its own ADR.

**CI (phase 1)**
1. Manifest validates against the schema, and no tool name starts with `<server name>_`.
2. Fixture-mode start: `tools/list` equals the manifest's enabled tools — nothing undeclared.
3. Server source imports only the public `@mcp-depot/core` entry (no `/internal`, `/testing`, MCP SDK,
   network server modules, dynamic `import()` or `require`); transport, identity and membership are not
   reachable from it. A server with `scope_keys` has `test/scope.test.ts` (ADR 0002).
4. Compose fragments are parsed, not pattern-matched: one service named after the server, profile = name,
   `read_only`, `cap_drop: [ALL]`, `no-new-privileges`, network `depot` only; no `ports`, `network_mode`,
   `pid`, `ipc`, `privileged`, `cap_add`, `devices` or host-exposing volumes.
5. `docs/servers.md` (the depot catalogue) is generated from manifests; a stale file fails CI.
6. `deprecated` for more than 90 days → CI warns; a removal PR is expected.

These checks catch mistakes, not malice. The gate against a deliberately harmful change is code-owner
review of every PR.

## Why
The manifest is what lets a maintainer review an outside PR without reading every line, lets each site choose
what to enable, and lets any AI session learn what the depot contains from one generated page.

## Change
New fields are additive. Removing a field or a CI rule needs a superseding ADR.
