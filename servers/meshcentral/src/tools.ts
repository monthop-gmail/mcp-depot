import { ToolError, isUnrestricted, log, type ToolContext, type ToolDefinition } from "@mcp-depot/core";
import type { Device, Group, MeshApi } from "./types.js";

const MESH_ID = /^mesh\/\/\S+$/;
/** One answer for "outside your scope" and "does not exist". */
export const NOT_FOUND = "device group not found";

/**
 * The member's device groups (MeshCentral mesh ids); `undefined` = every group the service account sees (["*"]).
 * Values that are not mesh ids grant nothing.
 */
function permittedGroups(ctx: ToolContext): string[] | undefined {
  const values = ctx.scopes.device_groups ?? [];
  if (isUnrestricted(values)) return undefined;
  const ok = values.filter((v) => MESH_ID.test(v));
  if (ok.length !== values.length) {
    log("warn", "device_groups scope values that are not mesh ids were ignored", { ignored: values.length - ok.length });
  }
  return ok;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);

function toDevice(raw: unknown, groupId: string): Device | null {
  if (!raw || typeof raw !== "object") return null;
  const n = raw as Record<string, unknown>;
  const id = str(n._id);
  if (!id) return null;
  const last = typeof n.lastconnect === "number" && n.lastconnect > 0 ? new Date(n.lastconnect).toISOString() : null;
  return {
    id,
    name: str(n.name) ?? id,
    group_id: groupId,
    os: str(n.osdesc),
    online: typeof n.conn === "number" ? (n.conn & 1) === 1 : n.conn === true,
    last_connect: last,
    ip: str(n.ip),
    cpu: str(n.cpu),
    ram: str(n.ram),
  };
}

/**
 * Devices of the given groups. The scope goes into the request: one `nodes` call per permitted group with its
 * `meshid` (a single unfiltered call only for ["*"]). The reply is filtered again so a node whose group is not
 * permitted is dropped even if the server returned it. A group that answers with an error (e.g. 'Invalid group
 * id') counts as absent; the upstream text is not passed on. Returns the devices and the groups that answered.
 */
async function fetchDevices(api: MeshApi, groups: string[] | undefined): Promise<{ devices: Device[]; answered: Set<string> }> {
  const replies = groups === undefined ? [await api.request("nodes")] : await Promise.all(groups.map((meshid) => api.request("nodes", { meshid })));
  const devices: Device[] = [];
  const answered = new Set<string>();
  for (const reply of replies) {
    const nodes = reply.nodes;
    if (!nodes || typeof nodes !== "object" || Array.isArray(nodes)) continue;
    for (const [meshid, list] of Object.entries(nodes as Record<string, unknown>)) {
      if (groups !== undefined && !groups.includes(meshid)) continue; // second layer
      answered.add(meshid);
      for (const raw of Array.isArray(list) ? list : []) {
        const d = toDevice(raw, meshid);
        if (d) devices.push(d);
      }
    }
  }
  return { devices, answered };
}

/**
 * Device groups the member may see. `meshes` takes no filter, so this is the one place filtered after the reply
 * (the exception to ADR 0002 rule 3); the service account should belong only to the groups the site opens.
 */
async function visibleGroups(api: MeshApi, groups: string[] | undefined): Promise<Array<{ id: string; name: string }>> {
  if (groups?.length === 0) return [];
  const reply = await api.request("meshes");
  const list = Array.isArray(reply.meshes) ? (reply.meshes as Array<Record<string, unknown>>) : [];
  return list
    .map((m) => ({ id: str(m._id) ?? "", name: str(m.name) ?? "" }))
    .filter((m) => MESH_ID.test(m.id) && (groups === undefined || groups.includes(m.id)));
}

export function meshTools(api: MeshApi): Record<string, ToolDefinition<any>> {
  const listGroups: ToolDefinition<Record<string, never>> = {
    description: "MeshCentral device groups you may see, with the number of devices in each.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, ctx) => {
      const scope = permittedGroups(ctx);
      const groups = await visibleGroups(api, scope);
      if (groups.length === 0) return { count: 0, groups: [] };
      const { devices } = await fetchDevices(api, scope === undefined ? undefined : groups.map((g) => g.id));
      const result: Group[] = groups.map((g) => ({ ...g, device_count: devices.filter((d) => d.group_id === g.id).length }));
      return { count: result.length, groups: result };
    },
  };

  const getInventory: ToolDefinition<{ group_id?: string; online_only?: boolean; limit?: number }> = {
    description:
      "Devices in your permitted MeshCentral device groups (cached by MeshCentral, not probed live): name, group, " +
      "OS, online state, last connection, IP, CPU and RAM when known. Optionally one group by id.",
    inputSchema: {
      type: "object",
      properties: {
        group_id: { type: "string", minLength: 1, maxLength: 200, description: "Device group id (mesh//…) from list_groups." },
        online_only: { type: "boolean", description: "Default false." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Default 200." },
      },
      additionalProperties: false,
    },
    handler: async ({ group_id, online_only = false, limit = 200 }, ctx) => {
      const scope = permittedGroups(ctx);
      let target = scope;
      if (group_id !== undefined) {
        if (!MESH_ID.test(group_id) || (scope !== undefined && !scope.includes(group_id))) throw new ToolError(NOT_FOUND);
        target = [group_id];
      }
      if (target?.length === 0) return { count: 0, truncated: false, devices: [] };
      const { devices, answered } = await fetchDevices(api, target);
      if (group_id !== undefined && !answered.has(group_id)) throw new ToolError(NOT_FOUND);
      const matching = devices
        .filter((d) => !online_only || d.online)
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      const out = matching.slice(0, limit);
      return { count: out.length, truncated: matching.length > limit, devices: out };
    },
  };

  return { list_groups: listGroups, get_inventory: getInventory };
}
