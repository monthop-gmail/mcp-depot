/** Configuration problem detected at startup. The process must not start. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

/**
 * An error whose message is safe to return to the AI client.
 * Any other error thrown by a tool is reported as a generic failure and logged locally.
 */
export class ToolError extends Error {
  override name = "ToolError";
}
