# Contributing to mcp-depot

Thanks for helping. The depot grows one server at a time, so most contributions are new servers.

## Before you start
Read `AGENTS.md` and ADRs 0001–0003. They are short and they are the rules CI enforces.

## Adding a server
1. Open an issue with a draft `manifest.yaml`: what system it wraps, each tool, read or write, data class.
   Read-only first; write tools need a strong reason.
2. Once the template exists, scaffold from `templates/server/` and register tools only through `core`'s guard.
3. Provide `roles.yaml` and fixture-mode tests. Fixtures must be synthetic.
4. Open a PR. CI checks the manifest, compares `tools/list` with it, and runs the permission tests.

## Ground rules
- No secrets, tokens, real emails, customer or site names anywhere — code, fixtures, docs, commit messages.
- Do not change `packages/core/`, `templates/`, `schemas/`, `.github/` or ADRs in the same PR as a new server.
- One server per PR.

## License
By contributing you agree that your contribution is licensed under the Apache License 2.0 (see `LICENSE`).
