#!/usr/bin/env node
// Depot rules that tests alone do not cover (ADR 0001–0003). Run after `npm run build`.
// This catches mistakes, not malice: a determined author can still write code that misbehaves.
// The real gate is code-owner review (CODEOWNERS) — keep reviews honest, don't rely on this script alone.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { CATALOGUE_PATH, renderCatalogue, serverNames } from "./catalogue.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const core = await import(pathToFileURL(join(root, "packages/core/dist/src/internal.js")).href);

const errors = [];
const warnings = [];
const fail = (msg) => errors.push(msg);
const rel = (p) => relative(root, p);

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

// Server source may use only the public core API. Transport, identity and membership belong to core.
const SOURCE_EXT = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/;
const FORBIDDEN_SOURCE = [
  [/@modelcontextprotocol\/sdk/, "uses the MCP SDK directly; register tools through @mcp-depot/core"],
  [/@mcp-depot\/core\/[A-Za-z]/, "imports a core subpath (internal/testing/dist); servers' src may import only '@mcp-depot/core'"],
  [/packages\/core/, "reaches into core's files; import '@mcp-depot/core' instead"],
  [/["'](node:)?(http|https|http2|net|tls|dgram)["']/, "uses a network server module; core owns the transport"],
  [/\bimport\s*\(/, "uses dynamic import(); imports must be static so this check can see them"],
  [/\brequire\s*\(|\bcreateRequire\b/, "uses require(); imports must be static ES imports"],
  [/cf-access/i, "touches Cloudflare Access headers; identity belongs to core"],
];

const names = serverNames();
if (names.length === 0) fail("no servers found");

for (const name of names) {
  const dir = join(root, "servers", name);
  for (const required of ["manifest.yaml", "roles.yaml", "package.json", "test", "src/definition.ts", "src/index.ts"]) {
    if (!existsSync(join(dir, required))) fail(`servers/${name}: missing ${required}`);
  }

  let roles;
  try {
    const manifest = core.loadManifest(join(dir, "manifest.yaml"));
    if (manifest.name !== name) fail(`servers/${name}: manifest name '${manifest.name}' differs from folder`);
    roles = core.loadRoles(join(dir, "roles.yaml"), manifest);
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

  // Scopes must be proven, not just declared (ADR 0002): a handler that ignores ctx.scopes passes deny tests.
  if (roles.scope_keys.length > 0 && !existsSync(join(dir, "test", "scope.test.ts"))) {
    fail(`servers/${name}: declares scope_keys but has no test/scope.test.ts (scope isolation across every tool)`);
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

  for (const file of walk(join(dir, "src"))) {
    if (!SOURCE_EXT.test(file)) {
      fail(`${rel(file)}: unexpected file type in src/`);
      continue;
    }
    const text = readFileSync(file, "utf8");
    for (const [pattern, why] of FORBIDDEN_SOURCE) {
      if (pattern.test(text)) fail(`${rel(file)}: ${why}`);
    }
  }

  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
  if ("@modelcontextprotocol/sdk" in deps) fail(`servers/${name}/package.json: depends on the MCP SDK directly`);
  if (deps["@mcp-depot/core"] === undefined) fail(`servers/${name}/package.json: must depend on @mcp-depot/core`);
}

// Compose fragments (ADR 0001 network rules). Parsed as YAML, not matched as text.
const FORBIDDEN_SERVICE_KEYS = ["ports", "network_mode", "pid", "ipc", "privileged", "cap_add", "devices", "userns_mode", "uts", "links"];
for (const file of walk(join(root, "compose"))) {
  const base = file.split("/").pop();
  const match = /^([a-z][a-z0-9-]*)\.yml$/.exec(base);
  if (!match) {
    fail(`${rel(file)}: compose/ holds only <server>.yml fragments`);
    continue;
  }
  const name = match[1];
  if (!names.includes(name)) fail(`${rel(file)}: no matching server`);
  let doc;
  try {
    doc = parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${rel(file)}: invalid YAML (${error.message})`);
    continue;
  }
  const top = Object.keys(doc ?? {});
  for (const key of top) if (!["services", "networks"].includes(key)) fail(`${rel(file)}: unexpected top-level key '${key}'`);
  const services = doc?.services ?? {};
  const serviceNames = Object.keys(services);
  if (serviceNames.length !== 1 || serviceNames[0] !== name) fail(`${rel(file)}: must define exactly one service named '${name}'`);
  for (const [svcName, svc] of Object.entries(services)) {
    const where = `${rel(file)} service '${svcName}'`;
    for (const key of FORBIDDEN_SERVICE_KEYS) if (svc && key in svc) fail(`${where}: '${key}' is not allowed (ADR 0001)`);
    if (JSON.stringify(svc?.profiles) !== JSON.stringify([name])) fail(`${where}: profiles must be [${name}]`);
    if (svc?.read_only !== true) fail(`${where}: read_only must be true`);
    if (!Array.isArray(svc?.cap_drop) || !svc.cap_drop.includes("ALL")) fail(`${where}: cap_drop must include ALL`);
    if (!Array.isArray(svc?.security_opt) || !svc.security_opt.some((o) => String(o).replace(/\s/g, "") === "no-new-privileges:true")) {
      fail(`${where}: security_opt must include no-new-privileges:true`);
    }
    const nets = Array.isArray(svc?.networks) ? svc.networks : Object.keys(svc?.networks ?? {});
    if (JSON.stringify(nets) !== JSON.stringify(["depot"])) fail(`${where}: networks must be [depot]`);
    for (const volume of svc?.volumes ?? []) {
      const source = typeof volume === "string" ? volume.split(":")[0] : String(volume?.source ?? "");
      if (/docker\.sock/.test(String(source)) || source === "/" || source === "/etc" || source === "/var/run") {
        fail(`${where}: volume '${source}' exposes the host`);
      }
    }
  }
  const depot = doc?.networks?.depot;
  if (!depot || depot.external !== true || Object.keys(doc.networks).length !== 1) {
    fail(`${rel(file)}: networks must be only 'depot' with external: true`);
  }
}
for (const name of names) {
  if (!existsSync(join(root, "compose", `${name}.yml`))) fail(`servers/${name}: missing compose/${name}.yml`);
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
