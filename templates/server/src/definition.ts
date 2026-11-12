import { fileURLToPath } from "node:url";
import type { ServerDefinition } from "@mcp-depot/core";
import { tools } from "./tools.js";

export const SERVER_DIR = fileURLToPath(new URL("../../", import.meta.url));
export const VERSION = "0.1.0";

export function definition(): ServerDefinition {
  return { dir: SERVER_DIR, version: VERSION, tools: tools() };
}

/** Every server exports this: a definition that needs no upstream, used by tests and `npm run check`. */
export function fixtureDefinition(): ServerDefinition {
  return definition();
}
