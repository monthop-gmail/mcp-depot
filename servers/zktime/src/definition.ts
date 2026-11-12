import { fileURLToPath } from "node:url";
import { ConfigError, type ServerDefinition } from "@mcp-depot/core";
import { FixtureStore } from "./fixture.js";
import { MdbStore } from "./mdb-store.js";
import { MssqlStore, openPool } from "./mssql-store.js";
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

/**
 * ZKTIME_MODE=fixture serves synthetic data. mdb reads an att2000.mdb under ZKTIME_DATA_DIR (mounted read-only).
 * mssql needs ZKTIME_MSSQL_HOST, ZKTIME_MSSQL_USER and ZKTIME_MSSQL_PASSWORD (a SELECT-only login).
 */
export function storeFromEnv(env: NodeJS.ProcessEnv = process.env): ZktimeStore {
  const mode = env.ZKTIME_MODE ?? "";
  if (mode === "fixture") return new FixtureStore();
  if (mode === "mdb") return new MdbStore(env.ZKTIME_DATA_DIR || "/data/zktime", env.ZKTIME_MDB_FILE ?? "");
  if (mode !== "mssql") throw new ConfigError("ZKTIME_MODE must be 'fixture', 'mdb' or 'mssql'");
  const host = env.ZKTIME_MSSQL_HOST ?? "";
  const user = env.ZKTIME_MSSQL_USER ?? "";
  const password = env.ZKTIME_MSSQL_PASSWORD ?? "";
  const port = Number(env.ZKTIME_MSSQL_PORT || "1433");
  if (!host) throw new ConfigError("ZKTIME_MSSQL_HOST is required");
  if (!user || !password) throw new ConfigError("ZKTIME_MSSQL_USER and ZKTIME_MSSQL_PASSWORD are required");
  if (user.toLowerCase() === "sa") throw new ConfigError("ZKTIME_MSSQL_USER must be a SELECT-only login, not sa");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError("ZKTIME_MSSQL_PORT must be a TCP port");
  const encrypt = (env.ZKTIME_MSSQL_ENCRYPT ?? "false").toLowerCase();
  if (encrypt !== "true" && encrypt !== "false") throw new ConfigError("ZKTIME_MSSQL_ENCRYPT must be true or false");
  return new MssqlStore(
    openPool({ host, port, user, password, database: env.ZKTIME_MSSQL_DATABASE || "att2000", encrypt: encrypt === "true" }),
  );
}
