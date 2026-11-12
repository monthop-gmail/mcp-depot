import { readFileSync, statSync } from "node:fs";
import { parse } from "yaml";
import { ConfigError } from "./errors.js";
import { log } from "./log.js";
import { describeErrors, validateMembers } from "./schemas.js";

export interface Member {
  roles: string[];
  scopes: Record<string, string[]>;
}

export type MemberLookup = { status: "ok"; member: Member | undefined } | { status: "unavailable" };

/** L3 membership (ADR 0002). Implementations must fail closed. */
export interface MembershipSource {
  lookup(principalId: string): MemberLookup;
}

function normalizeKey(key: string): string {
  return key.startsWith("user:") ? `user:${key.slice(5).trim().toLowerCase()}` : key;
}

export function parseMembers(text: string, label: string): Map<string, Member> {
  let data: unknown;
  try {
    data = parse(text);
  } catch (error) {
    throw new ConfigError(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!validateMembers(data)) throw new ConfigError(`${label}: ${describeErrors(validateMembers.errors)}`);
  const members = new Map<string, Member>();
  for (const [key, value] of Object.entries((data as { members: Record<string, Partial<Member>> }).members)) {
    const id = normalizeKey(key);
    if (members.has(id)) throw new ConfigError(`${label}: duplicate member after normalisation`);
    members.set(id, { roles: value.roles ?? [], scopes: value.scopes ?? {} });
  }
  return members;
}

/**
 * Membership from a file mounted read-only at deploy time. Re-read whenever the file changes, checked on
 * every lookup, so removals apply on the next request. A file that becomes unreadable or invalid denies
 * everyone until fixed (fail closed); it never falls back to the previous content.
 */
export class FileMembership implements MembershipSource {
  private members = new Map<string, Member>();
  private signature = "";
  private healthy = false;

  constructor(private readonly path: string) {
    // Refuse to start on a missing or invalid file: the problem shows at deploy time, not at first use.
    this.reload(true);
  }

  private reload(strict: boolean): void {
    try {
      const st = statSync(this.path);
      const signature = `${st.ino}:${st.size}:${st.mtimeMs}`;
      if (signature === this.signature && this.healthy) return;
      this.members = parseMembers(readFileSync(this.path, "utf8"), "members file");
      this.signature = signature;
      this.healthy = true;
    } catch (error) {
      if (strict) {
        throw error instanceof ConfigError ? error : new ConfigError(`MEMBERS_PATH unreadable: ${String(error)}`);
      }
      if (this.healthy) log("error", "members file unusable; denying all", { err: String(error) });
      this.healthy = false;
      this.signature = "";
      this.members = new Map();
    }
  }

  lookup(principalId: string): MemberLookup {
    this.reload(false);
    if (!this.healthy) return { status: "unavailable" };
    return { status: "ok", member: this.members.get(principalId) };
  }
}

/** Fixed membership, for tests and fixture runs. */
export class StaticMembership implements MembershipSource {
  private readonly members: Map<string, Member>;
  constructor(yamlText: string) {
    this.members = parseMembers(yamlText, "static members");
  }
  lookup(principalId: string): MemberLookup {
    return { status: "ok", member: this.members.get(principalId) };
  }
}
