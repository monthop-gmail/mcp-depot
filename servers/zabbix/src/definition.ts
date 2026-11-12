import { fileURLToPath } from "node:url";
import { ConfigError, type ServerDefinition } from "@mcp-depot/core";
import { FixtureZabbix } from "./fixture.js";
import { ZabbixApi, type ZabbixRpc } from "./rpc.js";
import { zabbixTools } from "./tools.js";

/** servers/zabbix/ — where manifest.yaml and roles.yaml live (this file is dist/src/definition.js). */
export const SERVER_DIR = fileURLToPath(new URL("../../", import.meta.url));
export const VERSION = "0.1.0";

export function definition(rpc: ZabbixRpc): ServerDefinition {
  return { dir: SERVER_DIR, version: VERSION, tools: zabbixTools(rpc) };
}

/** Every server exports this: a definition that needs no upstream, used by tests and `npm run check`. */
export function fixtureDefinition(): ServerDefinition {
  return definition(new FixtureZabbix());
}

/** ZABBIX_MODE=fixture serves synthetic data; otherwise ZABBIX_API_URL (https; http only with ZABBIX_ALLOW_HTTP=true) and ZABBIX_API_TOKEN. */
export function rpcFromEnv(env: NodeJS.ProcessEnv = process.env): ZabbixRpc {
  const mode = env.ZABBIX_MODE ?? "api";
  if (mode === "fixture") return new FixtureZabbix();
  if (mode !== "api") throw new ConfigError("ZABBIX_MODE must be 'api' or 'fixture'");
  const url = env.ZABBIX_API_URL ?? "";
  const token = env.ZABBIX_API_TOKEN ?? "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError("ZABBIX_API_URL is required");
  }
  const allowHttp = env.ZABBIX_ALLOW_HTTP === "true";
  if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
    throw new ConfigError("ZABBIX_API_URL must be https (http only with ZABBIX_ALLOW_HTTP=true, e.g. same-host LAN)");
  }
  if (!token) throw new ConfigError("ZABBIX_API_TOKEN is required");
  return new ZabbixApi(url, token);
}
