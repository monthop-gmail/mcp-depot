import { log, main } from "@mcp-depot/core";
import { apiFromEnv, definition } from "./definition.js";

let api;
try {
  api = apiFromEnv();
} catch (error) {
  log("error", "refusing to start", { err: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}
main(definition(api));
