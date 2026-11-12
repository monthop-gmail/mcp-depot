export type ZktimeMode = "fixture" | "mdb" | "mssql";
export type PunchKind = "in" | "out" | "unknown";

/**
 * Department ids a member may see, resolved once per call from the `departments` scope.
 * `undefined` = unrestricted (scope ["*"]); `[]` = nothing (only unknown names in the scope).
 */
export type DepartmentIds = number[] | undefined;

export interface Department {
  id: number;
  name: string;
  parent_id?: number;
}

/** Deliberately narrow: no fingerprint, face, password, SSN, card number or gender (data minimisation). */
export interface Employee {
  user_id: number;
  badge: string;
  name: string;
  department_id?: number;
  department?: string;
  title?: string;
  hired_on?: string;
}

/** No CommPassword. */
export interface Device {
  id: number;
  alias: string;
  ip?: string;
  port?: number;
  enabled?: boolean;
  serial?: string;
  machine_number?: number;
  product_type?: string;
  firmware?: string;
}

export interface Punch {
  user_id: number;
  badge?: string;
  name?: string;
  check_time: string;
  check_type: PunchKind;
  check_type_raw?: string;
  sensor_id?: string;
  serial?: string;
  work_code?: string;
}

export interface EmployeeQuery {
  /** Case-insensitive substring of badge or name. */
  query?: string;
  limit: number;
}

export interface PunchQuery {
  /** Inclusive dates, YYYY-MM-DD. */
  from: string;
  to: string;
  user_id?: number;
  check_type?: "in" | "out";
  limit: number;
}

export interface Status {
  mode: ZktimeMode;
  sample: boolean;
  tables_missing: string[];
  department_count: number;
  employee_count: number;
  device_count: number;
}

export interface Schema {
  tables: string[];
  columns: Record<string, string[]>;
}

export type Row = Record<string, unknown>;
