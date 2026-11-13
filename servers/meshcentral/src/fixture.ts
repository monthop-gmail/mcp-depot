import type { MeshAction, MeshApi } from "./types.js";

/**
 * Synthetic MeshCentral: three invented device groups, addresses from 192.0.2.0/24. It honours `meshid` like
 * the real server (unknown id → 'Invalid group id') and records every request, so tests can prove the scope
 * reaches the upstream request.
 */
export const FIXTURE_GROUPS = [
  { _id: "mesh//fixture-office", name: "Sample office PCs" },
  { _id: "mesh//fixture-lab", name: "Sample lab servers" },
  { _id: "mesh//fixture-kiosk", name: "Sample kiosks" },
];

const node = (id: string, name: string, ip: string, conn: number, osdesc: string, extra: Record<string, unknown> = {}) => ({
  _id: `node//fixture-${id}`,
  name,
  ip,
  conn,
  osdesc,
  lastconnect: Date.UTC(2026, 10, 12, 8, 0, 0),
  ...extra,
});

export const FIXTURE_NODES: Record<string, Array<Record<string, unknown>>> = {
  "mesh//fixture-office": [
    node("pc1", "office-pc-01", "192.0.2.11", 1, "Windows 11 Pro", { cpu: "Sample CPU 4C", ram: "16 GB" }),
    node("pc2", "office-pc-02", "192.0.2.12", 0, "Windows 11 Pro"),
    node("pc3", "office-pc-03", "192.0.2.13", 1, "Windows 10 Pro"),
  ],
  "mesh//fixture-lab": [
    node("srv1", "lab-srv-01", "192.0.2.21", 1, "Ubuntu 24.04 LTS", { cpu: "Sample CPU 16C", ram: "64 GB" }),
    node("srv2", "lab-srv-02", "192.0.2.22", 0, "Debian 12"),
  ],
  "mesh//fixture-kiosk": [
    node("k1", "kiosk-01", "192.0.2.31", 1, "Windows 10 IoT"),
    node("k2", "kiosk-02", "192.0.2.32", 1, "Windows 10 IoT"),
  ],
};

export class FixtureMesh implements MeshApi {
  readonly calls: Array<{ action: MeshAction; meshid?: string }> = [];

  async request(action: MeshAction, payload: { meshid?: string } = {}): Promise<Record<string, unknown>> {
    this.calls.push({ action, ...(payload.meshid !== undefined ? { meshid: payload.meshid } : {}) });
    if (action === "meshes") return { action, meshes: FIXTURE_GROUPS };
    if (payload.meshid === undefined) return { action, nodes: FIXTURE_NODES };
    const list = FIXTURE_NODES[payload.meshid];
    return list ? { action, nodes: { [payload.meshid]: list } } : { action, result: "Invalid group id" };
  }
}
