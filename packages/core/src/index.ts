/**
 * Public API for servers. A server may import only from "@mcp-depot/core".
 * Transport, identity, membership and guard live in "@mcp-depot/core/internal", which servers' src/ must not
 * import (enforced by `npm run check`); tests may use it together with "@mcp-depot/core/testing".
 */
export { ConfigError, ToolError } from "./errors.js";
export { log } from "./log.js";
export { isUnrestricted } from "./guard.js";
export type { DataClass, Manifest, ManifestTool } from "./manifest.js";
export type { Principal } from "./principal.js";
export { main, type ServerDefinition, type ToolContext, type ToolDefinition } from "./server.js";
