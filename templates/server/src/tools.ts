import type { ToolDefinition } from "@mcp-depot/core";

/**
 * Tools receive validated arguments and a context with the verified principal and its scopes.
 * Never check identity or roles here — core's guard already did. Apply ctx.scopes in upstream queries.
 * Throw ToolError for messages the AI may see; anything else is reported as a generic failure.
 */
export function tools(): Record<string, ToolDefinition<any>> {
  const getStatus: ToolDefinition<Record<string, never>> = {
    description: "Example tool: reports that the server is reachable.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, ctx) => ({ ok: true, principal: ctx.principal.id }),
  };
  return { get_status: getStatus };
}
