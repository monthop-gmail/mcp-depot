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
- Review round 2 (PR #2): core split into a narrow public entry and `@mcp-depot/core/internal`; servers' src
  may import only the public entry. `check` parses compose YAML (no ports/network_mode/pid/ipc/privileged/
  cap_add/devices/host volumes; read_only, cap_drop ALL, no-new-privileges, network depot required), scans
  every source extension, forbids dynamic import/require, and requires `test/scope.test.ts` when a server
  declares scope_keys. Guard refuses `"*"` scopes for personal/financial data. `startTestServer` helper.
  zabbix: out-of-scope group names and hosts on shared triggers are no longer returned; https only unless
  `ZABBIX_ALLOW_HTTP=true`. JWKS stale-if-error for 60 minutes past TTL. `pretest` builds before tests.
- Dockerfile: optional `servers/<name>/apt-packages.txt` (validated package names) installed in that server's image only.
- `servers/zktime` (experimental, `data_class: personal`): six read-only tools over ZKTime 5 attendance
  (`get_status`, `list_departments`, `list_devices`, `list_employees`, `list_punches`, `inspect_schema`);
  backends `fixture` · `mdb` (att2000.mdb via mdb-tools, read-only mount; `apt-packages.txt`: mdb-tools) ·
  `mssql` (SELECT-only login), chosen by `ZKTIME_MODE`. Roles `viewer` and `diagnostics`; the `departments`
  scope lists department names explicitly (no `"*"` for personal data), is resolved to ids once per call and
  applied in the query (bound `IN (@d0, …)` parameters on SQL Server; row filter while parsing on mdb, which
  has no WHERE); `test/scope.test.ts` covers every tool. No biometrics, passwords, SSN, `CommPassword`, card
  numbers or gender; punches need a `from`/`to` range of at most 31 days and are row-limited. `compose/zktime.yml`.
  zktime SQL Server: `ZKTIME_MSSQL_ENCRYPT` defaults to true (false logs a warning); new `ZKTIME_MSSQL_TRUST_SERVER_CERT` (default true, false verifies the certificate).
- `servers/rag` (experimental, `data_class: internal`): full-text search over a site's document folder —
  `get_status`, `list_sources`, `search`, `get_chunk` (read) and `reindex` (write, `default_enabled: false`).
  SQLite FTS5 trigram index (better-sqlite3) with Thai normalisation (detached vowel/tone marks folded);
  PDF text via pdftotext (`apt-packages.txt`: poppler-utils). Roles `reader` and `indexer`; the `folders` scope
  (path prefixes) is bound into every SQL query as `path = ? OR (path LIKE ? ESCAPE '\' AND instr(path, ?) = 1)`
  — wildcards escaped, case-sensitive, folder boundary kept; out-of-scope chunks answer "not found".
  Prefixes with `..` or absolute paths are rejected; documents are read only under the realpath of
  `RAG_DOCS_DIR` (symlinks leading outside are not indexed). `compose/rag.yml` (docs `:ro`, index on a
  writable bind directory). Not included: OCR and GitHub ingest.
  rag: documents are indexed under their real path below the docs root (never a symlink's name) and each real file once, so a link cannot move a document into another folder's scope.
  rag: symlinks below the docs root are never followed (counted as `link_count`, was `outside_root_count`).
  rag: an index built with another `INDEX_VERSION` is dropped and rebuilt on first use; `get_status` adds
  `unmatched_folders` — the member's own scope prefixes that match no indexed document.

## Design phase
- Repository created: README, AGENTS.md, CONTRIBUTING, SECURITY, CODEOWNERS, Apache-2.0 license.
- ADR 0001 identity (Cloudflare Access JWT verified by every server), ADR 0002 permissions (three layers,
  default deny, one guard), ADR 0003 server manifest — all *Proposed*.
- `schemas/server-manifest.schema.json` with one example manifest.
- Review round 1: ADR 0001 — exact AUD allowlist, refuse to start when unconfigured, per-vendor client paths
  (portal only when a client cannot complete Access), revocation via membership and Access session revoke,
  testable phase 1 gate. ADR 0002 — guard enforces manifest `default_enabled` at runtime, audit stays at the
  site with per-site retention (default 90 days), no secret left in running containers. `repo.yaml` (schema 0.2).
