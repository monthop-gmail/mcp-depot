import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { log } from "@mcp-depot/core";
import type { MeshAction, MeshApi } from "./types.js";

export interface ClientConfig {
  /** wss://…/control.ashx (ws:// only when MESHCENTRAL_ALLOW_HTTP=true). */
  url: string;
  user: string;
  password: string;
  /** PEM CA bundle for a self-signed MeshCentral certificate. Certificates are always verified. */
  ca?: Buffer;
  timeoutMs: number;
}

type Pending = { resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/**
 * MeshCentral control channel (/control.ashx). One shared connection, opened lazily on the first request and
 * reopened on the next request after it drops; ready once the server sends `serverinfo`.
 * Sends only `meshes`, `nodes` and `pong` (reply to `ping`). The x-meshauth header and password are never logged.
 */
export class MeshClient implements MeshApi {
  private ws?: WebSocket;
  private ready?: Promise<WebSocket>;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly config: ClientConfig) {}

  private failAll(reason: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(reason);
      this.pending.delete(id);
    }
  }

  private connect(): Promise<WebSocket> {
    if (this.ready) return this.ready;
    const auth = `${Buffer.from(this.config.user).toString("base64")},${Buffer.from(this.config.password).toString("base64")}`;
    this.ready = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(this.config.url, {
        headers: { "x-meshauth": auth },
        rejectUnauthorized: true,
        ...(this.config.ca ? { ca: this.config.ca } : {}),
        handshakeTimeout: this.config.timeoutMs,
      });
      this.ws = ws;
      let opened = false;
      const timer = setTimeout(() => {
        reject(new Error("MeshCentral did not send serverinfo in time"));
        ws.terminate();
      }, this.config.timeoutMs);
      ws.on("message", (data) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data.toString()) as Record<string, unknown>;
        } catch {
          return;
        }
        const action = msg.action;
        if (action === "serverinfo" && !opened) {
          opened = true;
          clearTimeout(timer);
          resolve(ws);
        } else if (action === "ping") {
          ws.send(JSON.stringify({ action: "pong" }));
        } else if (action === "close") {
          const cause = typeof msg.cause === "string" ? msg.cause : "unknown";
          const error = new Error(`MeshCentral closed the session (${cause})`);
          clearTimeout(timer);
          reject(error);
          this.failAll(error);
          ws.close();
        } else if (typeof msg.responseid === "string" && this.pending.has(msg.responseid)) {
          const p = this.pending.get(msg.responseid)!;
          this.pending.delete(msg.responseid);
          clearTimeout(p.timer);
          p.resolve(msg);
        }
      });
      const drop = (why: string) => {
        clearTimeout(timer);
        if (this.ws === ws) {
          this.ws = undefined;
          this.ready = undefined;
        }
        const error = new Error(`MeshCentral connection ${why}`);
        reject(error);
        this.failAll(error);
      };
      ws.on("close", () => drop("closed"));
      ws.on("error", (e) => {
        log("warn", "MeshCentral connection error", { err: e.message });
        drop("failed");
      });
    });
    this.ready.catch(() => undefined);
    return this.ready;
  }

  async request(action: MeshAction, payload: { meshid?: string } = {}): Promise<Record<string, unknown>> {
    const ws = await this.connect();
    const responseid = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(responseid);
        reject(new Error(`MeshCentral '${action}' timed out after ${this.config.timeoutMs}ms`));
      }, this.config.timeoutMs);
      this.pending.set(responseid, { resolve, reject, timer });
      ws.send(JSON.stringify({ action, responseid, ...payload }));
    });
  }

  close(): void {
    this.ws?.close();
  }
}
