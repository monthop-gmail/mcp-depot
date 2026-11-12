import { appendFileSync } from "node:fs";

/**
 * One line per tool call or rejected request (ADR 0002). Contains email addresses: keep it at the site.
 * Never put tokens, JWTs, Cf-Access-* headers or request/response bodies here.
 */
export interface AuditRecord {
  ts: string;
  server: string;
  deployment: string;
  principal: string | null;
  /** As declared by the client (User-Agent). Not verified. */
  client_unverified: string | null;
  tool: string | null;
  decision: "allow" | "deny";
  reason: string | null;
  outcome: "ok" | "error" | "invalid_args" | "denied" | "rejected";
  duration_ms: number;
}

export type AuditSink = (line: string) => void;

export const stdoutSink: AuditSink = (line) => process.stdout.write(`${line}\n`);

export function fileSink(path: string): AuditSink {
  return (line) => appendFileSync(path, `${line}\n`, { mode: 0o600 });
}

export class AuditLog {
  constructor(private readonly sink: AuditSink) {}
  write(record: AuditRecord): void {
    this.sink(JSON.stringify(record));
  }
}
