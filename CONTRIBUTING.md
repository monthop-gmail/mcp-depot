# Contributing to mcp-depot

Thanks for helping. The depot grows one server at a time, so most contributions are new servers.

## Before you start
Read `AGENTS.md` and ADRs 0001–0003. They are short and they are the rules CI enforces.

## Adding a server
1. Open an issue with a draft `manifest.yaml`: what system it wraps, each tool, read or write, data class.
   Read-only first; write tools need a strong reason.
2. Scaffold with `npm run new-server -- <name>`. Implement tools in `src/tools.ts`; `core` handles identity,
   permissions and audit — do not touch those in the server.
3. Fill in `roles.yaml` (and `scope_keys` if the upstream data must be partitioned), a fixture backend, and
   tests. `fixtureDefinition()` must run without any real upstream. Fixtures must be synthetic. If `roles.yaml`
   declares `scope_keys`, add `test/scope.test.ts` proving no tool leaks data across scopes.
4. `npm run build && npm test && npm run catalogue && npm run check`, then open a PR. CI repeats these and
   builds the server's image.

## Ground rules
- No secrets, tokens, real emails, customer or site names anywhere — code, fixtures, docs, commit messages.
- Do not change `packages/core/`, `templates/`, `schemas/`, `.github/` or ADRs in the same PR as a new server.
- One server per PR.

## License
By contributing you agree that your contribution is licensed under the Apache License 2.0 (see `LICENSE`).
