#!/usr/bin/env node
// Depot rules that tests alone do not cover (ADR 0001–0003). Run after `npm run build`.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CATALOGUE_PATH, renderCatalogue, serverNames } from "./catalogue.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const core = await import(pathToFileURL(join(root, "packages/core/dist/src/index.js")).href);

const errors = [];
const warnings = [];
const fail = (msg) => errors.push(msg);

function files(dir, ext) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? files(path, ext) : path.endsWith(ext) ? [path] : [];
  });
}

// Patterns a server must never contain: transport, identity and permission belong to core only.
const FORBIDDEN = [
  [/@modelcontextprotocol\/sdk/, "imports the MCP SDK directly; register tools through @mcp-depot/core"],
  [/from\s+["'](node:)?https?["']/, "opens its own HTTP server; core owns the transport"],
  [/cf-access|Cf-Access|CF-Access/, "touches Cloudflare Access headers; identity belongs to core"],
  [/\bnew\s+Guard\b|\bAccessJwtProvider\b/, "builds its own guard or identity provider"],
];

const names = serverNames();
if (names.length === 0) fail("no servers found");

for (const name of names) {
  const dir = join(root, "servers", name);
  for (const required of ["manifest.yaml", "roles.yaml", "package.json", "test", "src/definition.ts"]) {
    if (!existsSync(join(dir, required))) fail(`servers/${name}: missing ${required}`);
  }
  if (!existsSync(join(root, "compose", `${name}.yml`))) fail(`servers/${name}: missing compose/${name}.yml`);

  try {
    const manifest = core.loadManifest(join(dir, "manifest.yaml"));
    if (manifest.name !== name) fail(`servers/${name}: manifest name '${manifest.name}' differs from folder`);
    core.loadRoles(join(dir, "roles.yaml"), manifest);
    if (manifest.status === "deprecated" && manifest.deprecated_since) {
      const days = (Date.now() - Date.parse(manifest.deprecated_since)) / 86_400_000;
      if (days > 90) warnings.push(`servers/${name}: deprecated for ${Math.floor(days)} days; a removal PR is expected`);
    }
    if (["personal", "financial"].includes(manifest.data_class) && manifest.status === "stable") {
      warnings.push(`servers/${name}: ${manifest.data_class} data — confirm a maintainer reviewed its scopes`);
    }
  } catch (error) {
    fail(`servers/${name}: ${error.message}`);
    continue;
  }

  // Code implements exactly the manifest's tools (loadServer throws otherwise).
  const defPath = join(dir, "dist/src/definition.js");
  if (!existsSync(defPath)) {
    fail(`servers/${name}: not built (run npm run build)`);
  } else {
    try {
      const mod = await import(pathToFileURL(defPath).href);
      if (typeof mod.fixtureDefinition !== "function") fail(`servers/${name}: definition.ts must export fixtureDefinition()`);
      else core.loadServer(mod.fixtureDefinition());
    } catch (error) {
      fail(`servers/${name}: ${error.message}`);
    }
  }

  for (const file of files(join(dir, "src"), ".ts")) {
    const text = readFileSync(file, "utf8");
    for (const [pattern, why] of FORBIDDEN) {
      if (pattern.test(text)) fail(`${relative(root, file)}: ${why}`);
    }
  }
}

// Compose fragments: one per server, profile = name, never publish host ports.
for (const file of files(join(root, "compose"), ".yml")) {
  const name = file.split("/").pop().replace(/\.yml$/, "");
  const text = readFileSync(file, "utf8");
  if (!names.includes(name)) fail(`${relative(root, file)}: no matching server`);
  if (/^\s*ports\s*:/m.test(text)) fail(`${relative(root, file)}: publishes host ports (ADR 0001)`);
  if (!new RegExp(`profiles:\\s*\\[\\s*${name}\\s*\\]`).test(text)) fail(`${relative(root, file)}: profile must be [${name}]`);
}

// Generated catalogue must be current.
const current = existsSync(CATALOGUE_PATH) ? readFileSync(CATALOGUE_PATH, "utf8") : "";
if (current !== renderCatalogue()) fail("docs/servers.md is stale — run npm run catalogue");

for (const w of warnings) console.warn(`warning: ${w}`);
if (errors.length > 0) {
  for (const e of errors) console.error(`error: ${e}`);
  process.exit(1);
}
console.log(`check ok — ${names.length} server(s)`);
