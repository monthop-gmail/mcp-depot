import { ToolError } from "@mcp-depot/core";

/** The only thing tools need from Zabbix: one JSON-RPC call. Real API and fixture both implement it. */
export interface ZabbixRpc {
  call<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
}

interface JsonRpcReply<T> {
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

/** Zabbix 7 JSON-RPC over HTTPS with a Bearer API token. Errors are short and contain no response bodies. */
export class ZabbixApi implements ZabbixRpc {
  private id = 0;

  constructor(
    private readonly apiUrl: string,
    private readonly apiToken: string,
    private readonly timeoutMs = 20_000,
  ) {}

  async call<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(this.apiUrl, {
        method: "POST",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: {
          "content-type": "application/json-rpc",
          accept: "application/json",
          authorization: `Bearer ${this.apiToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: ++this.id }),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new ToolError(timedOut ? `Zabbix API timed out (${method})` : `Zabbix API unreachable (${method})`);
    }
    if (!response.ok) throw new ToolError(`Zabbix API HTTP ${response.status} (${method})`);
    let body: JsonRpcReply<T>;
    try {
      body = (await response.json()) as JsonRpcReply<T>;
    } catch {
      throw new ToolError(`Zabbix API returned non-JSON (${method})`);
    }
    if (body.error) throw new ToolError(`Zabbix ${method} error ${body.error.code}: ${body.error.message}`);
    return body.result as T;
  }
}
