# AGENTS.md — rules for AI and human contributors
last_reviewed: 2026-11-12

## What this repo is
A depot of independent MCP servers plus one shared `core`. ADRs 0001–0003 in `docs/decisions/` are the
contract. Read them before writing code. Current servers: `docs/servers.md` (generated).

## Search before you create
- Identity, guard, audit and transport belong in `packages/core/` only. A server never verifies tokens,
  checks roles or writes audit lines itself; it exports tool definitions and `fixtureDefinition()`.
- New server → `npm run new-server -- <name>`; do not start from another server's folder.
- Server `src/` imports only `@mcp-depot/core` (public entry). `@mcp-depot/core/internal` and
  `@mcp-depot/core/testing` are for tests. Test helpers: `startTestServer`, signed test JWTs.
- `rg` for an existing helper before adding one.

## Invariants
- Every MCP request is authenticated by `core` from `Cf-Access-Jwt-Assertion` only (ADR 0001). No anonymous path.
- Default deny; every tool registered through `core`'s guard; scopes applied in the upstream query (ADR 0002).
- Every server has a valid `manifest.yaml`; `tools/list` equals the manifest; write tools are off by default (ADR 0003).
- Tool names carry no server prefix.
- Compose fragments publish no host ports.
- Fixtures are synthetic. No customer, site, host or person names in code, docs, fixtures or commit messages.
- No secrets, tokens, membership files or real emails in git. Secret and config **names** only.

## Vocabulary
server · deployment · core · portal (see README). Do not name anything of ours *gateway*, *hub*, *connector* or *portal*.

## Definition of done
`npm run build && npm test && npm run check` green · `npm run catalogue` committed · `CHANGES.md` entry ·
README/ADR updated in the same PR · new ADR for any new decision or any relaxed invariant ·
bump `last_reviewed` when you touch this file.

## `npm run check` is not a security boundary
It catches mistakes. Code-owner review is what stops a deliberately harmful change — review server PRs as if
the check did not exist.

## Humans approve
AI may open PRs; a maintainer reviews and merges. Changes under `packages/core/`, `templates/`, `schemas/`,
`.github/` and `docs/decisions/` need the code owner.
