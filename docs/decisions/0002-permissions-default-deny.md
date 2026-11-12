# ADR 0002 — Permissions: three layers, default deny, one guard
Status: Proposed (phase 0 review) · Supersedes: none

## Decision
**Three layers, each answering one question.**

| Layer | Question | Where it lives |
|---|---|---|
| L1 Access policy / group | Who can reach this deployment at all? | Cloudflare Access (central; the kill switch) |
| L2 Role rules | What may a role do on this server? | `servers/<name>/roles.yaml` — in git, reviewed by PR |
| L3 Membership | Which principal holds which role (and scope) at this site? | `members.yaml` mounted read-only at deploy — **never in git** |

Membership is personal data and this repository is public, so L3 never enters any repository.

**Rules**
1. **Default deny.** A principal absent from L3 is denied every tool. A tool absent from a role in L2 is denied.
   Passing L1 grants nothing by itself.
2. **One guard.** Every tool is registered through `core`'s guard; a server cannot register a tool any other way.
   CI fails if it does (see ADR 0003).
3. **Scopes filter at query time.** Scope parameters from L3 (e.g. allowed host groups, allowed document folders)
   are passed to the tool in its context and applied in the upstream query, never by filtering results afterwards.
4. **Writes are explicit.** A write tool needs a role that names it, and is also off by default in the manifest.
   The guard reads the manifest at runtime too: a tool marked `default_enabled: false` stays unregistered unless
   the deployment enables it explicitly, whatever the roles say.
5. **Approvals bind to people.** Any approve/confirm tool records the principal from context; the approver must
   not be the requester.
6. **Services are separate.** `service:` principals have their own entries and never inherit a person's roles.
7. **Reload without restart.** L3 changes take effect on the next request (file watch or signal); the time is
   measured in the phase 1 gate together with L1 revocation.

## File formats (examples use placeholders only)
```yaml
# servers/<name>/roles.yaml  (git)
roles:
  viewer:
    tools: [get_active_problems, get_device_status]
    scopes: [host_groups]          # scope keys this role must be given in members.yaml
```
```yaml
# members.yaml  (site, mounted read-only, not in git)
members:
  "user:alice@example.com":
    roles: [viewer]
    scopes: { host_groups: ["Servers", "Switches"] }
  "service:example-bot.access":
    roles: [viewer]
    scopes: { host_groups: ["Servers"] }
```

## Audit
One JSON line per call: time · server · deployment · principal · client label (as declared by the client,
flagged unverified) · tool · decision (allow/deny + reason code) · outcome · duration.
Never: tokens, JWTs, `Cf-Access-*` headers, request or response bodies (hashed arguments only when a server opts in).

Audit lines contain email addresses, so they are personal data: they stay at the site (local file or the site's
log store), never in git, issues or public CI logs. Retention is set per site and recorded with the site's
settings; default 90 days.

## Least privilege beyond the guard
A guard bug must not equal full power of the upstream account. Upstream service accounts are read-only wherever
the server's tools are read-only (e.g. a monitoring API user with a read-only role, not a super-admin token).
Each server container receives only its own secrets file, and disabling a server's profile removes its
container, so no secret stays loaded in a container that keeps running.

## Tests required in `core` and every server
For each tool in `tools/list`: denied for a principal with no membership · denied for a member without the role ·
allowed for a member with the role. Removing a member takes effect without restart.

## Trade-offs
Membership is per site, so one person may be listed in several files. A central membership source can replace
the file loader later without touching servers, because `core` reads membership through one interface.
