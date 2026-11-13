/** The only actions this server ever sends (plus `pong`, answered inside the client). */
export type MeshAction = "meshes" | "nodes";

/** One request/response round trip to MeshCentral's control channel. */
export interface MeshApi {
  request(action: MeshAction, payload?: { meshid?: string }): Promise<Record<string, unknown>>;
}

export interface Group {
  id: string;
  name: string;
  device_count: number;
}

export interface Device {
  id: string;
  name: string;
  group_id: string;
  os: string | null;
  online: boolean;
  last_connect: string | null;
  ip: string | null;
  cpu: string | null;
  ram: string | null;
}
