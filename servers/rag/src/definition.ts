import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, type ServerDefinition } from "@mcp-depot/core";
import { RagCorpus } from "./corpus.js";
import { fixtureCorpus } from "./fixture.js";
import { ragTools } from "./tools.js";

/** servers/rag/ — where manifest.yaml and roles.yaml live (this file is dist/src/definition.js). */
export const SERVER_DIR = fileURLToPath(new URL("../../", import.meta.url));
export const VERSION = "0.1.0";

export function definition(corpus: RagCorpus): ServerDefinition {
  return { dir: SERVER_DIR, version: VERSION, tools: ragTools(corpus) };
}

/** Every server exports this: a definition that needs no upstream, used by tests and `npm run check`. */
export function fixtureDefinition(): ServerDefinition {
  return definition(fixtureCorpus());
}

/**
 * RAG_MODE=fixture serves synthetic documents. RAG_MODE=files reads RAG_DOCS_DIR (mounted read-only) and keeps
 * the index at RAG_INDEX_PATH (a writable volume, outside the documents).
 */
export function corpusFromEnv(env: NodeJS.ProcessEnv = process.env): RagCorpus {
  const mode = env.RAG_MODE ?? "";
  if (mode === "fixture") return fixtureCorpus();
  if (mode !== "files") throw new ConfigError("RAG_MODE must be 'fixture' or 'files'");
  const docsDir = env.RAG_DOCS_DIR || "/data/docs";
  const indexPath = env.RAG_INDEX_PATH || "/var/lib/rag/index.sqlite";
  if (!isAbsolute(docsDir) || !isAbsolute(indexPath)) throw new ConfigError("RAG_DOCS_DIR and RAG_INDEX_PATH must be absolute");
  let isDir = false;
  try {
    isDir = statSync(docsDir).isDirectory();
  } catch {
    // reported below
  }
  if (!isDir) throw new ConfigError("RAG_DOCS_DIR must be an existing directory");
  if (indexPath === docsDir || indexPath.startsWith(`${docsDir.replace(/\/+$/, "")}/`)) {
    throw new ConfigError("RAG_INDEX_PATH must be outside RAG_DOCS_DIR");
  }
  return new RagCorpus({ mode: "files", docsDir, indexPath });
}
