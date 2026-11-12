import { ToolError, isUnrestricted, type ToolContext, type ToolDefinition } from "@mcp-depot/core";
import type { ZabbixRpc } from "./rpc.js";

const SEVERITY_NAMES = ["not_classified", "information", "warning", "average", "high", "disaster"] as const;

interface Host {
  hostid: string;
  host: string;
  name: string;
  status: string;
  groups?: Array<{ groupid: string; name: string }>;
  interfaces?: Array<{ ip: string; dns?: string; type: string; available?: string; error?: string; main?: string }>;
}

const iso = (clock: string | undefined) => {
  const s = Number(clock);
  return Number.isFinite(s) && s > 0 ? new Date(s * 1000).toISOString() : null;
};

const availability = (code: string | undefined) => (code === "1" ? "available" : code === "2" ? "unavailable" : "unknown");

/**
 * Resolves the member's host_groups scope to group ids, so every query is filtered by Zabbix itself
 * (ADR 0002: scopes apply in the upstream query). `undefined` = unrestricted (scope ["*"]).
 * An empty array means the member can see nothing.
 */
async function permittedGroupIds(rpc: ZabbixRpc, ctx: ToolContext): Promise<string[] | undefined> {
  const names = ctx.scopes.host_groups ?? [];
  if (isUnrestricted(names)) return undefined;
  if (names.length === 0) return [];
  const found = await rpc.call<Array<{ groupid: string }>>(
    "hostgroup.get",
    { output: ["groupid"], filter: { name: names } },
    ctx.signal,
  );
  return found.map((g) => g.groupid);
}

export function zabbixTools(rpc: ZabbixRpc): Record<string, ToolDefinition<any>> {
  const getActiveProblems: ToolDefinition<{ severity_min?: number }> = {
    description:
      "Active Zabbix problems (not yet recovered) at or above a minimum severity, within your permitted host groups. " +
      "Severity: 0 not classified … 5 disaster.",
    inputSchema: {
      type: "object",
      properties: { severity_min: { type: "integer", minimum: 0, maximum: 5, description: "Default 0 (all)." } },
      additionalProperties: false,
    },
    handler: async ({ severity_min = 0 }, ctx) => {
      const groupids = await permittedGroupIds(rpc, ctx);
      if (groupids?.length === 0) return { count: 0, severity_min, problems: [] };
      const severities = [0, 1, 2, 3, 4, 5].filter((s) => s >= severity_min);
      const problems = await rpc.call<
        Array<{ eventid: string; objectid: string; object?: string; name: string; severity: string; clock: string; acknowledged: string; tags?: Array<{ tag: string; value: string }> }>
      >(
        "problem.get",
        {
          output: ["eventid", "objectid", "object", "name", "severity", "clock", "acknowledged"],
          selectTags: ["tag", "value"],
          recent: false,
          sortfield: "eventid",
          sortorder: "DESC",
          severities,
          ...(groupids ? { groupids } : {}),
        },
        ctx.signal,
      );
      const triggerIds = [...new Set(problems.filter((p) => (p.object ?? "0") === "0").map((p) => p.objectid))];
      const hostsByTrigger = new Map<string, Array<{ host: string; name: string }>>();
      if (triggerIds.length > 0) {
        const triggers = await rpc.call<
          Array<{ triggerid: string; hosts?: Array<{ hostid: string; host: string; name: string }> }>
        >("trigger.get", { output: ["triggerid"], triggerids: triggerIds, selectHosts: ["hostid", "host", "name"] }, ctx.signal);
        // A trigger can span hosts in several groups: keep only hosts inside the member's scope.
        let permittedHosts: Set<string> | undefined;
        if (groupids) {
          const ids = [...new Set(triggers.flatMap((t) => (t.hosts ?? []).map((h) => h.hostid)))];
          const allowed = await rpc.call<Array<{ hostid: string }>>(
            "host.get",
            { output: ["hostid"], hostids: ids, groupids },
            ctx.signal,
          );
          permittedHosts = new Set(allowed.map((h) => h.hostid));
        }
        for (const t of triggers) {
          hostsByTrigger.set(
            t.triggerid,
            (t.hosts ?? []).filter((h) => !permittedHosts || permittedHosts.has(h.hostid)).map((h) => ({ host: h.host, name: h.name })),
          );
        }
      }
      return {
        count: problems.length,
        severity_min,
        problems: problems.map((p) => ({
          eventid: p.eventid,
          name: p.name,
          severity: Number(p.severity),
          severity_name: SEVERITY_NAMES[Number(p.severity)] ?? "unknown",
          acknowledged: p.acknowledged === "1",
          started_at: iso(p.clock),
          hosts: hostsByTrigger.get(p.objectid) ?? [],
          tags: (p.tags ?? []).map((t) => ({ tag: t.tag, value: t.value })),
        })),
      };
    },
  };

  const getDeviceStatus: ToolDefinition<{ group_name?: string }> = {
    description:
      "Monitored Zabbix hosts with interface availability, within your permitted host groups. " +
      "Optionally narrow to one host group by name (case-insensitive substring).",
    inputSchema: {
      type: "object",
      properties: { group_name: { type: "string", minLength: 1, maxLength: 100 } },
      additionalProperties: false,
    },
    handler: async ({ group_name }, ctx) => {
      let groupids = await permittedGroupIds(rpc, ctx);
      if (group_name) {
        const matched = await rpc.call<Array<{ groupid: string }>>(
          "hostgroup.get",
          { output: ["groupid", "name"], search: { name: group_name }, ...(groupids ? { groupids } : {}) },
          ctx.signal,
        );
        const ids = matched.map((g) => g.groupid).filter((id) => !groupids || groupids.includes(id));
        if (ids.length === 0) throw new ToolError(`no permitted host group matches '${group_name}'`);
        groupids = ids;
      }
      if (groupids?.length === 0) return { count: 0, group_name: group_name ?? null, devices: [] };
      const hosts = await rpc.call<Host[]>(
        "host.get",
        {
          output: ["hostid", "host", "name", "status"],
          selectGroups: ["groupid", "name"],
          selectInterfaces: ["ip", "dns", "type", "available", "error", "main"],
          monitored_hosts: true,
          sortfield: "name",
          ...(groupids ? { groupids } : {}),
        },
        ctx.signal,
      );
      return {
        count: hosts.length,
        group_name: group_name ?? null,
        devices: hosts.map((h) => {
          const interfaces = (h.interfaces ?? []).map((i) => ({
            ip: i.ip,
            dns: i.dns ?? "",
            type: i.type,
            available: availability(i.available),
            error: i.error ?? "",
            main: i.main === "1",
          }));
          const overall = interfaces.some((i) => i.available === "unavailable")
            ? "unavailable"
            : interfaces.some((i) => i.available === "available")
              ? "available"
              : "unknown";
          return {
            host: h.host,
            name: h.name,
            enabled: h.status === "0",
            availability: overall,
            // A host can sit in groups outside the member's scope; show only permitted group names.
            groups: (h.groups ?? []).filter((g) => !groupids || groupids.includes(g.groupid)).map((g) => g.name),
            interfaces,
          };
        }),
      };
    },
  };

  const getMetrics: ToolDefinition<{ host_name: string; item_keys: string[] }> = {
    description:
      "Latest values for exact Zabbix item keys on one host (technical or visible name), " +
      "only if the host is in your permitted host groups.",
    inputSchema: {
      type: "object",
      properties: {
        host_name: { type: "string", minLength: 1, maxLength: 128 },
        item_keys: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 255 } },
      },
      required: ["host_name", "item_keys"],
      additionalProperties: false,
    },
    handler: async ({ host_name, item_keys }, ctx) => {
      const groupids = await permittedGroupIds(rpc, ctx);
      if (groupids?.length === 0) throw new ToolError(`no permitted host matches '${host_name}'`);
      const candidates = await rpc.call<Host[]>(
        "host.get",
        {
          output: ["hostid", "host", "name", "status"],
          search: { host: host_name, name: host_name },
          searchByAny: true,
          limit: 20,
          ...(groupids ? { groupids } : {}),
        },
        ctx.signal,
      );
      const needle = host_name.toLowerCase();
      const host =
        candidates.find((h) => h.host.toLowerCase() === needle || h.name.toLowerCase() === needle) ?? candidates[0];
      if (!host) throw new ToolError(`no permitted host matches '${host_name}'`);
      const items = await rpc.call<
        Array<{ name: string; key_: string; lastvalue?: string; lastclock?: string; units?: string; state?: string; error?: string }>
      >(
        "item.get",
        {
          output: ["name", "key_", "lastvalue", "lastclock", "units", "state", "error"],
          hostids: [host.hostid],
          filter: { key_: item_keys },
          monitored: true,
        },
        ctx.signal,
      );
      const found = new Set(items.map((i) => i.key_));
      return {
        host: { host: host.host, name: host.name, enabled: host.status === "0" },
        metrics: items.map((i) => ({
          name: i.name,
          key: i.key_,
          lastvalue: i.lastvalue ?? null,
          lastclock: iso(i.lastclock),
          units: i.units ?? "",
          unsupported: i.state === "1",
          error: i.error ?? "",
        })),
        missing_item_keys: item_keys.filter((k) => !found.has(k)),
      };
    },
  };

  return {
    get_active_problems: getActiveProblems,
    get_device_status: getDeviceStatus,
    get_metrics: getMetrics,
  };
}
