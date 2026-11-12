import type { ZabbixRpc } from "./rpc.js";

/**
 * Synthetic Zabbix for tests and demos. It implements the filtering semantics the tools rely on
 * (groupids / hostids / filter / search), so scope enforcement is exercised at "query" time,
 * exactly as against the real API. All names are invented.
 */
const groups = [
  { groupid: "10", name: "Servers" },
  { groupid: "20", name: "Switches" },
  { groupid: "30", name: "Cameras" },
];

const hosts = [
  { hostid: "101", host: "srv-app-01", name: "App server 01", status: "0", groupids: ["10"], available: "1" },
  { hostid: "102", host: "srv-db-01", name: "Database 01", status: "0", groupids: ["10", "20"], available: "2" },
  { hostid: "201", host: "sw-core-01", name: "Core switch 01", status: "0", groupids: ["20"], available: "1" },
  { hostid: "301", host: "cam-gate-01", name: "Gate camera 01", status: "0", groupids: ["30"], available: "2" },
];

// 9004 spans two hosts in different groups, so tools must drop the host a member may not see.
const triggers = [
  { triggerid: "9001", hostids: ["102"] },
  { triggerid: "9002", hostids: ["301"] },
  { triggerid: "9003", hostids: ["201"] },
  { triggerid: "9004", hostids: ["101", "201"] },
];

const problems = [
  { eventid: "5004", objectid: "9004", object: "0", name: "Link flapping", severity: "3", clock: "1762923600", acknowledged: "0", tags: [] },
  { eventid: "5003", objectid: "9003", object: "0", name: "High interface utilisation", severity: "2", clock: "1762920000", acknowledged: "1", tags: [] },
  { eventid: "5002", objectid: "9002", object: "0", name: "Camera unreachable", severity: "4", clock: "1762916400", acknowledged: "0", tags: [{ tag: "area", value: "gate" }] },
  { eventid: "5001", objectid: "9001", object: "0", name: "Database agent unavailable", severity: "4", clock: "1762912800", acknowledged: "0", tags: [] },
];

const items = [
  { itemid: "7001", hostid: "101", name: "CPU utilization", key_: "system.cpu.util", lastvalue: "12.5", lastclock: "1762920000", units: "%", state: "0", error: "" },
  { itemid: "7002", hostid: "101", name: "Available memory in %", key_: "vm.memory.size[pavailable]", lastvalue: "61.2", lastclock: "1762920000", units: "%", state: "0", error: "" },
  { itemid: "7003", hostid: "201", name: "CPU utilization", key_: "system.cpu.util", lastvalue: "33.0", lastclock: "1762920000", units: "%", state: "0", error: "" },
];

type Params = Record<string, unknown>;
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String) : undefined);

export class FixtureZabbix implements ZabbixRpc {
  /** Methods called, for tests that assert scopes are pushed into queries. */
  readonly calls: Array<{ method: string; params: Params }> = [];

  async call<T>(method: string, params: Params): Promise<T> {
    this.calls.push({ method, params });
    const groupids = strings(params.groupids);
    const inGroups = (h: (typeof hosts)[number]) => !groupids || h.groupids.some((g) => groupids.includes(g));
    switch (method) {
      case "hostgroup.get": {
        const names = strings((params.filter as Params | undefined)?.name);
        const search = (params.search as Params | undefined)?.name;
        return groups.filter(
          (g) =>
            (!names || names.includes(g.name)) &&
            (typeof search !== "string" || g.name.toLowerCase().includes(search.toLowerCase())),
        ) as T;
      }
      case "host.get": {
        const search = params.search as Params | undefined;
        const needle = typeof search?.host === "string" ? search.host.toLowerCase() : undefined;
        const hostids = strings(params.hostids);
        return hosts
          .filter(inGroups)
          .filter((h) => !hostids || hostids.includes(h.hostid))
          .filter((h) => !needle || h.host.toLowerCase().includes(needle) || h.name.toLowerCase().includes(needle))
          .map((h) => ({
            hostid: h.hostid,
            host: h.host,
            name: h.name,
            status: h.status,
            groups: groups.filter((g) => h.groupids.includes(g.groupid)),
            interfaces: [{ interfaceid: `i${h.hostid}`, ip: "192.0.2.1", dns: "", type: "1", available: h.available, error: "", main: "1" }],
          })) as T;
      }
      case "problem.get": {
        const severities = strings(params.severities)?.map(Number);
        const allowedHosts = new Set(hosts.filter(inGroups).map((h) => h.hostid));
        return problems.filter((p) => {
          const trigger = triggers.find((t) => t.triggerid === p.objectid);
          return (
            trigger &&
            trigger.hostids.some((id) => allowedHosts.has(id)) &&
            (!severities || severities.includes(Number(p.severity)))
          );
        }) as T;
      }
      case "trigger.get": {
        const ids = strings(params.triggerids) ?? [];
        return triggers
          .filter((t) => ids.includes(t.triggerid))
          .map((t) => ({
            triggerid: t.triggerid,
            hosts: t.hostids.map((id) => {
              const h = hosts.find((x) => x.hostid === id)!;
              return { hostid: h.hostid, host: h.host, name: h.name };
            }),
          })) as T;
      }
      case "item.get": {
        const hostids = strings(params.hostids) ?? [];
        const keys = strings((params.filter as Params | undefined)?.key_);
        return items.filter((i) => hostids.includes(i.hostid) && (!keys || keys.includes(i.key_))) as T;
      }
      default:
        throw new Error(`fixture does not implement ${method}`);
    }
  }
}
