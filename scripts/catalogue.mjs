#!/usr/bin/env node
// Generates docs/servers.md from every servers/<name>/manifest.yaml.
// `npm run catalogue` writes it; `npm run check` fails when it is stale.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("..", import.meta.url));
export const CATALOGUE_PATH = join(root, "docs", "servers.md");

export function serverNames() {
  const dir = join(root, "servers");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderCatalogue() {
  const rows = serverNames().map((name) => {
    const m = parse(readFileSync(join(root, "servers", name, "manifest.yaml"), "utf8"));
    const tools = m.tools
      .map((t) => `\`${t.name}\`${t.access === "write" ? " (write" + (t.default_enabled === false ? ", off" : "") + ")" : ""}`)
      .join(", ");
    return `| [${cell(m.name)}](../servers/${name}/) | ${cell(m.status)} | ${cell(m.runtime)} | ${cell(m.data_class)} | ${tools} | ${cell(m.owner)} | ${cell(m.summary)} |`;
  });
  return [
    "# Servers in the depot",
    "",
    "Generated from `servers/*/manifest.yaml` by `npm run catalogue`. Do not edit by hand.",
    "",
    "| Server | Status | Runtime | Data class | Tools | Owner | Summary |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(CATALOGUE_PATH, renderCatalogue());
  console.log(`wrote docs/servers.md (${serverNames().length} servers)`);
}
