# mcp-depot

A depot of small, independent **MCP servers**. Each site picks the servers it needs and deploys only those;
an MCP server portal (we use Cloudflare's) puts the chosen servers behind one endpoint for AI clients.

> **Status: phase 1 (pre-pilot).** `core` and the first server (`zabbix`) are implemented and tested against
> fixtures. Nothing is deployed yet. Contracts: ADRs 0001–0003.

## Ideas in one screen
- **One server, one job.** Each server wraps one system or capability and runs on its own. No hub, no shared
  role tokens, no server waits for another.
- **Identity is a person.** Every request carries a Cloudflare Access JWT that the server itself verifies.
  The principal is `user:<email>` or `service:<name>`, the same whether the client connects directly or through
  the portal. → [ADR 0001](docs/decisions/0001-identity-cloudflare-access-jwt.md)
- **Default deny.** Access decides who reaches a server; role rules in git decide what a role may do; a
  per-site membership file (never in git) decides who holds which role. Every tool goes through one guard.
  → [ADR 0002](docs/decisions/0002-permissions-default-deny.md)
- **Every server declares itself.** A manifest lists its tools, read/write, data class, runtime and status;
  CI rejects anything undeclared. → [ADR 0003](docs/decisions/0003-server-manifest.md) ·
  current servers: [docs/servers.md](docs/servers.md)
- **Pick per site.** One image per server; a site enables servers with Compose profiles.
  Site configuration lives in a separate private repository, never here. → [docs/deploy.md](docs/deploy.md)

## Vocabulary
| Term | Meaning |
|---|---|
| server | One MCP server in this repo (`servers/<name>/`). Cloudflare calls it an *MCP server* / *upstream*. |
| deployment | One server running at one site. Its portal *Server ID* is `<site>-<server>`. |
| core | Shared library: identity, guard, audit, MCP transport. |
| portal | The MCP server portal in front of deployments. Not part of this repo. |

Words we avoid for our own parts, to stay clear of portal terms: *gateway*, *hub*, *connector*, *portal*.

## Layout
```
packages/core/         identity · guard · audit · MCP transport (Node 22, TypeScript)
servers/<name>/        manifest.yaml · roles.yaml · src/ · test/
templates/             scaffold used by `npm run new-server`
schemas/               JSON Schemas: manifest, roles, members
compose/               one Compose fragment per server; profile = server name; no host ports
docs/                  decisions (ADRs) · servers.md (generated) · deploy.md
scripts/               check · catalogue · new-server
```

## Working on it
```
npm ci
npm run build
npm test            # core + every server, fixtures only
npm run check       # depot rules: manifests, tools = manifest, no ports, guard-only, catalogue fresh
npm run new-server -- <name>
```

## Contributing
New servers are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first; security issues go through
[SECURITY.md](SECURITY.md).

## License
[Apache-2.0](LICENSE)
