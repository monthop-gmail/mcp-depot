import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ValidateFunction } from "ajv";
import { AuditLog, fileSink, stdoutSink } from "./audit.js";
import { ConfigError, ToolError } from "./errors.js";
import { Guard } from "./guard.js";
import { AccessJwtProvider } from "./identity.js";
import { log } from "./log.js";
import { loadManifest, loadRoles, type Manifest, type Roles } from "./manifest.js";
import { FileMembership, type MembershipSource } from "./members.js";
import type { IdentityProvider, Principal } from "./principal.js";
import { ajv } from "./schemas.js";

export interface ToolContext {
  principal: Principal;
  /** Scope values from membership, keyed by the server's scope_keys. ["*"] means unrestricted. */
  scopes: Record<string, string[]>;
  signal: AbortSignal;
}

export interface ToolDefinition<Args = Record<string, unknown>> {
  description: string;
  /** JSON Schema (object) for the arguments; validated before the handler runs. */
  inputSchema: Record<string, unknown> & { type: "object" };
  handler: (args: Args, ctx: ToolContext) => Promise<unknown>;
}

export interface ServerDefinition {
  /** Directory holding manifest.yaml and roles.yaml. */
  dir: string;
  version: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Record<string, ToolDefinition<any>>;
}

export interface LoadedServer {
  manifest: Manifest;
  roles: Roles;
  version: string;
  tools: Map<string, ToolDefinition<Record<string, unknown>> & { validate: ValidateFunction }>;
}

/** Loads manifest + roles and proves the code implements exactly the declared tools (ADR 0003). */
export function loadServer(def: ServerDefinition): LoadedServer {
  const manifest = loadManifest(join(def.dir, "manifest.yaml"));
  const roles = loadRoles(join(def.dir, "roles.yaml"), manifest);
  const declared = manifest.tools.map((t) => t.name).sort();
  const implemented = Object.keys(def.tools).sort();
  if (declared.join(",") !== implemented.join(",")) {
    throw new ConfigError(
      `tools in code [${implemented.join(", ")}] differ from manifest [${declared.join(", ")}]`,
    );
  }
  const tools = new Map<string, ToolDefinition<Record<string, unknown>> & { validate: ValidateFunction }>();
  for (const [name, tool] of Object.entries(def.tools)) {
    let validate: ValidateFunction;
    try {
      const { $schema: _ignored, ...schema } = tool.inputSchema;
      validate = ajv.compile(schema);
    } catch (error) {
      throw new ConfigError(`tool '${name}' inputSchema: ${error instanceof Error ? error.message : String(error)}`);
    }
    tools.set(name, { ...tool, validate });
  }
  return { manifest, roles, version: def.version, tools };
}

export interface RuntimeConfig {
  port: number;
  deployment: string;
  allowedHosts: ReadonlySet<string>;
  identity: IdentityProvider;
  membership: MembershipSource;
  audit: AuditLog;
  enabledTools: string[];
  bodyLimitBytes: number;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Reads deployment settings. Any problem throws ConfigError so the server refuses to start (ADR 0001). */
export function configFromEnv(loaded: LoadedServer, env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const allowedHosts = list(env.ALLOWED_HOSTS).map((h) => h.toLowerCase());
  if (allowedHosts.length === 0) throw new ConfigError("ALLOWED_HOSTS is required (the deployment's public hostname)");
  if (!env.MEMBERS_PATH) throw new ConfigError("MEMBERS_PATH is required");
  const port = Number(env.PORT ?? "8080");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new ConfigError("PORT is invalid");
  const enabledTools = list(env.ENABLED_TOOLS);
  const known = new Set(loaded.manifest.tools.map((t) => t.name));
  for (const name of enabledTools) {
    if (!known.has(name)) throw new ConfigError(`ENABLED_TOOLS names unknown tool '${name}'`);
  }
  return {
    port,
    deployment: env.DEPLOYMENT?.trim() || loaded.manifest.name,
    allowedHosts: new Set(allowedHosts),
    identity: new AccessJwtProvider({ teamDomain: env.ACCESS_TEAM_DOMAIN ?? "", audiences: list(env.ACCESS_AUD) }),
    membership: new FileMembership(env.MEMBERS_PATH),
    audit: new AuditLog(env.AUDIT_PATH ? fileSink(env.AUDIT_PATH) : stdoutSink),
    enabledTools,
    bodyLimitBytes: 1024 * 1024,
  };
}

function send(res: ServerResponse, status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function hostnameOf(hostHeader: string | undefined): string {
  if (!hostHeader) return "";
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | "too_large"> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) return "too_large";
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function textResult(value: unknown, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

/** Builds the HTTP server. Only /healthz (no data) and POST /mcp exist; no CORS, no host ports in deployment. */
export function createHttpServer(loaded: LoadedServer, cfg: RuntimeConfig): HttpServer {
  const guard = new Guard(loaded.manifest, loaded.roles, cfg.membership, cfg.enabledTools);
  const allowedOrigins = new Set([...cfg.allowedHosts].map((h) => `https://${h}`));

  const audit = (
    partial: Pick<Parameters<AuditLog["write"]>[0], "principal" | "tool" | "decision" | "reason" | "outcome">,
    req: IncomingMessage,
    started: number,
  ) => {
    const ua = req.headers["user-agent"];
    cfg.audit.write({
      ts: new Date().toISOString(),
      server: loaded.manifest.name,
      deployment: cfg.deployment,
      client_unverified: typeof ua === "string" ? ua.slice(0, 120) : null,
      duration_ms: Date.now() - started,
      ...partial,
    });
  };

  const buildMcp = (principal: Principal, req: IncomingMessage, signal: AbortSignal): McpServer => {
    const mcp = new McpServer(
      { name: loaded.manifest.name, version: loaded.version },
      { capabilities: { tools: {} } },
    );
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: guard.visibleTools(principal).map((name) => {
        const tool = loaded.tools.get(name)!;
        return { name, description: tool.description, inputSchema: tool.inputSchema };
      }),
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      const started = Date.now();
      const name = request.params.name;
      const decision = guard.decide(principal, name);
      if (!decision.allow) {
        audit({ principal: principal.id, tool: name, decision: "deny", reason: decision.reason, outcome: "denied" }, req, started);
        return textResult(`denied: ${decision.reason}`, true);
      }
      const tool = loaded.tools.get(name)!;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      if (!tool.validate(args)) {
        audit({ principal: principal.id, tool: name, decision: "allow", reason: null, outcome: "invalid_args" }, req, started);
        const detail = (tool.validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
        return textResult(`invalid arguments: ${detail}`, true);
      }
      try {
        const result = await tool.handler(args, { principal, scopes: decision.scopes, signal });
        audit({ principal: principal.id, tool: name, decision: "allow", reason: null, outcome: "ok" }, req, started);
        return textResult(result);
      } catch (error) {
        audit({ principal: principal.id, tool: name, decision: "allow", reason: null, outcome: "error" }, req, started);
        if (error instanceof ToolError) return textResult(error.message, true);
        log("error", "tool failed", { tool: name, err: error instanceof Error ? error.message : String(error) });
        return textResult("internal error; see server logs", true);
      }
    });
    return mcp;
  };

  return createServer((req, res) => {
    void (async () => {
      const started = Date.now();
      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname === "/healthz") {
        if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" }, { allow: "GET" });
        return send(res, 200, { ok: true });
      }
      if (url.pathname !== "/mcp") return send(res, 404, { error: "not_found" });

      // DNS rebinding / wrong-route protection before anything else.
      if (!cfg.allowedHosts.has(hostnameOf(req.headers.host))) return send(res, 403, { error: "host_not_allowed" });
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigins.has(origin)) return send(res, 403, { error: "origin_not_allowed" });
      if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" }, { allow: "POST" });

      const identity = await cfg.identity.verify(req.headers);
      if (!identity.ok) {
        audit({ principal: null, tool: null, decision: "deny", reason: identity.rejection.reason, outcome: "rejected" }, req, started);
        return send(res, identity.rejection.status, { error: identity.rejection.reason });
      }

      const type = req.headers["content-type"] ?? "";
      if (!type.toLowerCase().startsWith("application/json")) return send(res, 415, { error: "unsupported_media_type" });
      const raw = await readBody(req, cfg.bodyLimitBytes);
      if (raw === "too_large") return send(res, 413, { error: "body_too_large" });
      let body: unknown;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return send(res, 400, { error: "invalid_json" });
      }

      const abort = new AbortController();
      const mcp = buildMcp(identity.principal, req, abort.signal);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        abort.abort();
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch((error: unknown) => {
      log("error", "request failed", { err: error instanceof Error ? error.message : String(error) });
      send(res, 500, { error: "internal_error" });
    });
  });
}

/** Entry point for a server package: load, configure, listen — or exit non-zero. */
export function main(def: ServerDefinition): void {
  let loaded: LoadedServer;
  let cfg: RuntimeConfig;
  try {
    loaded = loadServer(def);
    cfg = configFromEnv(loaded);
  } catch (error) {
    log("error", "refusing to start", { err: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
  const server = createHttpServer(loaded, cfg);
  server.listen(cfg.port, () => {
    log("info", "listening", { server: loaded.manifest.name, deployment: cfg.deployment, port: cfg.port });
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
