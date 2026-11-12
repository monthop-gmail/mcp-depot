# mcp-depot

A depot of small, independent **MCP servers**. Each site picks the servers it needs and deploys only those;
an MCP server portal (we use Cloudflare's) puts the chosen servers behind one endpoint for AI clients.

> **Status: design phase.** No runnable code yet. The contracts below are under review; the first pilot
> server follows once they are accepted.

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
  CI rejects anything undeclared. → [ADR 0003](docs/decisions/0003-server-manifest.md)
- **Pick per site.** Build one image per server; a site enables servers with Compose profiles.
  Site configuration lives in a separate private repository, never here.

## Vocabulary
| Term | Meaning |
|---|---|
| server | One MCP server in this repo (`servers/<name>/`). Cloudflare calls it an *MCP server* / *upstream*. |
| deployment | One server running at one site. Its portal *Server ID* is `<site>-<server>`. |
| core | Shared library: identity, guard, audit, MCP transport. |
| portal | The MCP server portal in front of deployments. Not part of this repo. |

Words we avoid for our own parts, to stay clear of portal terms: *gateway*, *hub*, *connector*, *portal*.

## Layout (planned)
```
packages/core/         identity · guard · audit · MCP transport
servers/<name>/        manifest.yaml · roles.yaml · src/ · test/
templates/server/      scaffold for a new server
schemas/               JSON Schemas (manifest; roles and members to follow)
compose/               one Compose profile per server; no host ports
docs/decisions/        ADRs
```

## Contributing
New servers are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first; security issues go through
[SECURITY.md](SECURITY.md).

## License
[Apache-2.0](LICENSE)
