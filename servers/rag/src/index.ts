import { log, main } from "@mcp-depot/core";
import { corpusFromEnv, definition } from "./definition.js";

let corpus;
try {
  corpus = corpusFromEnv();
} catch (error) {
  log("error", "refusing to start", { err: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}
corpus.warmUp(); // builds the index once if it has never been built; searches wait for it
main(definition(corpus));
