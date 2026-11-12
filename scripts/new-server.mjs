#!/usr/bin/env node
// Scaffold a new server from templates/: `npm run new-server -- <name>`
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const name = process.argv[2] ?? "";
if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name) || name.length > 32) {
  console.error("usage: npm run new-server -- <name>   (kebab-case, max 32 chars)");
  process.exit(2);
}
const dest = join(root, "servers", name);
const compose = join(root, "compose", `${name}.yml`);
if (existsSync(dest) || existsSync(compose)) {
  console.error(`servers/${name} or compose/${name}.yml already exists`);
  process.exit(1);
}

const upper = name.toUpperCase().replace(/-/g, "_");
const fill = (text) => text.replaceAll("__NAME_UPPER__", upper).replaceAll("__NAME__", name);

cpSync(join(root, "templates", "server"), dest, { recursive: true });
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else writeFileSync(path, fill(readFileSync(path, "utf8")));
  }
};
walk(dest);
writeFileSync(compose, fill(readFileSync(join(root, "templates", "compose.yml"), "utf8")));

console.log(`Created servers/${name}/ and compose/${name}.yml

Next:
  1. Edit servers/${name}/manifest.yaml (summary, owner, data_class, tools) and roles.yaml
  2. Implement tools in servers/${name}/src/tools.ts — never check identity or roles there
  3. npm install && npm run build && npm test && npm run catalogue && npm run check
  4. Open a PR with this server only (see CONTRIBUTING.md)`);
