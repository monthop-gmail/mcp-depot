import type {
  Department,
  DepartmentIds,
  Device,
  Employee,
  EmployeeQuery,
  Punch,
  PunchKind,
  PunchQuery,
  Row,
  Schema,
  Status,
  ZktimeMode,
} from "./types.js";

/**
 * One ZKTime backend. Every method that returns people or punches takes the member's department ids and
 * applies them in its query (ADR 0002 rule 3); `undefined` = all departments, `[]` = nothing.
 */
export interface ZktimeStore {
  readonly mode: ZktimeMode;
  /** Ids of departments whose name is listed; unknown names are ignored, not errors. */
  departmentIdsByName(names: string[], signal?: AbortSignal): Promise<number[]>;
  status(departmentIds: DepartmentIds, signal?: AbortSignal): Promise<Status>;
  inspect(signal?: AbortSignal): Promise<Schema>;
  listDepartments(departmentIds: DepartmentIds, signal?: AbortSignal): Promise<Department[]>;
  listDevices(signal?: AbortSignal): Promise<Device[]>;
  listEmployees(departmentIds: DepartmentIds, query: EmployeeQuery, signal?: AbortSignal): Promise<Employee[]>;
  listPunches(departmentIds: DepartmentIds, query: PunchQuery, signal?: AbortSignal): Promise<Punch[]>;
}

/** The ZKTime 5 tables this server reads (att2000.mdb and the SQL Server schema use the same names). */
export const TABLES = ["USERINFO", "CHECKINOUT", "DEPARTMENTS", "Machines"] as const;

/** Columns read per table. Anything else — fingerprints, faces, passwords, SSN, card number, gender — is never selected. */
export const COLUMNS: Record<(typeof TABLES)[number], string[]> = {
  USERINFO: ["USERID", "Badgenumber", "Name", "TITLE", "DEFAULTDEPTID", "HIREDDAY"],
  CHECKINOUT: ["USERID", "CHECKTIME", "CHECKTYPE", "SENSORID", "sn", "WorkCode"],
  DEPARTMENTS: ["DEPTID", "DEPTNAME", "SUPDEPTID"],
  Machines: ["ID", "MachineAlias", "IP", "Port", "MachineNumber", "Enabled", "sn", "ProductType", "FirmwareVersion"],
};

/** Case-insensitive table lookup; ZKTime installs differ in case. */
export const findName = (names: readonly string[], wanted: string) =>
  names.find((n) => n.toLowerCase() === wanted.toLowerCase());

export function cell(row: Row, key: string): unknown {
  const k = key.toLowerCase();
  for (const [name, value] of Object.entries(row)) if (name.toLowerCase() === k) return value;
  return undefined;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function asString(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return asDateTime(value);
  return String(value).trim();
}

export function asNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const n = Number(asString(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const raw = asString(value).toLowerCase();
  if (["true", "1", "-1", "yes"].includes(raw)) return true;
  if (["false", "0", "no"].includes(raw)) return false;
  return undefined;
}

/**
 * "YYYY-MM-DD HH:MM:SS" in the terminal's local time, as ZKTime stores it (no zone).
 * The mssql driver returns such values as UTC Dates, so UTC fields give back the stored wall-clock time.
 */
export function asDateTime(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
  }
  const raw = asString(value);
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return "";
  return `${m[1]}-${m[2]}-${m[3]} ${(m[4] ?? "0").padStart(2, "0")}:${m[5] ?? "00"}:${m[6] ?? "00"}`;
}

/** CHECKTYPE is I/O on most installs and 0/1 on some. */
export function punchKind(raw: string): PunchKind {
  const v = raw.toUpperCase();
  if (v === "I" || v === "0" || v === "IN") return "in";
  if (v === "O" || v === "1" || v === "OUT") return "out";
  return "unknown";
}

const opt = <T>(v: T | "" | 0 | undefined): T | undefined => (v === "" || v === 0 || v === undefined ? undefined : v);

export function departmentFromRow(row: Row): Department | null {
  const id = asNumber(cell(row, "DEPTID"));
  if (!id) return null;
  return { id, name: asString(cell(row, "DEPTNAME")) || String(id), parent_id: opt(asNumber(cell(row, "SUPDEPTID"))) };
}

export function employeeFromRow(row: Row, departments: Map<number, string>): Employee | null {
  const userId = asNumber(cell(row, "USERID"));
  if (!userId) return null;
  const badge = asString(cell(row, "Badgenumber")) || String(userId);
  const departmentId = asNumber(cell(row, "DEFAULTDEPTID"));
  return {
    user_id: userId,
    badge,
    name: asString(cell(row, "Name")) || badge,
    department_id: opt(departmentId),
    department: departmentId ? departments.get(departmentId) : undefined,
    title: opt(asString(cell(row, "TITLE"))),
    hired_on: opt(asDateTime(cell(row, "HIREDDAY")).slice(0, 10)),
  };
}

export function deviceFromRow(row: Row): Device | null {
  const id = asNumber(cell(row, "ID"));
  const alias = asString(cell(row, "MachineAlias"));
  if (!id && !alias) return null;
  return {
    id,
    alias: alias || `device-${id}`,
    ip: opt(asString(cell(row, "IP"))),
    port: opt(asNumber(cell(row, "Port"))),
    enabled: asBool(cell(row, "Enabled")),
    serial: opt(asString(cell(row, "sn"))),
    machine_number: opt(asNumber(cell(row, "MachineNumber"))),
    product_type: opt(asString(cell(row, "ProductType"))),
    firmware: opt(asString(cell(row, "FirmwareVersion"))),
  };
}

export function punchFromRow(row: Row, people: Map<number, { badge: string; name: string }>): Punch | null {
  const userId = asNumber(cell(row, "USERID"));
  const checkTime = asDateTime(cell(row, "CHECKTIME"));
  if (!userId || !checkTime) return null;
  const raw = asString(cell(row, "CHECKTYPE"));
  const workCode = asString(cell(row, "WorkCode"));
  const person = people.get(userId);
  return {
    user_id: userId,
    badge: person?.badge ?? opt(asString(cell(row, "Badgenumber"))),
    name: person?.name ?? opt(asString(cell(row, "Name"))),
    check_time: checkTime,
    check_type: punchKind(raw),
    check_type_raw: opt(raw),
    sensor_id: opt(asString(cell(row, "SENSORID"))),
    serial: opt(asString(cell(row, "sn"))),
    work_code: workCode && workCode !== "0" ? workCode : undefined,
  };
}

/** Same rule every backend uses for `query`: case-insensitive substring of badge or name. */
export const matchesQuery = (query: string | undefined, e: { badge?: string; name?: string }) =>
  !query || [e.badge, e.name].some((f) => (f ?? "").toLowerCase().includes(query.toLowerCase()));

/** Inclusive date window on "YYYY-MM-DD HH:MM:SS" strings. */
export const inDateRange = (checkTime: string, from: string, to: string) => {
  const day = checkTime.slice(0, 10);
  return day >= from && day <= to;
};

export const inDepartments = (departmentIds: DepartmentIds, id: number | undefined) =>
  !departmentIds || (id !== undefined && departmentIds.includes(id));
