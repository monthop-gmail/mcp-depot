# Deploying a server at a site

One deployment = one server at one site. Site-specific values live in the private site-settings repository,
never in this one.

## Once per host
- A Docker network named `depot`, and `cloudflared` attached to it (the tunnel is the only way in).

## Per deployment
1. **Hostname** — add a public hostname on the site's tunnel pointing to `http://<server>:8080`.
2. **Access application** (self-hosted) on that hostname:
   - enable Managed OAuth so the portal can authorize per user;
   - policy: the Access group(s) allowed to reach this server;
   - session duration: hours, not days (record the value with the site settings);
   - copy the application's **AUD** tag.
3. **Portal** — add the server to the MCP server portal: Server ID `<site>-<server>`, OAuth, *Require user auth* on.
4. **Secrets** — `secrets/<server>.env` on the host with the upstream credentials named in the manifest.
   Use a dedicated least-privilege upstream account (read-only for read-only servers).
5. **Members** — `members/<server>.yaml` on the host (format: `schemas/members.schema.json`). Never committed.
6. **Compose** — `compose/<server>.yml` with `COMPOSE_PROFILES=<server>` and the variables it asks for.
7. **Verify** (ADR 0001 phase 1 gate): no JWT → 401 from the host itself · wrong host → 403 · a member sees
   only their tools and scope · same principal in audit via a direct client and via the portal · removing a
   member applies on the next request · Access group removal + session revoke measured.

## Configuration read by core
| Variable | Required | Meaning |
|---|---|---|
| `ACCESS_TEAM_DOMAIN` | yes | `<team>.cloudflareaccess.com` |
| `ACCESS_AUD` | yes | AUD tag(s) of this deployment's Access application, comma-separated |
| `ALLOWED_HOSTS` | yes | public hostname(s) of this deployment |
| `MEMBERS_PATH` | yes | mounted members file |
| `DEPLOYMENT` | no | label in audit, e.g. `<site>-<server>` |
| `AUDIT_PATH` | no | audit file at the site; default stdout (container log) |
| `ENABLED_TOOLS` | no | default-off tools this deployment enables, comma-separated |
| `PORT` | no | default 8080 |

Missing or malformed required values stop the server at start.
