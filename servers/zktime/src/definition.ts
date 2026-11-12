import { fileURLToPath } from "node:url";
import { ConfigError, log, type ServerDefinition } from "@mcp-depot/core";
import { FixtureStore } from "./fixture.js";
import { MdbStore } from "./mdb-store.js";
import { MssqlStore, openPool, type MssqlConfig } from "./mssql-store.js";
import type { ZktimeStore } from "./store.js";
import { zktimeTools } from "./tools.js";

/** servers/zktime/ — where manifest.yaml and roles.yaml live (this file is dist/src/definition.js). */
export const SERVER_DIR = fileURLToPath(new URL("../../", import.meta.url));
export const VERSION = "0.1.0";

export function definition(store: ZktimeStore): ServerDefinition {
  return { dir: SERVER_DIR, version: VERSION, tools: zktimeTools(store) };
}

/** Every server exports this: a definition that needs no upstream, used by tests and `npm run check`. */
export function fixtureDefinition(): ServerDefinition {
  return definition(new FixtureStore());
}

/** A true/false setting; unset or empty means `fallback`, anything else is a configuration error. */
function flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = (env[name] ?? "").trim().toLowerCase();
  if (raw === "") return fallback;
  if (raw !== "true" && raw !== "false") throw new ConfigError(`${name} must be true or false`);
  return raw === "true";
}

/**
 * SQL Server settings from the environment, validated; opens no connection.
 * Needs ZKTIME_MSSQL_HOST, ZKTIME_MSSQL_USER and ZKTIME_MSSQL_PASSWORD (a SELECT-only login).
 * ZKTIME_MSSQL_ENCRYPT defaults to true; ZKTIME_MSSQL_TRUST_SERVER_CERT defaults to true (ZKTime installs
 * usually run old SQL Server editions with self-signed certificates; set false to verify the certificate).
 */
export function mssqlConfigFromEnv(env: NodeJS.ProcessEnv): MssqlConfig {
  const host = env.ZKTIME_MSSQL_HOST ?? "";
  const user = env.ZKTIME_MSSQL_USER ?? "";
  const password = env.ZKTIME_MSSQL_PASSWORD ?? "";
  const port = Number(env.ZKTIME_MSSQL_PORT || "1433");
  if (!host) throw new ConfigError("ZKTIME_MSSQL_HOST is required");
  if (!user || !password) throw new ConfigError("ZKTIME_MSSQL_USER and ZKTIME_MSSQL_PASSWORD are required");
  if (user.toLowerCase() === "sa") throw new ConfigError("ZKTIME_MSSQL_USER must be a SELECT-only login, not sa");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError("ZKTIME_MSSQL_PORT must be a TCP port");
  return {
    host,
    port,
    user,
    password,
    database: env.ZKTIME_MSSQL_DATABASE || "att2000",
    encrypt: flag(env, "ZKTIME_MSSQL_ENCRYPT", true),
    trustServerCertificate: flag(env, "ZKTIME_MSSQL_TRUST_SERVER_CERT", true),
  };
}

/** ZKTIME_MODE=fixture serves synthetic data. mdb reads an att2000.mdb under ZKTIME_DATA_DIR (mounted read-only). */
export function storeFromEnv(env: NodeJS.ProcessEnv = process.env): ZktimeStore {
  const mode = env.ZKTIME_MODE ?? "";
  if (mode === "fixture") return new FixtureStore();
  if (mode === "mdb") return new MdbStore(env.ZKTIME_DATA_DIR || "/data/zktime", env.ZKTIME_MDB_FILE ?? "");
  if (mode !== "mssql") throw new ConfigError("ZKTIME_MODE must be 'fixture', 'mdb' or 'mssql'");
  const config = mssqlConfigFromEnv(env);
  if (!config.encrypt) {
    log("warn", "ZKTIME_MSSQL_ENCRYPT=false: the SQL Server connection is not encrypted; use only on a trusted LAN");
  }
  return new MssqlStore(openPool(config));
}
