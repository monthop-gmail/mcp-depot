import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ConfigError, log, type ServerDefinition } from "@mcp-depot/core";
import { MeshClient, type ClientConfig } from "./client.js";
import { FixtureMesh } from "./fixture.js";
import { meshTools } from "./tools.js";
import type { MeshApi } from "./types.js";

/** servers/meshcentral/ — where manifest.yaml and roles.yaml live (this file is dist/src/definition.js). */
export const SERVER_DIR = fileURLToPath(new URL("../../", import.meta.url));
export const VERSION = "0.1.0";

export function definition(api: MeshApi): ServerDefinition {
  return { dir: SERVER_DIR, version: VERSION, tools: meshTools(api) };
}

/** Every server exports this: a definition that needs no upstream, used by tests and `npm run check`. */
export function fixtureDefinition(): ServerDefinition {
  return definition(new FixtureMesh());
}

/**
 * Live settings, validated; opens no connection. MESHCENTRAL_URL must be https (→ wss…/control.ashx) unless
 * MESHCENTRAL_ALLOW_HTTP=true. Certificates are always verified; a self-signed one needs MESHCENTRAL_CA_FILE.
 * The login is a dedicated MeshCentral account (a login token is recommended); TOTP is not supported.
 */
export function clientConfigFromEnv(env: NodeJS.ProcessEnv): ClientConfig {
  let url: URL;
  try {
    url = new URL(env.MESHCENTRAL_URL ?? "");
  } catch {
    throw new ConfigError("MESHCENTRAL_URL is required");
  }
  const allowHttp = (env.MESHCENTRAL_ALLOW_HTTP ?? "").toLowerCase();
  if (allowHttp !== "" && allowHttp !== "true" && allowHttp !== "false") throw new ConfigError("MESHCENTRAL_ALLOW_HTTP must be true or false");
  if (url.protocol === "http:") {
    if (allowHttp !== "true") throw new ConfigError("MESHCENTRAL_URL must be https (or set MESHCENTRAL_ALLOW_HTTP=true)");
    log("warn", "MESHCENTRAL_ALLOW_HTTP=true: the MeshCentral connection is not encrypted");
  } else if (url.protocol !== "https:") {
    throw new ConfigError("MESHCENTRAL_URL must be https");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/control.ashx`;
  url.search = "";
  url.hash = "";
  const user = env.MESHCENTRAL_USER ?? "";
  const password = env.MESHCENTRAL_PASSWORD ?? "";
  if (!user || !password) throw new ConfigError("MESHCENTRAL_USER and MESHCENTRAL_PASSWORD are required");
  const timeoutMs = Number(env.MESHCENTRAL_TIMEOUT_MS || "15000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
    throw new ConfigError("MESHCENTRAL_TIMEOUT_MS must be an integer between 1000 and 60000");
  }
  let ca: Buffer | undefined;
  if (env.MESHCENTRAL_CA_FILE) {
    try {
      ca = readFileSync(env.MESHCENTRAL_CA_FILE);
    } catch {
      throw new ConfigError("MESHCENTRAL_CA_FILE cannot be read");
    }
  }
  return { url: url.toString(), user, password, timeoutMs, ...(ca ? { ca } : {}) };
}

/** MESHCENTRAL_MODE=fixture serves synthetic data; live talks to MeshCentral. */
export function apiFromEnv(env: NodeJS.ProcessEnv = process.env): MeshApi {
  const mode = env.MESHCENTRAL_MODE ?? "";
  if (mode === "fixture") return new FixtureMesh();
  if (mode !== "live") throw new ConfigError("MESHCENTRAL_MODE must be 'fixture' or 'live'");
  return new MeshClient(clientConfigFromEnv(env));
}
