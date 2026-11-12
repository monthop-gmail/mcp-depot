import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { ConfigError } from "./errors.js";
import { describeErrors, validateManifest, validateRoles } from "./schemas.js";

export type DataClass = "public" | "internal" | "personal" | "financial";

export interface ManifestTool {
  name: string;
  summary: string;
  access: "read" | "write";
  data_class?: DataClass;
  default_enabled?: boolean;
}

export interface Manifest {
  name: string;
  summary: string;
  owner: string;
  status: "experimental" | "stable" | "deprecated";
  deprecated_since?: string;
  replaced_by?: string;
  runtime: "site" | "cloud" | "any";
  data_class: DataClass;
  tools: ManifestTool[];
  secrets?: string[];
  config?: string[];
  upstreams?: string[];
}

export interface Roles {
  scope_keys: string[];
  roles: Record<string, { summary?: string; tools: string[] }>;
}

function readYaml(path: string): unknown {
  try {
    return parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Loads servers/<name>/manifest.yaml and enforces ADR 0003. */
export function loadManifest(path: string): Manifest {
  const data = readYaml(path);
  if (!validateManifest(data)) throw new ConfigError(`${path}: ${describeErrors(validateManifest.errors)}`);
  const manifest = data as Manifest;
  const seen = new Set<string>();
  for (const tool of manifest.tools) {
    if (seen.has(tool.name)) throw new ConfigError(`${path}: duplicate tool '${tool.name}'`);
    seen.add(tool.name);
    if (tool.name.startsWith(`${manifest.name.replace(/-/g, "_")}_`)) {
      throw new ConfigError(`${path}: tool '${tool.name}' carries the server prefix; the portal namespaces tools`);
    }
  }
  return manifest;
}

/** Loads servers/<name>/roles.yaml and checks it against the manifest (ADR 0002). */
export function loadRoles(path: string, manifest: Manifest): Roles {
  const data = readYaml(path);
  if (!validateRoles(data)) throw new ConfigError(`${path}: ${describeErrors(validateRoles.errors)}`);
  const roles = data as Roles;
  const known = new Set(manifest.tools.map((t) => t.name));
  for (const [role, def] of Object.entries(roles.roles)) {
    for (const tool of def.tools) {
      if (!known.has(tool)) throw new ConfigError(`${path}: role '${role}' names unknown tool '${tool}'`);
    }
  }
  return roles;
}
