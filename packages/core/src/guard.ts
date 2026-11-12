import { ConfigError } from "./errors.js";
import type { Manifest, Roles } from "./manifest.js";
import type { MembershipSource } from "./members.js";
import type { Principal } from "./principal.js";

export type DenyReason =
  | "unknown_tool"
  | "tool_disabled"
  | "membership_unavailable"
  | "not_member"
  | "role_missing"
  | "scope_missing"
  | "scope_wildcard_forbidden";

/** The scope wildcard. Defined here, not by each server. */
export const SCOPE_WILDCARD = "*";

/** True when a scope grants everything (`["*"]`). Servers must treat anything else as a list to filter by. */
export function isUnrestricted(values: readonly string[] | undefined): boolean {
  return values !== undefined && values.includes(SCOPE_WILDCARD);
}

const SENSITIVE: ReadonlySet<string> = new Set(["personal", "financial"]);

export type Decision =
  | { allow: true; roles: string[]; scopes: Record<string, string[]> }
  | { allow: false; reason: DenyReason };

/**
 * The single permission check every tool call passes through (ADR 0002).
 * Default deny: no membership, no role naming the tool, or a missing scope → deny.
 */
export class Guard {
  private readonly enabledTools: ReadonlySet<string>;
  private readonly sensitive: boolean;

  constructor(
    private readonly manifest: Manifest,
    private readonly roles: Roles,
    private readonly membership: MembershipSource,
    /** Tools a deployment explicitly enables although the manifest has them off by default. */
    deploymentEnabled: Iterable<string> = [],
  ) {
    const known = new Map(manifest.tools.map((t) => [t.name, t]));
    const enabled = new Set<string>();
    const extra = new Set(deploymentEnabled);
    for (const name of extra) {
      if (!known.has(name)) throw new ConfigError(`ENABLED_TOOLS names unknown tool '${name}'`);
    }
    for (const tool of manifest.tools) {
      if (tool.default_enabled !== false || extra.has(tool.name)) enabled.add(tool.name);
    }
    this.enabledTools = enabled;
    this.sensitive =
      SENSITIVE.has(manifest.data_class) || manifest.tools.some((t) => t.data_class !== undefined && SENSITIVE.has(t.data_class));
  }

  isEnabled(tool: string): boolean {
    return this.enabledTools.has(tool);
  }

  decide(principal: Principal, tool: string): Decision {
    if (!this.manifest.tools.some((t) => t.name === tool)) return { allow: false, reason: "unknown_tool" };
    if (!this.enabledTools.has(tool)) return { allow: false, reason: "tool_disabled" };

    const lookup = this.membership.lookup(principal.id);
    if (lookup.status === "unavailable") return { allow: false, reason: "membership_unavailable" };
    const member = lookup.member;
    if (!member) return { allow: false, reason: "not_member" };

    const granting = member.roles.filter((r) => this.roles.roles[r]?.tools.includes(tool));
    if (granting.length === 0) return { allow: false, reason: "role_missing" };

    const scopes: Record<string, string[]> = {};
    for (const key of this.roles.scope_keys) {
      const values = member.scopes[key];
      if (!values || values.length === 0) return { allow: false, reason: "scope_missing" };
      // Personal and financial data must be granted by explicit scope values (ADR 0002 rule 8).
      if (isUnrestricted(values) && this.sensitive) return { allow: false, reason: "scope_wildcard_forbidden" };
      scopes[key] = isUnrestricted(values) ? [SCOPE_WILDCARD] : [...values];
    }
    return { allow: true, roles: granting, scopes };
  }

  /** Tools this principal may call; what tools/list shows them. */
  visibleTools(principal: Principal): string[] {
    return this.manifest.tools.map((t) => t.name).filter((name) => this.decide(principal, name).allow);
  }
}
