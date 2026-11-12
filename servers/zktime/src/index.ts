import { log, main } from "@mcp-depot/core";
import { definition, storeFromEnv } from "./definition.js";

let store;
try {
  store = storeFromEnv();
} catch (error) {
  log("error", "refusing to start", { err: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}
main(definition(store));
