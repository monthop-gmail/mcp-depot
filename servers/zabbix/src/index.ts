import { log, main } from "@mcp-depot/core";
import { definition, rpcFromEnv } from "./definition.js";

let rpc;
try {
  rpc = rpcFromEnv();
} catch (error) {
  log("error", "refusing to start", { err: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}
main(definition(rpc));
