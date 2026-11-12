import { ToolError, isUnrestricted, type ToolContext, type ToolDefinition } from "@mcp-depot/core";
import { normalizePrefix, type RagCorpus } from "./corpus.js";
import type { Folders } from "./types.js";

/**
 * The member's `folders` scope as normalised prefixes; `undefined` = whole corpus (["*"]).
 * Applied inside every SQL query (ADR 0002 rule 3), never to results afterwards.
 */
function permittedFolders(ctx: ToolContext): Folders {
  const values = ctx.scopes.folders ?? [];
  if (isUnrestricted(values)) return undefined;
  return values.map((v) => normalizePrefix(v, "folders scope", true));
}

const prefixArg = (raw: string | undefined) => (raw === undefined ? undefined : normalizePrefix(raw, "path_prefix"));

const pathPrefix = {
  type: "string",
  minLength: 1,
  maxLength: 300,
  description: "Folder relative to the document root, e.g. 'manuals/network'. Narrows within your permitted folders.",
};

/**
 * Tools receive validated arguments and a context with the verified principal and its scopes.
 * Identity and roles were already checked by core's guard; this file only applies the folder scope.
 */
export function ragTools(corpus: RagCorpus): Record<string, ToolDefinition<any>> {
  const getStatus: ToolDefinition<Record<string, never>> = {
    description: "Document index status: mode, when it was last built, and file/chunk counts within your permitted folders.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, ctx) => ({ ok: true, ...(await corpus.status(permittedFolders(ctx))) }),
  };

  const listSources: ToolDefinition<{ path_prefix?: string; limit?: number }> = {
    description: "Indexed documents in your permitted folders (relative path, title, size, chunk count).",
    inputSchema: {
      type: "object",
      properties: { path_prefix: pathPrefix, limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 80." } },
      additionalProperties: false,
    },
    handler: async ({ path_prefix, limit = 80 }, ctx) => {
      const sources = await corpus.listSources(permittedFolders(ctx), prefixArg(path_prefix), limit);
      return { sample: corpus.mode === "fixture", count: sources.length, sources };
    },
  };

  const search: ToolDefinition<{ query: string; path_prefix?: string; limit?: number }> = {
    description:
      "Full-text search (Thai or English) over documents in your permitted folders. Returns excerpts with path, " +
      "page and chunk_id; read a whole chunk with get_chunk.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 2, maxLength: 200 },
        path_prefix: pathPrefix,
        limit: { type: "integer", minimum: 1, maximum: 30, description: "Default 8." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: async ({ query, path_prefix, limit = 8 }, ctx) => {
      const hits = await corpus.search(permittedFolders(ctx), query, prefixArg(path_prefix), limit);
      return { sample: corpus.mode === "fixture", query, count: hits.length, hits };
    },
  };

  const getChunk: ToolDefinition<{ chunk_id: number }> = {
    description: "Full text of one chunk returned by search.",
    inputSchema: {
      type: "object",
      properties: { chunk_id: { type: "integer", minimum: 1 } },
      required: ["chunk_id"],
      additionalProperties: false,
    },
    handler: async ({ chunk_id }, ctx) => {
      const chunk = await corpus.getChunk(permittedFolders(ctx), chunk_id);
      // Same answer whether the chunk does not exist or lies outside the member's folders.
      if (!chunk) throw new ToolError(`chunk ${chunk_id} not found`);
      return { sample: corpus.mode === "fixture", ...chunk };
    },
  };

  const reindex: ToolDefinition<Record<string, never>> = {
    description:
      "Rebuild the whole index from the document folder (read-only source). Returns totals only. " +
      "Searches wait until the rebuild finishes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => corpus.reindex(),
  };

  return { get_status: getStatus, list_sources: listSources, search, get_chunk: getChunk, reindex };
}
